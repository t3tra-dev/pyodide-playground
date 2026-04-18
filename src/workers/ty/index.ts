import initTyWasm, {
  LogLevel,
  PositionEncoding,
  Workspace,
  initLogging,
} from "../../../.generated/ty-wasm/ty_wasm.js";
import { PYTHON_JS_STUB_PATH, PYTHON_MAIN_FILE_PATH } from "../../pythonWorkspace";
import type { ControlMessage, WorkerHoverProfileSnapshot } from "../../ty/protocol";
import { TyWorkspaceWrapper } from "./workspaceWrapper";

type HoverProfile = {
  durationMs: number;
  line: number | null;
  path: string | null;
  startedAt: number;
};

type TyEnvironmentState = {
  extraPaths: Set<string>;
  pythonVersion: string;
};

let loggingInitialized = false;
let lastAppliedTyOptionsPayload: string | null = null;
let tyBooted = false;
let workspaceWrapper: TyWorkspaceWrapper | null = null;
let environmentState: TyEnvironmentState = {
  extraPaths: new Set(),
  pythonVersion: "",
};
const recentHoverProfiles: HoverProfile[] = [];

function resolveTyLogLevel() {
  const configuredLevel = String(import.meta.env.VITE_TY_WASM_LOG_LEVEL ?? "")
    .trim()
    .toLowerCase();
  switch (configuredLevel) {
    case "trace":
      return LogLevel.Trace;
    case "debug":
      return LogLevel.Debug;
    case "info":
      return LogLevel.Info;
    case "warn":
    case "warning":
      return LogLevel.Warn;
    case "error":
      return LogLevel.Error;
  }

  return import.meta.env.DEV ? LogLevel.Warn : LogLevel.Error;
}

function makeTypingOverloadTyCompatible(sourceText: string) {
  let removedOverloadImport = false;
  const rewrittenLines = sourceText.split("\n").map((line) => {
    const match = /^(\s*)from typing import (.+)$/u.exec(line);
    if (!match) {
      return line;
    }

    const indentation = match[1] ?? "";
    const importedNames = (match[2] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (!importedNames.includes("overload")) {
      return line;
    }

    removedOverloadImport = true;
    const remainingNames = importedNames.filter((name) => name !== "overload");
    if (remainingNames.length === 0) {
      return "";
    }

    return `${indentation}from typing import ${remainingNames.join(", ")}`;
  });

  if (!removedOverloadImport) {
    return sourceText;
  }

  const rewrittenSource = rewrittenLines.join("\n");
  const aliasImport = "import typing as _ty_typing_overload_compat";
  const aliasBinding = "overload = _ty_typing_overload_compat.overload";

  if (
    /^\s*import typing as _ty_typing_overload_compat\b/mu.test(rewrittenSource) &&
    /^\s*overload = _ty_typing_overload_compat\.overload\b/mu.test(rewrittenSource)
  ) {
    return rewrittenSource;
  }

  const lines = rewrittenSource.split("\n");
  let insertionIndex = 0;
  while (
    insertionIndex < lines.length &&
    (/^\s*#.*$/u.test(lines[insertionIndex] ?? "") || /^\s*$/u.test(lines[insertionIndex] ?? ""))
  ) {
    insertionIndex += 1;
  }
  lines.splice(insertionIndex, 0, aliasImport, aliasBinding);
  return lines.join("\n");
}

function pushHoverProfile(profile: HoverProfile) {
  recentHoverProfiles.push(profile);
  if (recentHoverProfiles.length > 50) {
    recentHoverProfiles.splice(0, recentHoverProfiles.length - 50);
  }
}

function buildHoverProfileSnapshot(): WorkerHoverProfileSnapshot {
  return {
    active: [],
    recent: recentHoverProfiles.map((profile) => ({ ...profile })),
  };
}

function normalizePythonVersion(version: string) {
  const match = String(version).match(/(\d+\.\d+)/);
  return match?.[1] ?? "3.13";
}

function normalizeSearchPath(path: string) {
  const trimmed = String(path).trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed === "/") {
    return "/";
  }

  return trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
}

function createTyOptions() {
  const extraPaths = Array.from(environmentState.extraPaths)
    .map(normalizeSearchPath)
    .filter(Boolean);

  return {
    environment: {
      "extra-paths": extraPaths,
      "python-version": normalizePythonVersion(environmentState.pythonVersion),
    },
  };
}

function ensureWrapper() {
  if (!workspaceWrapper) {
    throw new Error("ty worker is not ready");
  }

  return workspaceWrapper;
}

function applyEnvironment(extraPaths: string[], pythonVersion: string) {
  environmentState.extraPaths = new Set(extraPaths.filter(Boolean));
  environmentState.pythonVersion = pythonVersion;
  const nextOptions = createTyOptions();
  const nextOptionsPayload = JSON.stringify(nextOptions);
  if (nextOptionsPayload === lastAppliedTyOptionsPayload) {
    return;
  }

  ensureWrapper().updateOptions(nextOptions);
  lastAppliedTyOptionsPayload = nextOptionsPayload;
}

async function bootWorker(message: Extract<ControlMessage, { type: "boot" }>) {
  if (!tyBooted) {
    await initTyWasm();
    if (!loggingInitialized) {
      initLogging(resolveTyLogLevel());
      loggingInitialized = true;
    }
    tyBooted = true;
  }

  environmentState = {
    extraPaths: new Set(message.extraPaths.filter(Boolean)),
    pythonVersion: message.pythonVersion,
  };

  const initialOptions = createTyOptions();
  lastAppliedTyOptionsPayload = JSON.stringify(initialOptions);
  const workspace = new Workspace("/", PositionEncoding.Utf16, initialOptions);
  workspaceWrapper = new TyWorkspaceWrapper(workspace);
  workspaceWrapper.clear();
  workspaceWrapper.syncFiles([
    {
      content: `${makeTypingOverloadTyCompatible(message.pythonJsStubContent.trim())}\n`,
      path: PYTHON_JS_STUB_PATH,
    },
    ...message.files,
  ]);

  return {
    diagnostics: workspaceWrapper.collectMainDiagnostics(),
  };
}

self.addEventListener("message", async (event: MessageEvent<ControlMessage>) => {
  const message = event.data;
  const id = message?.id;

  try {
    switch (message.type) {
      case "boot": {
        const payload = await bootWorker(message);
        self.postMessage({ id, payload, type: "response" });
        return;
      }

      case "sync-file": {
        const wrapper = ensureWrapper();
        wrapper.syncFile(message.path, message.content);
        self.postMessage({
          id,
          payload: {
            diagnostics:
              message.path === PYTHON_MAIN_FILE_PATH ? wrapper.collectMainDiagnostics() : [],
          },
          type: "response",
        });
        return;
      }

      case "sync-files": {
        const wrapper = ensureWrapper();
        wrapper.syncFiles(message.files);
        self.postMessage({
          id,
          payload: {
            diagnostics: wrapper.collectMainDiagnostics(),
          },
          type: "response",
        });
        return;
      }

      case "sync-environment": {
        applyEnvironment(message.extraPaths, message.pythonVersion);
        self.postMessage({
          id,
          payload: {
            diagnostics: ensureWrapper().collectMainDiagnostics(),
          },
          type: "response",
        });
        return;
      }

      case "hover": {
        const startedAt = performance.now();
        const uri = String(message.params?.textDocument?.uri ?? "");
        const payload = ensureWrapper().hover(uri, message.params?.position);
        pushHoverProfile({
          durationMs: performance.now() - startedAt,
          line: message.params?.position?.line ?? null,
          path: uri || null,
          startedAt,
        });
        self.postMessage({ id, payload, type: "response" });
        return;
      }

      case "definition": {
        const uri = String(message.params?.textDocument?.uri ?? "");
        const payload = ensureWrapper().definition(uri, message.params?.position);
        self.postMessage({ id, payload, type: "response" });
        return;
      }

      case "completion": {
        const uri = String(message.params?.textDocument?.uri ?? "");
        const payload = ensureWrapper().completion(uri, message.params?.position);
        self.postMessage({ id, payload, type: "response" });
        return;
      }

      case "signature-help": {
        const uri = String(message.params?.textDocument?.uri ?? "");
        const payload = ensureWrapper().signatureHelp(uri, message.params?.position);
        self.postMessage({ id, payload, type: "response" });
        return;
      }

      case "get-hover-profiles": {
        self.postMessage({
          id,
          payload: buildHoverProfileSnapshot(),
          type: "response",
        });
        return;
      }
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      id,
      type: "response",
    });
  }
});
