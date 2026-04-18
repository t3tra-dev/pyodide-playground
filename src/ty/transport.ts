import type { Transport } from "@codemirror/lsp-client";
import {
  PYTHON_MAIN_FILE_PATH,
  PYTHON_MAIN_FILE_URI,
  type PythonEnvironmentFile,
  type PythonEnvironmentSnapshot,
} from "../pythonWorkspace";
import { fetchVendoredPythonJsStub } from "../vendoredPythonJsStub";
import {
  type TransportHoverProfile,
  type TransportLspEvent,
  type WorkerHoverProfileSnapshot,
  type WorkerRequest,
  type WorkerResponse,
  type WorkspaceSettings,
} from "./protocol";
import { normalizeLspOutgoingMessage } from "./lspUtils";

type PendingRequest = {
  reject: (reason?: unknown) => void;
  resolve: (value: WorkerResponse | PromiseLike<WorkerResponse>) => void;
};

let nextRequestId = 1;

function getNextRequestId() {
  return nextRequestId++;
}

function getVendoredPythonStubsBaseUrl() {
  return new URL("vendor/python-stubs/", document.baseURI).toString();
}

function createServerCapabilities() {
  return {
    completionProvider: {
      resolveProvider: false,
      triggerCharacters: [".", "'", '"', "/", "["],
    },
    definitionProvider: true,
    hoverProvider: true,
    positionEncoding: "utf-16",
    signatureHelpProvider: {
      triggerCharacters: ["(", ","],
    },
    textDocumentSync: 1,
  };
}

export class TyWorkerTransport implements Transport {
  private browserJsStubPromise: Promise<{ pythonJsStubContent: string }> | null = null;
  private bootPromise: Promise<void> | null = null;
  private ignoredResponseIds = new Set<number | string>();
  private pendingRequests = new Map<number, PendingRequest>();
  private recentLspEvents: TransportLspEvent[] = [];
  private recentTransportHoverProfiles: TransportHoverProfile[] = [];
  private queuedMessages: string[] = [];
  private subscribers = new Set<(value: string) => void>();
  private worker: Worker | null = null;
  private workspaceSettings: WorkspaceSettings = {
    environment: {
      "extra-paths": [],
      "python-version": "3.13",
    },
  };

  private bootEnvironment: PythonEnvironmentSnapshot = {
    extraPaths: [],
    files: [],
    packages: [],
    pythonVersion: "",
  };

  private loadBrowserJsStub() {
    if (!this.browserJsStubPromise) {
      this.browserJsStubPromise = fetchVendoredPythonJsStub(getVendoredPythonStubsBaseUrl()).catch(
        (error) => {
          this.browserJsStubPromise = null;
          throw error;
        },
      );
    }

    return this.browserJsStubPromise;
  }

  private ensureWorker() {
    if (!this.worker) {
      this.worker = new Worker(new URL("../workers/ty/index.ts", import.meta.url), {
        type: "module",
      });
      this.worker.addEventListener("message", this.handleWorkerMessage);
      this.worker.addEventListener("error", this.handleWorkerFailure);
      this.worker.addEventListener("messageerror", this.handleWorkerFailure);
    }

    return this.worker;
  }

  private handleWorkerMessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, error, type } = event.data ?? {};
    if (type !== "response" || id === undefined) {
      return;
    }

    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(id);
    if (error) {
      pending.reject(new Error(String(error)));
      return;
    }

    pending.resolve(event.data);
  };

  private handleWorkerFailure = (event: ErrorEvent | MessageEvent<unknown>) => {
    const message =
      event instanceof ErrorEvent
        ? event.message || "ty worker failed"
        : "ty worker message deserialization failed";

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(message));
    }

    this.pendingRequests.clear();
    this.bootPromise = null;
  };

  private request(message: WorkerRequest) {
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pendingRequests.set(message.id, { resolve, reject });
      this.ensureWorker().postMessage(message);
    });
  }

  private emitMessage(payload: unknown) {
    const serializedPayload = JSON.stringify(payload);
    if (this.subscribers.size === 0) {
      this.queuedMessages.push(serializedPayload);
      if (this.queuedMessages.length > 256) {
        this.queuedMessages.splice(0, this.queuedMessages.length - 256);
      }
      return;
    }

    for (const subscriber of this.subscribers) {
      subscriber(serializedPayload);
    }
  }

  private emitResponse(id: number | string, result: unknown) {
    if (this.ignoredResponseIds.has(id)) {
      this.ignoredResponseIds.delete(id);
      return;
    }

    this.emitMessage({
      id,
      jsonrpc: "2.0",
      result,
    });
  }

  private emitError(id: number | string, error: unknown) {
    if (this.ignoredResponseIds.has(id)) {
      this.ignoredResponseIds.delete(id);
      return;
    }

    this.emitMessage({
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
      id,
      jsonrpc: "2.0",
    });
  }

  private publishDiagnostics(diagnostics: unknown[], version?: number | null) {
    this.pushLspEvent({
      diagnosticCount: diagnostics.length,
      direction: "incoming",
      id: null,
      method: "textDocument/publishDiagnostics",
      timestamp: performance.now(),
      uri: PYTHON_MAIN_FILE_URI,
    });
    this.emitMessage({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        diagnostics,
        uri: PYTHON_MAIN_FILE_URI,
        version: typeof version === "number" ? version : undefined,
      },
    });
  }

  private pushTransportHoverProfile(profile: TransportHoverProfile) {
    this.recentTransportHoverProfiles.push({
      ...profile,
      interleavedMethodCounts: { ...profile.interleavedMethodCounts },
    });
    if (this.recentTransportHoverProfiles.length > 50) {
      this.recentTransportHoverProfiles.splice(0, this.recentTransportHoverProfiles.length - 50);
    }
  }

  private pushLspEvent(event: TransportLspEvent) {
    this.recentLspEvents.push({ ...event });
    if (this.recentLspEvents.length > 200) {
      this.recentLspEvents.splice(0, this.recentLspEvents.length - 200);
    }
  }

  private createHoverProfile(
    id: number | string,
    params: {
      position?: { character?: number; line?: number };
      textDocument?: { uri?: string };
    },
  ): TransportHoverProfile {
    return {
      absoluteResponseReceivedAt: null,
      absoluteSentAt: performance.timeOrigin + performance.now(),
      character: params.position?.character ?? null,
      id,
      interleavedMessageCount: 0,
      interleavedMethodCounts: {},
      line: params.position?.line ?? null,
      responseReceivedAt: null,
      roundTripMs: null,
      sentAt: performance.now(),
      uri: params.textDocument?.uri ?? null,
    };
  }

  private finalizeHoverProfile(profile: TransportHoverProfile) {
    const endedAt = performance.now();
    profile.absoluteResponseReceivedAt = performance.timeOrigin + endedAt;
    profile.responseReceivedAt = endedAt;
    profile.roundTripMs = endedAt - profile.sentAt;
    this.pushTransportHoverProfile(profile);
  }

  setBootEnvironment(snapshot: PythonEnvironmentSnapshot) {
    this.bootEnvironment = {
      extraPaths: Array.from(new Set(snapshot.extraPaths.filter(Boolean))).sort(),
      files: snapshot.files,
      packages: snapshot.packages,
      pythonVersion: String(snapshot.pythonVersion ?? ""),
    };
  }

  async start(initialContent: string) {
    if (!this.bootPromise) {
      this.bootPromise = (async () => {
        const browserJsStub = await this.loadBrowserJsStub();
        const response = await this.request({
          extraPaths: this.bootEnvironment.extraPaths,
          files: [
            {
              content: initialContent,
              path: PYTHON_MAIN_FILE_PATH,
            },
            ...this.bootEnvironment.files,
          ],
          id: getNextRequestId(),
          pythonJsStubContent: browserJsStub.pythonJsStubContent,
          pythonVersion: this.bootEnvironment.pythonVersion,
          type: "boot",
        });

        const diagnostics = Array.isArray(
          (response.payload as { diagnostics?: unknown[] })?.diagnostics,
        )
          ? (((response.payload as { diagnostics?: unknown[] }).diagnostics ?? []) as unknown[])
          : [];
        this.publishDiagnostics(diagnostics);
      })().catch((error) => {
        this.bootPromise = null;
        throw error;
      });
    }

    return this.bootPromise;
  }

  async syncFile(path: string, content: string, version?: number | null) {
    await this.start(content);
    const response = await this.request({
      content,
      id: getNextRequestId(),
      path,
      type: "sync-file",
    });
    const diagnostics = Array.isArray(
      (response.payload as { diagnostics?: unknown[] })?.diagnostics,
    )
      ? (((response.payload as { diagnostics?: unknown[] }).diagnostics ?? []) as unknown[])
      : [];
    if (path === PYTHON_MAIN_FILE_PATH) {
      this.publishDiagnostics(diagnostics, version);
    }
  }

  async syncFiles(files: PythonEnvironmentFile[], version?: number | null) {
    if (files.length === 0) {
      return;
    }

    await this.start("");
    const response = await this.request({
      files,
      id: getNextRequestId(),
      type: "sync-files",
    });
    const diagnostics = Array.isArray(
      (response.payload as { diagnostics?: unknown[] })?.diagnostics,
    )
      ? (((response.payload as { diagnostics?: unknown[] }).diagnostics ?? []) as unknown[])
      : [];
    if (files.some((file) => file.path === PYTHON_MAIN_FILE_PATH)) {
      this.publishDiagnostics(diagnostics, version);
    }
  }

  async syncEnvironment(snapshot: PythonEnvironmentSnapshot, version?: number | null) {
    await this.start("");
    const response = await this.request({
      extraPaths: snapshot.extraPaths,
      id: getNextRequestId(),
      pythonVersion: snapshot.pythonVersion,
      type: "sync-environment",
    });
    const diagnostics = Array.isArray(
      (response.payload as { diagnostics?: unknown[] })?.diagnostics,
    )
      ? (((response.payload as { diagnostics?: unknown[] }).diagnostics ?? []) as unknown[])
      : [];
    this.publishDiagnostics(diagnostics, version);
  }

  async getHoverProfiles() {
    const response = await this.request({
      id: getNextRequestId(),
      type: "get-hover-profiles",
    });

    return {
      transportRecent: this.recentTransportHoverProfiles.map((profile) => ({
        ...profile,
        interleavedMethodCounts: { ...profile.interleavedMethodCounts },
      })),
      worker: (response.payload ?? { active: [], recent: [] }) as WorkerHoverProfileSnapshot,
    };
  }

  getRecentLspEvents() {
    return this.recentLspEvents.map((event) => ({ ...event }));
  }

  async requestHover(
    params: {
      position?: { character?: number; line?: number };
      textDocument?: { uri?: string };
    },
    _options?: { deferMainDocumentSyncMs?: number },
  ) {
    await this.start("");
    const requestId = getNextRequestId();
    const profile = this.createHoverProfile(requestId, params);
    this.pushLspEvent({
      diagnosticCount: null,
      direction: "outgoing",
      id: requestId,
      method: "textDocument/hover",
      timestamp: performance.now(),
      uri: params.textDocument?.uri ?? null,
    });

    const response = await this.request({
      id: requestId,
      params,
      type: "hover",
    });
    this.finalizeHoverProfile(profile);
    this.pushLspEvent({
      diagnosticCount: null,
      direction: "incoming",
      id: requestId,
      method: null,
      timestamp: performance.now(),
      uri: params.textDocument?.uri ?? null,
    });
    return response.payload ?? null;
  }

  async requestDefinition(params: {
    position?: { character?: number; line?: number };
    textDocument?: { uri?: string };
  }) {
    await this.start("");
    const requestId = getNextRequestId();
    this.pushLspEvent({
      diagnosticCount: null,
      direction: "outgoing",
      id: requestId,
      method: "textDocument/definition",
      timestamp: performance.now(),
      uri: params.textDocument?.uri ?? null,
    });

    const response = await this.request({
      id: requestId,
      params,
      type: "definition",
    });
    this.pushLspEvent({
      diagnosticCount: null,
      direction: "incoming",
      id: requestId,
      method: null,
      timestamp: performance.now(),
      uri: params.textDocument?.uri ?? null,
    });
    return response.payload ?? null;
  }

  setWorkspaceSettings(settings: WorkspaceSettings) {
    this.workspaceSettings = settings;
  }

  private ignoreResponseId(id: number | string) {
    this.ignoredResponseIds.add(id);
    if (this.ignoredResponseIds.size > 512) {
      const oldestId = this.ignoredResponseIds.values().next().value;
      if (oldestId !== undefined) {
        this.ignoredResponseIds.delete(oldestId);
      }
    }
  }

  send(message: string) {
    const normalizedMessage = normalizeLspOutgoingMessage(message);
    if (!normalizedMessage || typeof normalizedMessage !== "object") {
      return;
    }

    const id = "id" in normalizedMessage ? (normalizedMessage as { id: number | string }).id : null;
    const method =
      "method" in normalizedMessage &&
      typeof (normalizedMessage as { method?: unknown }).method === "string"
        ? String((normalizedMessage as { method: string }).method)
        : null;
    const uri =
      "params" in normalizedMessage &&
      typeof (normalizedMessage as { params?: { textDocument?: { uri?: unknown } } }).params
        ?.textDocument?.uri === "string"
        ? String(
            (normalizedMessage as { params: { textDocument: { uri: string } } }).params.textDocument
              .uri,
          )
        : null;

    this.pushLspEvent({
      diagnosticCount: null,
      direction: "outgoing",
      id,
      method,
      timestamp: performance.now(),
      uri,
    });

    if (method === "$/cancelRequest") {
      const cancelledId = (normalizedMessage as { params?: { id?: number | string } }).params?.id;
      if (cancelledId !== undefined) {
        this.ignoreResponseId(cancelledId);
      }
      return;
    }

    if (method === "initialize" && id !== null) {
      void this.start("").then(
        () => {
          this.emitResponse(id, {
            capabilities: createServerCapabilities(),
            serverInfo: {
              name: "ty_wasm",
            },
          });
        },
        (error) => {
          this.emitError(id, error);
        },
      );
      return;
    }

    if ((method === "shutdown" || method === "workspace/configuration") && id !== null) {
      this.emitResponse(id, method === "workspace/configuration" ? [this.workspaceSettings] : null);
      return;
    }

    if (
      method === "initialized" ||
      method === "exit" ||
      method === "textDocument/didOpen" ||
      method === "textDocument/didChange" ||
      method === "textDocument/didClose" ||
      method === "workspace/didChangeConfiguration"
    ) {
      return;
    }

    if (method === "textDocument/hover" && id !== null) {
      const params = (normalizedMessage as { params?: any }).params ?? {};
      void this.requestHover(params).then(
        (result) => {
          this.emitResponse(id, result);
        },
        (error) => {
          this.emitError(id, error);
        },
      );
      return;
    }

    if (method === "textDocument/definition" && id !== null) {
      const params = (normalizedMessage as { params?: any }).params ?? {};
      void this.requestDefinition(params).then(
        (result) => {
          this.emitResponse(id, result);
        },
        (error) => {
          this.emitError(id, error);
        },
      );
      return;
    }

    if (method === "textDocument/completion" && id !== null) {
      const params = (normalizedMessage as { params?: any }).params ?? {};
      void this.start("")
        .then(() =>
          this.request({
            id: getNextRequestId(),
            params,
            type: "completion",
          }),
        )
        .then(
          (response) => {
            this.emitResponse(id, response.payload ?? null);
          },
          (error) => {
            this.emitError(id, error);
          },
        );
      return;
    }

    if (method === "textDocument/signatureHelp" && id !== null) {
      const params = (normalizedMessage as { params?: any }).params ?? {};
      void this.start("")
        .then(() =>
          this.request({
            id: getNextRequestId(),
            params,
            type: "signature-help",
          }),
        )
        .then(
          (response) => {
            this.emitResponse(id, response.payload ?? null);
          },
          (error) => {
            this.emitError(id, error);
          },
        );
      return;
    }

    if (id !== null) {
      this.emitResponse(id, null);
    }
  }

  subscribe(handler: (value: string) => void) {
    this.subscribers.add(handler);
    if (this.queuedMessages.length > 0) {
      const queuedMessages = [...this.queuedMessages];
      this.queuedMessages.length = 0;
      for (const queuedMessage of queuedMessages) {
        handler(queuedMessage);
      }
    }
  }

  unsubscribe(handler: (value: string) => void) {
    this.subscribers.delete(handler);
  }

  dispose() {
    if (this.worker) {
      this.worker.removeEventListener("message", this.handleWorkerMessage);
      this.worker.removeEventListener("error", this.handleWorkerFailure);
      this.worker.removeEventListener("messageerror", this.handleWorkerFailure);
      this.worker.terminate();
      this.worker = null;
    }

    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error("ty worker was disposed"));
    }

    this.pendingRequests.clear();
    this.queuedMessages.length = 0;
    this.subscribers.clear();
    this.ignoredResponseIds.clear();
    this.bootPromise = null;
  }
}
