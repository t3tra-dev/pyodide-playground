import type { PyodideInterface } from "pyodide";
import {
  createStdinBufferViews,
  type BridgeResponse,
  type InvokeWorkerHandleRequest,
} from "../../jsBridgeProtocol";
import { PYODIDE_VERSION } from "../../pyodideVersion";
import { normalizeResultForPostMessage, WorkerJsBridge } from "./bridge";
import {
  createTyEnvironmentSnapshotScript,
  enrichTySnapshot,
  type PythonEnvironmentSnapshotPayload,
} from "./snapshot";
import { createSdlScreenCanvas, ensureExperimentalSdlGlobals } from "./sdl";

type LogType = "stdout" | "stderr";

let bridge: WorkerJsBridge | null = null;
let pyodide: PyodideInterface | null = null;
let pyodideReadyPromise: Promise<PyodideInterface> | null = null;
let loadPyodideFactoryPromise: Promise<(typeof import("pyodide"))["loadPyodide"]> | null = null;
let loadedPackages = new Set<string>();
let indexURL = "";
let packageBaseUrl = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
let vendorStubsBaseUrl = "";
let stdinViews: ReturnType<typeof createStdinBufferViews> | null = null;
let nextStdinRequestId = 1;

type WorkerTrace = {
  id: string;
  startedAtMs: number;
};

function getRuntimeLoadedPackages(instance: PyodideInterface) {
  return Object.keys((instance as any).loadedPackages ?? {}).sort();
}

function refreshLoadedPackages(instance: PyodideInterface) {
  const runtimeLoadedPackages = getRuntimeLoadedPackages(instance);
  const nextLoadedPackages = new Set(runtimeLoadedPackages);
  const newLoadedPackages = runtimeLoadedPackages.filter(
    (packageName) => !loadedPackages.has(packageName),
  );

  loadedPackages = nextLoadedPackages;
  return {
    loadedPackages: runtimeLoadedPackages,
    newLoadedPackages,
  };
}

function emitLog(type: LogType, data: string) {
  self.postMessage({ type, data });
}

function emitPackageLog(type: "info" | "error", data: string) {
  self.postMessage({ type: "package-log", logType: type, data });
}

function emitPackageState(packageState: { loadedPackages: string[]; newLoadedPackages: string[] }) {
  self.postMessage({
    type: "packagesLoaded",
    loadedPackages: packageState.loadedPackages,
    newLoadedPackages: packageState.newLoadedPackages,
  });
}

function parseTrace(trace: unknown): WorkerTrace | null {
  if (!trace || typeof trace !== "object") {
    return null;
  }

  const candidate = trace as { id?: unknown; startedAtMs?: unknown };
  if (typeof candidate.id !== "string" || typeof candidate.startedAtMs !== "number") {
    return null;
  }

  return {
    id: candidate.id,
    startedAtMs: candidate.startedAtMs,
  };
}

function emitTraceLog(trace: WorkerTrace | null, label: string, detail?: unknown) {
  if (!trace) {
    return;
  }

  self.postMessage({
    type: "trace-log",
    traceId: trace.id,
    elapsedMs: Date.now() - trace.startedAtMs,
    label,
    ...(detail === undefined ? {} : { detail }),
  });
}

const PACKAGE_LOAD_LOG_OPTIONS = {
  errorCallback: (message: string) => {
    emitPackageLog("error", message);
  },
  messageCallback: (message: string) => {
    emitPackageLog("info", message);
  },
};
const PYODIDE_RUN_FILE_HELPER_SCRIPT = `
from pathlib import Path
from pyodide.code import eval_code_async

async def __codex_run_file(path, namespace):
    source = Path(path).read_text(encoding="utf-8")
    return await eval_code_async(
        source,
        globals=namespace,
        locals=namespace,
        filename=path,
    )
`;
const PYTHON_AST_HELPER_SCRIPT = `
import ast
import json

def __codex_ast_to_json(node):
    if isinstance(node, ast.AST):
        result = {"_type": type(node).__name__}
        for field in getattr(node, "_fields", ()):
            result[field] = __codex_ast_to_json(getattr(node, field))
        for attr in ("lineno", "col_offset", "end_lineno", "end_col_offset", "type_comment"):
            if hasattr(node, attr):
                value = getattr(node, attr)
                if value is not None:
                    result[attr] = __codex_ast_to_json(value)
        return result
    if isinstance(node, (list, tuple)):
        return [__codex_ast_to_json(item) for item in node]
    if isinstance(node, (str, int, float, bool)) or node is None:
        return node
    return repr(node)

def __codex_parse_python_ast(source, filename="<unknown>", mode="exec"):
    tree = ast.parse(source, filename=filename, mode=mode)
    return json.dumps(__codex_ast_to_json(tree))
`;
const MATPLOTLIB_PREPARE_SCRIPT = `
import base64
import json
from pathlib import Path
import matplotlib
from matplotlib.backends import backend_webagg
from matplotlib.backends import backend_webagg_core

if not getattr(backend_webagg, "_pyodide_bridge_patched", False):
    def _bridge_open(self, fignum):
        self.on_message_proxy = self.on_message
        self.js_web_socket.open(self.on_message_proxy)
        self.fignum = int(fignum)
        self.manager.add_web_socket(self)

    def _bridge_on_close(self):
        self.manager.remove_web_socket(self)
        self.on_message_proxy = None

    def _bridge_send_binary(self, blob):
        data_uri = "data:image/png;base64," + base64.b64encode(blob).decode("ascii")
        self.js_web_socket.receive_binary(data_uri, binary=self.supports_binary)

    backend_webagg.WebAggApplication.MockPythonWebSocket.open = _bridge_open
    backend_webagg.WebAggApplication.MockPythonWebSocket.on_close = _bridge_on_close
    backend_webagg.WebAggApplication.MockPythonWebSocket.send_binary = _bridge_send_binary
    backend_webagg._pyodide_bridge_patched = True

images_dir = Path(matplotlib.get_data_path()) / "images"
toolbar_icons = {}
for _name, _tooltip, image, _method_name in backend_webagg_core.FigureManagerWebAgg.ToolbarCls.toolitems:
    if not image or image in toolbar_icons:
        continue

    image_path = images_dir / f"{image}.png"
    if not image_path.exists():
        continue

    toolbar_icons[image] = (
        "data:image/png;base64,"
        + base64.b64encode(image_path.read_bytes()).decode("ascii")
    )

json.dumps({"toolbarIcons": toolbar_icons})
`;

function createMicropipInstallScript(packageSpecs: string[]) {
  return `
import importlib.metadata
import json
import micropip

TARGET_PACKAGES = ${JSON.stringify(packageSpecs)}

def collect_distributions():
    distributions = {}
    for distribution in importlib.metadata.distributions():
        try:
            name = (distribution.metadata.get("Name") or "").strip()
        except Exception:
            name = ""
        if not name or name.lower() == "micropip":
            continue
        distributions[name] = distribution.version
    return distributions

before = collect_distributions()
await micropip.install(TARGET_PACKAGES)
after = collect_distributions()

installed_packages = [
    {"distributionName": name, "version": after[name]}
    for name in sorted(after, key=str.lower)
]
newly_installed_packages = sorted(
    [name for name, version in after.items() if before.get(name) != version],
    key=str.lower,
)

json.dumps(
    {
        "installedPackages": installed_packages,
        "newlyInstalledPackages": newly_installed_packages,
    }
)
`;
}

class StreamTextWriter {
  public readonly isatty = true;
  private readonly decoder = new TextDecoder();

  constructor(private readonly type: LogType) {}

  public write(buffer: Uint8Array) {
    const chunk = this.decoder.decode(buffer, { stream: true });
    if (chunk.length > 0) {
      emitLog(this.type, chunk);
    }
    return buffer.length;
  }

  public fsync() {
    const chunk = this.decoder.decode();
    if (chunk.length > 0) {
      emitLog(this.type, chunk);
    }
  }
}

function ensureBridge() {
  if (!bridge) {
    throw new Error("Worker bridge is not initialized");
  }

  return bridge;
}

function requestStdinLine() {
  if (!stdinViews) {
    return null;
  }

  const requestId = nextStdinRequestId++;
  Atomics.store(stdinViews.header, 1, 0);
  Atomics.store(stdinViews.header, 0, 1);
  self.postMessage({ requestId, type: "stdin-request" });

  while (Atomics.load(stdinViews.header, 0) === 1) {
    Atomics.wait(stdinViews.header, 0, 1);
  }

  const length = Atomics.load(stdinViews.header, 1);
  Atomics.store(stdinViews.header, 0, 0);
  Atomics.store(stdinViews.header, 1, 0);

  if (length < 0) {
    return null;
  }

  const bytes = new Uint8Array(length);
  bytes.set(stdinViews.payload.subarray(0, length));
  return new TextDecoder().decode(bytes);
}

async function getLoadPyodide() {
  if (!loadPyodideFactoryPromise) {
    const runtimeBaseUrl = indexURL || new URL("/pyodide/", self.location.origin).toString();
    const runtimeModuleUrl = new URL("pyodide.mjs", runtimeBaseUrl).toString();

    loadPyodideFactoryPromise = import(/* @vite-ignore */ runtimeModuleUrl).then(
      (module) => module.loadPyodide,
    );
  }

  return loadPyodideFactoryPromise;
}

async function initializePyodide() {
  if (pyodide) {
    return pyodide;
  }

  if (!pyodideReadyPromise) {
    self.postMessage({ type: "status", status: "loading" });
    ensureExperimentalSdlGlobals(ensureBridge());

    const loadPyodide = await getLoadPyodide();
    pyodideReadyPromise = loadPyodide({
      indexURL,
      packageBaseUrl,
      fullStdLib: false,
      jsglobals: ensureBridge().createJSGlobals(),
      stdout: (message: string) => emitLog("stdout", message),
      stderr: (message: string) => emitLog("stderr", message),
    })
      .then(async (instance) => {
        instance.setStdin({
          autoEOF: true,
          isatty: true,
          stdin: requestStdinLine,
        });
        instance.setStdout(new StreamTextWriter("stdout"));
        instance.setStderr(new StreamTextWriter("stderr"));
        await instance.runPythonAsync(`
import builtins
import sys

if not getattr(builtins, "__codex_input_patched__", False):
    _codex_original_input = builtins.input

    def _codex_input(prompt=""):
        if prompt:
            sys.stdout.write(str(prompt))
            sys.stdout.flush()
        return _codex_original_input()

    builtins.__codex_original_input__ = _codex_original_input
    builtins.input = _codex_input
    builtins.__codex_input_patched__ = True
`);
        await instance.runPythonAsync(PYODIDE_RUN_FILE_HELPER_SCRIPT);
        await instance.runPythonAsync(PYTHON_AST_HELPER_SCRIPT);

        pyodide = instance;
        self.postMessage({ type: "status", status: "ready" });
        return instance;
      })
      .catch((error: unknown) => {
        pyodideReadyPromise = null;
        self.postMessage({
          type: "status",
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
  }

  return pyodideReadyPromise;
}

function ensureDirectory(instance: PyodideInterface, directoryPath: string) {
  const fs = (instance as any).FS;
  if (!fs || directoryPath === "/" || directoryPath === "") {
    return;
  }

  if (typeof fs.mkdirTree === "function") {
    fs.mkdirTree(directoryPath);
    return;
  }

  const segments = directoryPath.split("/").filter(Boolean);
  let currentPath = "";

  for (const segment of segments) {
    currentPath += `/${segment}`;

    try {
      fs.mkdir(currentPath);
    } catch {
      // Ignore EEXIST-style failures.
    }
  }
}

function syncVirtualFile(instance: PyodideInterface, filePath: string, content: string) {
  const normalizedPath = String(filePath || "/").startsWith("/")
    ? String(filePath || "/")
    : `/${String(filePath || "")}`;
  const directoryPath = normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) || "/";

  ensureDirectory(instance, directoryPath);
  (instance as any).FS.writeFile(normalizedPath, content, {
    encoding: "utf8",
  });
}

self.addEventListener("message", async (event) => {
  const message = event.data;

  if (message?.type === "bridge-async-response") {
    ensureBridge().resolveAsyncRequest(message.requestId, message.response);
    return;
  }

  const { id, cmd } = message ?? {};

  try {
    if (cmd === "init") {
      bridge = new WorkerJsBridge(message.syncBuffer);
      stdinViews = createStdinBufferViews(message.stdinBuffer);
      indexURL = message.indexURL;
      packageBaseUrl = String(message.packageBaseUrl ?? packageBaseUrl);
      vendorStubsBaseUrl = String(message.vendorStubsBaseUrl ?? "");
      await initializePyodide();
      self.postMessage({ id, type: "initialized" });
      return;
    }

    if (cmd === "invokeWorkerHandle") {
      const response = await ensureBridge().invokeLocalHandle(
        message.request as InvokeWorkerHandleRequest,
      );
      self.postMessage({ id, type: "workerHandleInvoked", response });
      return;
    }

    if (cmd === "releaseWorkerHandle") {
      ensureBridge().releaseLocalHandle(Number(message.handleId));
      self.postMessage({ id, type: "workerHandleReleased" });
      return;
    }

    const instance = await initializePyodide();

    if (cmd === "syncFile") {
      syncVirtualFile(instance, String(message.path ?? ""), String(message.content ?? ""));
      self.postMessage({ id, type: "fileSynced" });
      return;
    }

    if (cmd === "enableExperimentalSdlSupport") {
      ensureExperimentalSdlGlobals(ensureBridge());
      const jsGlobals = ensureBridge().createJSGlobals() as {
        document?: {
          pyodideSdlTarget?: HTMLCanvasElement | null;
        };
      };
      const targetCanvas = jsGlobals.document?.pyodideSdlTarget;

      if (!targetCanvas) {
        throw new Error("SDL canvas target is not available");
      }

      (instance as any)._api._skip_unwind_fatal_error = true;
      (instance as any).canvas.setCanvas2D(createSdlScreenCanvas(targetCanvas as any));
      self.postMessage({ id, type: "sdlSupportEnabled" });
      return;
    }

    if (cmd === "loadPackages") {
      const packages: string[] = Array.isArray(message.packages)
        ? message.packages
            .map((pkg: unknown) => String(pkg).trim())
            .filter((pkg: string) => pkg.length > 0)
        : [];

      if (packages.length === 0) {
        self.postMessage({
          id,
          type: "packagesLoaded",
          installedPackages: [],
          loadedPackages: Array.from(loadedPackages).sort(),
          newLoadedPackages: [],
          newlyInstalledPackages: [],
        });
        return;
      }

      await instance.loadPackage(["micropip"], PACKAGE_LOAD_LOG_OPTIONS);
      let packageState = refreshLoadedPackages(instance);
      if (packageState.newLoadedPackages.length > 0) {
        emitPackageState(packageState);
      }
      const installResultJson = await instance.runPythonAsync(
        createMicropipInstallScript(packages),
      );
      const installResult =
        typeof installResultJson === "string" && installResultJson.trim().length > 0
          ? JSON.parse(String(installResultJson))
          : {};
      packageState = refreshLoadedPackages(instance);

      self.postMessage({
        id,
        type: "packagesLoaded",
        ...(installResult && typeof installResult === "object" ? installResult : {}),
        loadedPackages: packageState.loadedPackages,
        newLoadedPackages: packageState.newLoadedPackages,
      });
      return;
    }

    if (cmd === "runPython") {
      const python = String(message.python ?? "");
      const trace = parseTrace(message.trace);
      emitTraceLog(trace, "runPython:start");
      const packageState = refreshLoadedPackages(instance);
      if (packageState.newLoadedPackages.length > 0) {
        emitPackageState(packageState);
        emitTraceLog(trace, "runPython:packages-ready", {
          newlyLoadedPackages: packageState.newLoadedPackages,
        });
      }
      const useGlobalScope = message.useGlobalScope === true;
      const dictFactory = useGlobalScope ? null : instance.globals.get("dict");
      const globals = useGlobalScope
        ? instance.globals
        : dictFactory(Object.entries(message.context ?? {}));

      try {
        const result = await instance.runPythonAsync(python, { globals });
        emitTraceLog(trace, "runPython:python-finished");
        self.postMessage({
          id,
          loadedPackages: packageState.loadedPackages,
          newLoadedPackages: packageState.newLoadedPackages,
          result: normalizeResultForPostMessage(result),
        });
      } finally {
        if (!useGlobalScope) {
          globals?.destroy?.();
          dictFactory?.destroy?.();
        }
      }

      return;
    }

    if (cmd === "prepareMatplotlibRuntime") {
      const trace = parseTrace(message.trace);
      emitTraceLog(trace, "prepareMatplotlibRuntime:start");
      const matplotlibPreparationJson = await instance.runPythonAsync(MATPLOTLIB_PREPARE_SCRIPT);
      const matplotlibPreparation =
        typeof matplotlibPreparationJson === "string" && matplotlibPreparationJson.trim().length > 0
          ? JSON.parse(String(matplotlibPreparationJson))
          : {};
      emitTraceLog(trace, "prepareMatplotlibRuntime:bridge-patched");
      self.postMessage({
        id,
        ...(matplotlibPreparation &&
        typeof matplotlibPreparation === "object" &&
        "toolbarIcons" in matplotlibPreparation
          ? { toolbarIcons: (matplotlibPreparation as { toolbarIcons?: unknown }).toolbarIcons }
          : {}),
        type: "matplotlibPrepared",
      });
      return;
    }

    if (cmd === "parsePythonAst") {
      const parsePythonAst = instance.globals.get("__codex_parse_python_ast");
      try {
        const astJson = parsePythonAst(
          String(message.source ?? ""),
          String(message.filename ?? "<unknown>"),
          String(message.mode ?? "exec"),
        );
        self.postMessage({
          id,
          ast:
            typeof astJson === "string" && astJson.trim().length > 0
              ? JSON.parse(String(astJson))
              : null,
          type: "pythonAstParsed",
        });
      } finally {
        parsePythonAst?.destroy?.();
      }
      return;
    }

    if (cmd === "runPythonFile") {
      const python = String(message.python ?? "");
      const filePath = String(message.path ?? "");
      const trace = parseTrace(message.trace);
      emitTraceLog(trace, "runPythonFile:start");
      syncVirtualFile(instance, filePath, python);
      emitTraceLog(trace, "runPythonFile:file-synced");
      const packageState = refreshLoadedPackages(instance);
      if (packageState.newLoadedPackages.length > 0) {
        emitPackageState(packageState);
        emitTraceLog(trace, "runPythonFile:packages-ready", {
          newlyLoadedPackages: packageState.newLoadedPackages,
        });
      }

      const dictFactory = instance.globals.get("dict");
      const globals = dictFactory(Object.entries(message.context ?? {}));
      const runFile = instance.globals.get("__codex_run_file");

      try {
        const result = await runFile(filePath, globals);
        emitTraceLog(trace, "runPythonFile:python-finished");
        self.postMessage({
          id,
          loadedPackages: packageState.loadedPackages,
          newLoadedPackages: packageState.newLoadedPackages,
          result: normalizeResultForPostMessage(result),
        });
      } finally {
        runFile?.destroy?.();
        globals?.destroy?.();
        dictFactory?.destroy?.();
      }

      return;
    }

    if (cmd === "collectTyEnvironment" || cmd === "collectTyEnvironment") {
      const packages = Array.isArray(message.packages)
        ? message.packages.map((packageName: unknown) => String(packageName))
        : [];
      const snapshotJson = await instance.runPythonAsync(
        createTyEnvironmentSnapshotScript(packages),
      );
      const snapshot = await enrichTySnapshot(
        JSON.parse(String(snapshotJson)) as PythonEnvironmentSnapshotPayload,
        vendorStubsBaseUrl,
      );
      self.postMessage({
        id,
        snapshot,
        type: "tyEnvironment",
      });
      return;
    }
  } catch (error) {
    const normalizedError = error instanceof Error ? error.message : String(error);
    const response: {
      error?: string;
      id?: number;
      response?: BridgeResponse;
    } = { id, error: normalizedError };

    if (cmd === "invokeWorkerHandle") {
      response.response = {
        ok: false,
        error: {
          message: normalizedError,
        },
      } satisfies BridgeResponse;
      delete response.error;
    }

    self.postMessage(response);
  }
});
