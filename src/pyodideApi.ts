import { MainThreadJsBridge } from "./mainThreadJsBridge";
import { installMatplotlibCompat, setMatplotlibToolbarIcons } from "./matplotlibCompat";
import { PYODIDE_VERSION } from "./pyodideVersion";
import { PYTHON_MAIN_FILE_PATH, type PythonEnvironmentSnapshot } from "./pythonWorkspace";
import {
  type BridgeResponse,
  createStdinBufferViews,
  type InvokeWorkerHandleRequest,
  STDIN_BUFFER_TOTAL_BYTES,
  SYNC_BUFFER_TOTAL_BYTES,
} from "./jsBridgeProtocol";

type LogType = "stdout" | "stderr";
type StatusType = "loading" | "ready" | "error";

type PendingRequest = {
  resolve: (value: any) => void;
};

export type InstalledPythonPackage = {
  distributionName: string;
  version: string;
};

export type PythonAstScalar = boolean | null | number | string;
export type PythonAstValue = PythonAstNode | PythonAstScalar | PythonAstValue[];
export type PythonAstNode = {
  _type: string;
  [key: string]: PythonAstValue;
};

export type PyodideExecutionTrace = {
  id: string;
  startedAtMs: number;
};

let pyodideReady = false;
let loadedPackages = new Set<string>();
let logCallback: (message: string, type: LogType) => void = () => {};
let statusCallback: (status: StatusType) => void = () => {};
let pyodideWorker: Worker | null = null;
let bridge: MainThreadJsBridge | null = null;
let workerInitPromise: Promise<void> | null = null;
let matplotlibBridgePatched = false;
let matplotlibPreparationPromise: Promise<void> | null = null;
let nextId = 1;
const pendingRequests = new Map<number, PendingRequest>();
let stdinRequestCallback: () => Promise<string | null> = async () => "";
let stdinViews: ReturnType<typeof createStdinBufferViews> | null = null;
const stdinTextEncoder = new TextEncoder();
const pyodidePackageBaseUrl =
  import.meta.env.VITE_PYODIDE_PACKAGE_BASE_URL ||
  `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const MATPLOTLIB_RESET_SCRIPT = `
try:
    import matplotlib.pyplot as plt
    from matplotlib._pylab_helpers import Gcf

    plt.close("all")
    Gcf.destroy_all()
except Exception:
    pass
`;
const SDL_RESET_SCRIPT = `
try:
    import pygame
    pygame.quit()
except Exception:
    pass
`;

function getPyodideCoreBaseUrl() {
  return new URL("pyodide/", document.baseURI).toString();
}

function getVendoredPythonStubsBaseUrl() {
  return new URL("vendor/python-stubs/", document.baseURI).toString();
}

function getId() {
  return nextId++;
}

function getStdinViews() {
  stdinViews ??= createStdinBufferViews(new SharedArrayBuffer(STDIN_BUFFER_TOTAL_BYTES));
  return stdinViews;
}

function emitStatus(status: StatusType) {
  pyodideReady = status === "ready";
  statusCallback(status);
}

function formatTracePrefix(trace: PyodideExecutionTrace) {
  return `[matplotlib-trace #${trace.id} +${Math.max(0, Date.now() - trace.startedAtMs)}ms]`;
}

function logTrace(
  trace: PyodideExecutionTrace | null | undefined,
  label: string,
  detail?: unknown,
) {
  if (!trace) {
    return;
  }

  if (detail === undefined) {
    console.info(`${formatTracePrefix(trace)} ${label}`);
    return;
  }

  console.info(`${formatTracePrefix(trace)} ${label}`, detail);
}

function drawSdlFrame(bitmap: ImageBitmap | null | undefined, width: unknown, height: unknown) {
  if (!bitmap) {
    return;
  }

  const pyodideDocument = document as Document & {
    pyodideSdlTarget?: HTMLCanvasElement | null;
  };
  const target = pyodideDocument.pyodideSdlTarget;
  if (!(target instanceof HTMLCanvasElement)) {
    bitmap.close();
    return;
  }

  const nextWidth =
    typeof width === "number" && Number.isFinite(width)
      ? Math.max(0, Math.trunc(width))
      : bitmap.width;
  const nextHeight =
    typeof height === "number" && Number.isFinite(height)
      ? Math.max(0, Math.trunc(height))
      : bitmap.height;

  if (target.width !== nextWidth) {
    target.width = nextWidth;
  }
  if (target.height !== nextHeight) {
    target.height = nextHeight;
  }

  const context = target.getContext("2d");
  if (!context) {
    bitmap.close();
    return;
  }

  context.clearRect(0, 0, target.width, target.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
}

function ensureBridge() {
  if (!bridge) {
    bridge = new MainThreadJsBridge(
      new SharedArrayBuffer(SYNC_BUFFER_TOTAL_BYTES),
      (request: InvokeWorkerHandleRequest) =>
        requestResponse({
          cmd: "invokeWorkerHandle",
          request,
        }).then((response) => response?.response as BridgeResponse),
      (handleId: number) =>
        pyodideWorker
          ? requestResponse({
              cmd: "releaseWorkerHandle",
              handleId,
            }).then(() => undefined)
          : Promise.resolve(),
    );
  }

  return bridge;
}

function handleWorkerMessage(event: MessageEvent) {
  const message = event.data ?? {};
  const commitLoadedPackages = (logPackages: boolean) => {
    const allLoadedPackages = Array.isArray(message.loadedPackages)
      ? message.loadedPackages.map(String)
      : null;
    const newlyLoadedPackages = Array.isArray(message.newLoadedPackages)
      ? message.newLoadedPackages.map(String)
      : null;

    if (!allLoadedPackages) {
      return;
    }

    const previousLoadedPackages = loadedPackages;
    loadedPackages = new Set<string>(allLoadedPackages);

    if (!logPackages) {
      return;
    }

    const packagesToLog =
      newlyLoadedPackages ??
      allLoadedPackages.filter((pkg: string) => !previousLoadedPackages.has(pkg));
    if (packagesToLog.length > 0) {
      console.info(`Packages loaded: ${packagesToLog.join(", ")}`);
    }
  };

  switch (message.type) {
    case "stdout":
      logCallback(message.data, "stdout");
      return;
    case "stderr":
      logCallback(message.data, "stderr");
      return;
    case "package-log":
      if (message.logType === "error") {
        console.error(message.data);
      } else {
        console.info(message.data);
      }
      return;
    case "trace-log":
      if (typeof message.label === "string" && typeof message.traceId === "string") {
        const elapsedMs =
          typeof message.elapsedMs === "number" && Number.isFinite(message.elapsedMs)
            ? Math.max(0, Math.round(message.elapsedMs))
            : null;
        const prefix =
          elapsedMs === null
            ? `[matplotlib-trace #${message.traceId}]`
            : `[matplotlib-trace #${message.traceId} +${elapsedMs}ms]`;
        if (message.detail === undefined) {
          console.info(`${prefix} ${message.label}`);
        } else {
          console.info(`${prefix} ${message.label}`, message.detail);
        }
      }
      return;
    case "status":
      emitStatus(message.status);
      if (message.status === "ready") {
        console.info("Pyodide worker is ready with the main-thread JS bridge.");
      } else if (message.status === "error") {
        console.error(`Pyodide initialization error: ${message.error ?? "Unknown error"}`);
      }
      return;
    case "packagesLoaded":
      commitLoadedPackages(true);
      break;
    case "sdl-frame":
      drawSdlFrame(message.bitmap, message.width, message.height);
      return;
    case "stdin-request":
      void stdinRequestCallback()
        .then((value) => {
          const normalized = value ?? null;
          const encoded =
            normalized === null ? new Uint8Array() : stdinTextEncoder.encode(normalized);
          const stdinViews = getStdinViews();
          const length = Math.min(encoded.byteLength, stdinViews.payload.byteLength);
          stdinViews.payload.fill(0);
          stdinViews.payload.set(encoded.subarray(0, length));
          Atomics.store(stdinViews.header, 1, normalized === null ? -1 : length);
          Atomics.store(stdinViews.header, 0, 2);
          Atomics.notify(stdinViews.header, 0, 1);
        })
        .catch((error) => {
          const stdinViews = getStdinViews();
          console.error("Failed to resolve stdin request", error);
          Atomics.store(stdinViews.header, 1, -1);
          Atomics.store(stdinViews.header, 0, 2);
          Atomics.notify(stdinViews.header, 0, 1);
        });
      return;
    case "bridge-sync-request":
      ensureBridge().respondToSyncRequest(message.operation);
      return;
    case "bridge-async-request":
      void ensureBridge()
        .respondToAsyncRequest(message.request)
        .then((response) => {
          pyodideWorker?.postMessage({
            type: "bridge-async-response",
            requestId: message.requestId,
            response,
          });
        });
      return;
  }

  commitLoadedPackages(false);

  if (message.id !== undefined) {
    const pendingRequest = pendingRequests.get(message.id);
    if (!pendingRequest) {
      return;
    }

    pendingRequests.delete(message.id);
    pendingRequest.resolve(message);
  }
}

function ensureWorker() {
  if (!pyodideWorker) {
    pyodideWorker = new Worker(new URL("./workers/pyodide/index.ts", import.meta.url), {
      type: "module",
    });
    pyodideWorker.addEventListener("message", handleWorkerMessage);
  }

  return pyodideWorker;
}

function requestResponse(message: Record<string, unknown>) {
  return new Promise<any>((resolve) => {
    const id = getId();
    pendingRequests.set(id, { resolve });
    ensureWorker().postMessage({ id, ...message });
  });
}

function ensureSharedArrayBufferSupport() {
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error("SharedArrayBuffer is not available in this browser");
  }

  if (!window.crossOriginIsolated) {
    throw new Error(
      "crossOriginIsolated is required for the worker DOM bridge. Configure COOP/COEP headers.",
    );
  }
}

export function setLogCallback(callback: (message: string, type: LogType) => void) {
  logCallback = callback;
}

export function setStdinRequestCallback(callback: () => Promise<string | null>) {
  stdinRequestCallback = callback;
}

export function setStatusCallback(callback: (status: StatusType) => void) {
  statusCallback = callback;
}

export async function initializePyodide() {
  if (pyodideReady) {
    return;
  }

  if (!workerInitPromise) {
    try {
      installMatplotlibCompat();
      ensureSharedArrayBufferSupport();
      const syncBridge = ensureBridge();
      const stdinViews = getStdinViews();

      workerInitPromise = requestResponse({
        cmd: "init",
        indexURL: getPyodideCoreBaseUrl(),
        packageBaseUrl: pyodidePackageBaseUrl,
        vendorStubsBaseUrl: getVendoredPythonStubsBaseUrl(),
        stdinBuffer: stdinViews.header.buffer,
        syncBuffer: syncBridge.getSyncBuffer(),
      })
        .then((response) => {
          if (response?.error) {
            throw new Error(String(response.error));
          }
        })
        .catch((error) => {
          workerInitPromise = null;
          emitStatus("error");
          throw error;
        });
    } catch (error) {
      emitStatus("error");
      throw error;
    }
  }

  return workerInitPromise;
}

export async function asyncRun(script: string, context: Record<string, unknown> = {}) {
  try {
    await initializePyodide();
    const response = await requestResponse({
      cmd: "runPython",
      python: script,
      context,
    });

    if (response?.error) {
      return { error: String(response.error) };
    }

    return {
      loadedPackages: Array.isArray(response?.loadedPackages)
        ? response.loadedPackages.map(String)
        : [],
      newlyLoadedPackages: Array.isArray(response?.newLoadedPackages)
        ? response.newLoadedPackages.map(String)
        : [],
      result: response?.result,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncVirtualFile(path: string, content: string) {
  await initializePyodide();
  const response = await requestResponse({
    cmd: "syncFile",
    content,
    path,
  });

  if (response?.error) {
    throw new Error(String(response.error));
  }
}

export async function asyncRunMainFile(
  content: string,
  context: Record<string, unknown> = {},
  options: { trace?: PyodideExecutionTrace } = {},
) {
  try {
    logTrace(options.trace, "asyncRunMainFile:request");
    const response = await requestResponse({
      cmd: "runPythonFile",
      context,
      path: PYTHON_MAIN_FILE_PATH,
      python: content,
      trace: options.trace ?? null,
    });

    if (response?.error) {
      return { error: String(response.error) };
    }

    logTrace(options.trace, "asyncRunMainFile:response", {
      newlyLoadedPackages: Array.isArray(response?.newLoadedPackages)
        ? response.newLoadedPackages.map(String)
        : [],
    });

    return {
      loadedPackages: Array.isArray(response?.loadedPackages)
        ? response.loadedPackages.map(String)
        : [],
      newlyLoadedPackages: Array.isArray(response?.newLoadedPackages)
        ? response.newLoadedPackages.map(String)
        : [],
      result: response?.result,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function ensureMatplotlibBridgePatched(
  options: {
    force?: boolean;
    trace?: PyodideExecutionTrace;
  } = {},
) {
  await initializePyodide();
  if (options.force) {
    matplotlibBridgePatched = false;
  }
  if (matplotlibBridgePatched) {
    return;
  }

  if (!matplotlibPreparationPromise) {
    logTrace(options.trace, "prepareMatplotlibRuntime:request");
    matplotlibPreparationPromise = requestResponse({
      cmd: "prepareMatplotlibRuntime",
      trace: options.trace ?? null,
    })
      .then((response) => {
        if (response?.error) {
          throw new Error(String(response.error));
        }

        matplotlibBridgePatched = true;
        if (response?.toolbarIcons && typeof response.toolbarIcons === "object") {
          setMatplotlibToolbarIcons(response.toolbarIcons as Record<string, string>);
        }
      })
      .finally(() => {
        matplotlibPreparationPromise = null;
      });
  }

  await matplotlibPreparationPromise;
  logTrace(options.trace, "prepareMatplotlibRuntime:response");
}

export async function resetMatplotlibFigures() {
  await initializePyodide();
  const response = await requestResponse({
    cmd: "runPython",
    python: MATPLOTLIB_RESET_SCRIPT,
    context: {},
    skipPackageLoad: true,
  });

  if (response?.error) {
    throw new Error(String(response.error));
  }
}

export async function enableExperimentalSdlSupport() {
  await initializePyodide();
  const response = await requestResponse({
    cmd: "enableExperimentalSdlSupport",
  });

  if (response?.error) {
    throw new Error(String(response.error));
  }
}

export async function resetSdlState() {
  await initializePyodide();
  const response = await requestResponse({
    cmd: "runPython",
    python: SDL_RESET_SCRIPT,
    context: {},
    skipPackageLoad: true,
  });

  if (response?.error) {
    throw new Error(String(response.error));
  }
}

export async function loadPackages(packages: string[]) {
  try {
    await initializePyodide();
    const packageSpecs = packages.map((pkg) => String(pkg).trim()).filter(Boolean);

    if (packageSpecs.length === 0) {
      return {
        installedPackages: [] as InstalledPythonPackage[],
        loadedPackages: Array.from(loadedPackages),
        newlyInstalledPackages: [] as string[],
        newlyLoadedPackages: [] as string[],
      };
    }

    const response = await requestResponse({
      cmd: "loadPackages",
      packages: packageSpecs,
    });

    if (response?.error) {
      return { error: String(response.error) };
    }

    return {
      installedPackages: Array.isArray(response?.installedPackages)
        ? response.installedPackages
            .filter((pkg: unknown) => typeof pkg === "object" && pkg !== null)
            .map((pkg: any) => ({
              distributionName: String(pkg.distributionName ?? ""),
              version: String(pkg.version ?? ""),
            }))
            .filter(
              (pkg: InstalledPythonPackage) =>
                pkg.distributionName.length > 0 && pkg.version.length > 0,
            )
        : [],
      loadedPackages: Array.isArray(response?.loadedPackages)
        ? response.loadedPackages
        : Array.from(loadedPackages),
      newlyInstalledPackages: Array.isArray(response?.newlyInstalledPackages)
        ? response.newlyInstalledPackages.map(String)
        : [],
      newlyLoadedPackages: Array.isArray(response?.newLoadedPackages)
        ? response.newLoadedPackages.map(String)
        : [],
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function collectTyEnvironment(packages: string[]): Promise<PythonEnvironmentSnapshot> {
  await initializePyodide();
  const response = await requestResponse({
    cmd: "collectTyEnvironment",
    packages,
  });

  if (response?.error) {
    throw new Error(String(response.error));
  }

  const snapshot = response?.snapshot ?? {};
  return {
    extraPaths: Array.isArray(snapshot.extraPaths) ? snapshot.extraPaths.map(String) : [],
    files: Array.isArray(snapshot.files)
      ? snapshot.files
          .filter((file: unknown) => typeof file === "object" && file !== null)
          .map((file: any) => ({
            content: String(file.content ?? ""),
            path: String(file.path ?? ""),
          }))
      : [],
    packages: Array.isArray(snapshot.packages)
      ? snapshot.packages
          .filter((pkg: unknown) => typeof pkg === "object" && pkg !== null)
          .map((pkg: any) => ({
            distributionName: String(pkg.distributionName ?? ""),
            importRoots: Array.isArray(pkg.importRoots)
              ? pkg.importRoots
                  .filter((root: unknown) => typeof root === "object" && root !== null)
                  .map((root: any) => ({
                    hasLocalStub: Boolean(root.hasLocalStub),
                    importName: String(root.importName ?? ""),
                    isPackage: Boolean(root.isPackage),
                    path: String(root.path ?? ""),
                    sitePath: String(root.sitePath ?? ""),
                  }))
                  .filter((root: any) => root.importName && root.sitePath)
              : [],
            version: String(pkg.version ?? ""),
          }))
          .filter((pkg: any) => pkg.distributionName && pkg.version)
      : [],
    pythonVersion: typeof snapshot.pythonVersion === "string" ? snapshot.pythonVersion : "",
  };
}

export async function parsePythonAst(
  source: string,
  options: {
    filename?: string;
    mode?: "eval" | "exec" | "single";
  } = {},
): Promise<PythonAstNode | null> {
  await initializePyodide();
  const response = await requestResponse({
    cmd: "parsePythonAst",
    filename: options.filename ?? PYTHON_MAIN_FILE_PATH,
    mode: options.mode ?? "exec",
    source,
  });

  if (response?.error) {
    throw new Error(String(response.error));
  }

  const ast = response?.ast;
  if (!ast || typeof ast !== "object") {
    return null;
  }

  return ast as PythonAstNode;
}

export function isPyodideReady() {
  return pyodideReady;
}
