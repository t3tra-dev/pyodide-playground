import { Compartment, type Extension } from "@codemirror/state";
import {
  findReferencesKeymap,
  formatKeymap,
  hoverTooltips,
  jumpToDefinitionKeymap,
  LSPClient,
  LSPPlugin,
  renameKeymap,
  serverCompletion,
  serverDiagnostics,
  signatureHelp,
} from "@codemirror/lsp-client";
import { setDiagnostics } from "@codemirror/lint";
import { hasHoverTooltips, keymap } from "@codemirror/view";
import {
  PYTHON_MAIN_FILE_PATH,
  PYTHON_MAIN_FILE_URI,
  type PythonEnvironmentSnapshot,
} from "./pythonWorkspace";
import {
  HOVER_ACTIVE_LSP_SYNC_DEFER_MS,
  HOVER_EMPTY_RESULT_RETRY_DELAY_MS,
  HOVER_EMPTY_RESULT_RETRY_LIMIT,
  HOVER_EMPTY_RESULT_RETRY_WINDOW_MS,
  HOVER_PREFETCH_DELAY_MS,
  LSP_SYNC_DEBOUNCE_MS,
  MAX_STABLE_HOVER_CACHE_ENTRIES,
  buildHoverRequestCandidateParams,
  collectHoverPrefetchOffsets,
  createCachedHoverResult,
  formatHoverResult,
  getIdentifierAtOffset,
  getStableHoverCacheKeyAtOffset,
  isIncompleteImportedHoverText,
  normalizeHoverResultRange,
  normalizeLspRequestError,
  shouldSuppressPassiveLspError,
  shouldSuppressHoverError,
} from "./ty/hoverUtils";
import { lspPositionToOffset, offsetToLspPosition } from "./ty/lspUtils";
import { type FrontendHoverProfile, type WorkspaceSettings } from "./ty/protocol";
import { TyWorkerTransport } from "./ty/transport";

const DEFAULT_HOVER_TOOLTIP_DELAY_MS = 300;
const IMMEDIATE_HOVER_TOOLTIP_DELAY_MS = 0;
const PASSIVE_LSP_REQUEST_METHODS = new Set([
  "textDocument/completion",
  "textDocument/signatureHelp",
]);

function createManualServerDiagnosticsExtension() {
  const diagnosticsExtension = serverDiagnostics();

  return {
    clientCapabilities: diagnosticsExtension.clientCapabilities,
    notificationHandlers: {
      ...diagnosticsExtension.notificationHandlers,
      "textDocument/publishDiagnostics": (client: any, params: any) => {
        const file = client.workspace.getFile(params.uri);
        if (!file || (params.version != null && params.version !== file.version)) {
          return false;
        }

        const view = file.getView();
        const plugin = view && LSPPlugin.get(view);
        if (!view || !plugin) {
          return false;
        }

        const safeDiagnostics = [];
        for (const item of params.diagnostics ?? []) {
          try {
            const from = plugin.unsyncedChanges.mapPos(
              plugin.fromPosition(item.range.start, plugin.syncedDoc),
            );
            const to = plugin.unsyncedChanges.mapPos(
              plugin.fromPosition(item.range.end, plugin.syncedDoc),
            );
            safeDiagnostics.push({
              from,
              message: item.message,
              severity: (item.severity === 1
                ? "error"
                : item.severity === 2
                  ? "warning"
                  : item.severity === 3
                    ? "info"
                    : "hint") as "error" | "warning" | "info" | "hint",
              to,
            });
          } catch (error) {
            if (!(error instanceof RangeError)) {
              throw error;
            }
          }
        }

        view.dispatch(setDiagnostics(view.state, safeDiagnostics));
        return true;
      },
    },
  };
}

function getDirectoryPath(path: string) {
  const lastSlashIndex = path.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return "/";
  }

  return path.slice(0, lastSlashIndex);
}

function normalizePosixPath(path: string) {
  const normalized = String(path).replace(/\\/gu, "/").trim();
  if (!normalized) {
    return "";
  }

  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function rewriteTySnapshotFilePath(snapshot: PythonEnvironmentSnapshot, filePath: string) {
  const normalizedFilePath = normalizePosixPath(filePath);
  if (!normalizedFilePath || normalizedFilePath === PYTHON_MAIN_FILE_PATH) {
    return normalizedFilePath;
  }

  const importRoots = snapshot.packages
    .flatMap((packageEntry) => packageEntry.importRoots)
    .map((importRoot) => ({
      ...importRoot,
      normalizedPath: normalizePosixPath(importRoot.path),
      normalizedSitePath: normalizePosixPath(importRoot.sitePath),
    }))
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length);

  for (const importRoot of importRoots) {
    if (!importRoot.importName || !importRoot.normalizedSitePath) {
      continue;
    }

    if (
      normalizedFilePath !== importRoot.normalizedPath &&
      !normalizedFilePath.startsWith(`${importRoot.normalizedSitePath}/`)
    ) {
      continue;
    }

    const relativePath = normalizedFilePath.startsWith(`${importRoot.normalizedSitePath}/`)
      ? normalizedFilePath.slice(importRoot.normalizedSitePath.length + 1)
      : normalizedFilePath.slice(1);

    if (!relativePath) {
      continue;
    }

    if (importRoot.isPackage) {
      if (
        relativePath === importRoot.importName ||
        relativePath.startsWith(`${importRoot.importName}/`)
      ) {
        return `/${relativePath}`;
      }
      continue;
    }

    const expectedPrefix = `${importRoot.importName}.`;
    if (relativePath === importRoot.importName || relativePath.startsWith(expectedPrefix)) {
      return `/${relativePath}`;
    }
  }

  return normalizedFilePath;
}

function createTyEnvironmentSnapshot(
  snapshot: PythonEnvironmentSnapshot,
): PythonEnvironmentSnapshot {
  return {
    ...snapshot,
    extraPaths: snapshot.files.length > 0 ? ["/"] : [],
    files: snapshot.files.map((file) => ({
      ...file,
      path: rewriteTySnapshotFilePath(snapshot, file.path),
    })),
  };
}

export class TyLanguageService {
  readonly client: LSPClient;
  readonly extension: Extension;

  private readonly immediateClientSync: () => void;
  private readonly transport = new TyWorkerTransport();
  private readonly hoverTooltipCompartment = new Compartment();
  private readonly hoverPrefetchDelayMs: number;
  private connected = false;
  private documentContent = "";
  private documentRevision = 0;
  private readonly extraPaths = new Set<string>();
  private frontendHoverProfiles: FrontendHoverProfile[] = [];
  private inFlightHoverRequests = new Map<string, Promise<string | null>>();
  private lastConfigurationPayload = "";
  private lastDocumentSyncAt = performance.now();
  private lastEnvironmentSyncAt = performance.now();
  private hoverPrefetchTimer: number | null = null;
  private hoverTooltipDelayUpdateTimer: number | null = null;
  private hoverTooltipDelayMs = DEFAULT_HOVER_TOOLTIP_DELAY_MS;
  private pendingHoverTooltipDelayMs: number | null = null;
  private lspSyncTimer: number | null = null;
  private pendingMirrorSync: Promise<void> | null = null;
  private nextFrontendHoverProfileId = 1;
  private prefetchedHoverKeys = new Set<string>();
  private stableStaticHoverCache = new Map<string, string>();

  constructor(initialContent = "") {
    this.documentContent = initialContent;
    this.hoverPrefetchDelayMs = HOVER_PREFETCH_DELAY_MS;
    this.client = new LSPClient({
      // We drive didChange ourselves from syncDocument. Dropping CodeMirror's
      // built-in 500ms auto-sync keeps diagnostics responsive and avoids
      // redundant sync bursts after edits.
      extensions: [createManualServerDiagnosticsExtension()],
      rootUri: "file:///",
      timeout: 10000,
    });
    this.immediateClientSync = this.client.sync.bind(this.client);
    this.client.sync = () => {
      this.scheduleClientSync();
    };
    const originalRequest = this.client.request.bind(this.client) as <Params, Result>(
      method: string,
      params: Params,
    ) => Promise<Result>;
    this.client.request = <Params, Result>(method: string, params: Params): Promise<Result> => {
      if (method === "textDocument/hover") {
        return this.issueTrackedHoverRequest(params) as Promise<Result>;
      }

      const requestPromise = originalRequest(method, params) as Promise<Result>;
      return requestPromise.catch((error: unknown): Result => {
        if (PASSIVE_LSP_REQUEST_METHODS.has(method) && shouldSuppressPassiveLspError(error)) {
          return null as Result;
        }

        throw normalizeLspRequestError(error);
      });
    };
    this.extension = [
      LSPPlugin.create(this.client, PYTHON_MAIN_FILE_URI, "python"),
      serverCompletion(),
      this.hoverTooltipCompartment.of(hoverTooltips({ hoverTime: this.hoverTooltipDelayMs })),
      keymap.of([
        ...formatKeymap,
        ...renameKeymap,
        ...jumpToDefinitionKeymap,
        ...findReferencesKeymap,
      ]),
      signatureHelp(),
    ];
  }

  private issueTrackedHoverRequest(params: unknown) {
    return this.requestTrackedHoverResult(params, {
      recordAdaptiveDelay: true,
    }).catch((error: unknown) => {
      if (shouldSuppressHoverError(error)) {
        return null;
      }

      // Hover tooltips are best-effort UI. Never bubble failures into
      // CodeMirror's hover plugin, especially on Firefox where browser-owned
      // error objects can be uninspectable and cause noisy page errors.
      return null;
    });
  }

  private completeTrackedHoverRequest<T>(
    value: T,
    startedAt: number,
    options: { recordAdaptiveDelay?: boolean },
  ) {
    if (options.recordAdaptiveDelay !== false) {
      this.updateHoverTooltipDelay(performance.now() - startedAt);
    }

    return value;
  }

  private getMainFileView() {
    return this.client.workspace.getFile(PYTHON_MAIN_FILE_URI)?.getView() ?? null;
  }

  private updateHoverTooltipDelay(lastRequestMs: number) {
    const nextDelay =
      lastRequestMs > DEFAULT_HOVER_TOOLTIP_DELAY_MS
        ? IMMEDIATE_HOVER_TOOLTIP_DELAY_MS
        : DEFAULT_HOVER_TOOLTIP_DELAY_MS;
    if (nextDelay === this.hoverTooltipDelayMs && this.pendingHoverTooltipDelayMs === null) {
      return;
    }

    this.pendingHoverTooltipDelayMs = nextDelay;
    this.scheduleHoverTooltipDelayUpdate();
  }

  private async awaitPendingMirrorSync(maxWaitMs = 32) {
    const pendingMirrorSync = this.pendingMirrorSync;
    if (!pendingMirrorSync) {
      return;
    }

    await Promise.race([
      pendingMirrorSync.catch(() => {}),
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, maxWaitMs);
      }),
    ]);
  }

  private async awaitMirrorSyncCompletion() {
    const pendingMirrorSync = this.pendingMirrorSync;
    if (!pendingMirrorSync) {
      return;
    }

    await pendingMirrorSync.catch(() => {});
  }

  private clearHoverTooltipDelayUpdateTimer() {
    if (this.hoverTooltipDelayUpdateTimer !== null) {
      window.clearTimeout(this.hoverTooltipDelayUpdateTimer);
      this.hoverTooltipDelayUpdateTimer = null;
    }
  }

  private scheduleHoverTooltipDelayUpdate(delayMs = 0) {
    if (this.hoverTooltipDelayUpdateTimer !== null) {
      return;
    }

    this.hoverTooltipDelayUpdateTimer = window.setTimeout(() => {
      this.hoverTooltipDelayUpdateTimer = null;
      this.applyPendingHoverTooltipDelay();
    }, delayMs);
  }

  private applyPendingHoverTooltipDelay() {
    const nextDelay = this.pendingHoverTooltipDelayMs;
    if (nextDelay === null || nextDelay === this.hoverTooltipDelayMs) {
      this.pendingHoverTooltipDelayMs = null;
      return;
    }

    const view = this.getMainFileView();
    if (!view) {
      this.hoverTooltipDelayMs = nextDelay;
      this.pendingHoverTooltipDelayMs = null;
      return;
    }

    if (hasHoverTooltips(view.state)) {
      return;
    }

    this.hoverTooltipDelayMs = nextDelay;
    this.pendingHoverTooltipDelayMs = null;
    view.dispatch({
      effects: this.hoverTooltipCompartment.reconfigure(
        hoverTooltips({ hoverTime: this.hoverTooltipDelayMs }),
      ),
    });
  }

  private flushPendingHoverTooltipDelay() {
    if (this.pendingHoverTooltipDelayMs === null) {
      return;
    }

    if (this.hoverTooltipDelayUpdateTimer !== null) {
      return;
    }

    this.applyPendingHoverTooltipDelay();
  }

  private async requestTrackedHoverResult(
    params: unknown,
    options: { recordAdaptiveDelay?: boolean } = {},
  ) {
    this.flushPendingHoverTooltipDelay();
    const startedAt = performance.now();
    await this.client.initializing;

    const hoverParams = params as {
      position?: { character?: number; line?: number };
      textDocument?: { uri?: string };
    };
    const isMainDocumentHover =
      hoverParams?.textDocument?.uri === PYTHON_MAIN_FILE_URI && !!hoverParams.position;
    if (isMainDocumentHover) {
      this.deferPendingClientSync(HOVER_ACTIVE_LSP_SYNC_DEFER_MS);
      await this.awaitPendingMirrorSync();
    }

    const baseOffset = isMainDocumentHover
      ? lspPositionToOffset(this.documentContent, hoverParams.position!)
      : -1;
    const stableHoverCacheKey = isMainDocumentHover
      ? getStableHoverCacheKeyAtOffset(this.documentContent, baseOffset)
      : null;
    const isImportedBindingHover = stableHoverCacheKey?.startsWith("import:");
    const isImportedMemberHover =
      stableHoverCacheKey?.startsWith("member:") || stableHoverCacheKey?.startsWith("js:");
    if (stableHoverCacheKey) {
      const cachedHover = this.stableStaticHoverCache.get(stableHoverCacheKey);
      if (cachedHover) {
        if (!isIncompleteImportedHoverText(cachedHover, stableHoverCacheKey)) {
          return this.completeTrackedHoverRequest(
            createCachedHoverResult(this.documentContent, baseOffset, cachedHover),
            startedAt,
            options,
          );
        }

        this.stableStaticHoverCache.delete(stableHoverCacheKey);
      }
    }
    const hasIdentifierAtOffset =
      isMainDocumentHover && Boolean(getIdentifierAtOffset(this.documentContent, baseOffset));
    const hoverRetryDeadline = Math.max(this.lastDocumentSyncAt, this.lastEnvironmentSyncAt);
    const maxAttempts =
      isMainDocumentHover &&
      hasIdentifierAtOffset &&
      performance.now() - hoverRetryDeadline <= HOVER_EMPTY_RESULT_RETRY_WINDOW_MS
        ? isImportedMemberHover
          ? Math.min(HOVER_EMPTY_RESULT_RETRY_LIMIT, 6)
          : HOVER_EMPTY_RESULT_RETRY_LIMIT
        : 1;
    const documentRevisionAtStart = this.documentRevision;
    let lastResult: unknown = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      for (const candidateParams of buildHoverRequestCandidateParams(
        this.documentContent,
        params,
      )) {
        const result = await this.requestSingleTrackedHover(candidateParams);
        lastResult = result;
        const formattedHover = formatHoverResult(result);
        if (!isIncompleteImportedHoverText(formattedHover, stableHoverCacheKey) && formattedHover) {
          return this.completeTrackedHoverRequest(result, startedAt, options);
        }
      }

      if (attempt >= maxAttempts - 1 || this.documentRevision !== documentRevisionAtStart) {
        break;
      }

      await new Promise((resolve) => window.setTimeout(resolve, HOVER_EMPTY_RESULT_RETRY_DELAY_MS));
    }

    return this.completeTrackedHoverRequest(lastResult, startedAt, options);
  }

  private async requestSingleTrackedHover(params: unknown) {
    try {
      const hoverParams = params as {
        position?: { character?: number; line?: number };
        textDocument?: { uri?: string };
      };
      const rawResult = await this.transport.requestHover(
        hoverParams,
        hoverParams?.textDocument?.uri === PYTHON_MAIN_FILE_URI
          ? { deferMainDocumentSyncMs: HOVER_ACTIVE_LSP_SYNC_DEFER_MS }
          : undefined,
      );
      return normalizeHoverResultRange(this.documentContent, params, rawResult);
    } catch (error) {
      if (shouldSuppressHoverError(error)) {
        return null;
      }

      throw error;
    }
  }

  private createWorkspaceSettings(): WorkspaceSettings {
    return {
      environment: {
        "extra-paths": Array.from(this.extraPaths).sort(),
        "python-version": "3.13",
      },
    };
  }

  private applyConfiguration(options: { baselineOnly?: boolean } = {}) {
    const settings = this.createWorkspaceSettings();
    this.transport.setWorkspaceSettings(settings);

    if (!this.connected) {
      return;
    }

    const nextPayload = JSON.stringify(settings);

    if (nextPayload === this.lastConfigurationPayload) {
      return;
    }

    this.lastConfigurationPayload = nextPayload;
    if (options.baselineOnly) {
      return;
    }
  }

  private clearClientSyncTimer() {
    if (this.lspSyncTimer !== null) {
      window.clearTimeout(this.lspSyncTimer);
      this.lspSyncTimer = null;
    }
  }

  private flushClientSync() {
    this.clearClientSyncTimer();
    this.immediateClientSync();
  }

  private getMainFileVersion() {
    return this.client.workspace.getFile(PYTHON_MAIN_FILE_URI)?.version ?? null;
  }

  private scheduleClientSync(delayMs = LSP_SYNC_DEBOUNCE_MS) {
    if (!this.connected) {
      return;
    }

    this.clearClientSyncTimer();
    this.lspSyncTimer = window.setTimeout(() => {
      this.lspSyncTimer = null;
      this.immediateClientSync();
    }, delayMs);
  }

  private deferPendingClientSync(delayMs = LSP_SYNC_DEBOUNCE_MS) {
    if (this.lspSyncTimer === null) {
      return;
    }

    this.scheduleClientSync(delayMs);
  }

  private async ensureConnected() {
    if (!this.connected) {
      await this.transport.start(this.documentContent);
      this.client.connect(this.transport);
      this.connected = true;
    }

    await this.client.initializing;
  }

  private async requestHoverAtOffset(
    offset: number,
    options: { flushSync?: boolean; prefetch?: boolean } = {},
  ) {
    const stableHoverCacheKey = getStableHoverCacheKeyAtOffset(this.documentContent, offset);
    const frontendProfile: FrontendHoverProfile = {
      documentRevision: this.documentRevision,
      elapsedMs: null,
      endedAt: null,
      id: this.nextFrontendHoverProfileId++,
      offset,
      requestMs: null,
      stableCacheHit: false,
      startedAt: performance.now(),
    };
    if (stableHoverCacheKey) {
      const cachedHover = this.stableStaticHoverCache.get(stableHoverCacheKey);
      if (cachedHover) {
        if (!isIncompleteImportedHoverText(cachedHover, stableHoverCacheKey)) {
          frontendProfile.stableCacheHit = true;
          frontendProfile.requestMs = 0;
          frontendProfile.endedAt = performance.now();
          frontendProfile.elapsedMs = frontendProfile.endedAt - frontendProfile.startedAt;
          this.pushFrontendHoverProfile(frontendProfile);
          return cachedHover;
        }

        this.stableStaticHoverCache.delete(stableHoverCacheKey);
      }
    }

    const requestKey = `${this.documentRevision}:${offset}`;
    const existingRequest = this.inFlightHoverRequests.get(requestKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = (async () => {
      await this.ensureConnected();
      const requestStartedAt = performance.now();
      const result = await this.requestTrackedHoverResult(
        {
          position: offsetToLspPosition(this.documentContent, offset),
          textDocument: {
            uri: PYTHON_MAIN_FILE_URI,
          },
        },
        {
          recordAdaptiveDelay: !options.prefetch,
        },
      );
      const formattedHover = formatHoverResult(result);

      frontendProfile.requestMs = performance.now() - requestStartedAt;

      if (stableHoverCacheKey && formattedHover) {
        this.setStableHoverCacheValue(stableHoverCacheKey, formattedHover);
      }

      return formattedHover;
    })();

    this.inFlightHoverRequests.set(requestKey, request);

    try {
      return await request;
    } catch (error) {
      if (shouldSuppressHoverError(error)) {
        return null;
      }

      throw error;
    } finally {
      frontendProfile.endedAt = performance.now();
      frontendProfile.elapsedMs = frontendProfile.endedAt - frontendProfile.startedAt;
      this.pushFrontendHoverProfile(frontendProfile);
      if (this.inFlightHoverRequests.get(requestKey) === request) {
        this.inFlightHoverRequests.delete(requestKey);
      }
    }
  }

  private pushFrontendHoverProfile(profile: FrontendHoverProfile) {
    this.frontendHoverProfiles.push({ ...profile });
    if (this.frontendHoverProfiles.length > 50) {
      this.frontendHoverProfiles.splice(0, this.frontendHoverProfiles.length - 50);
    }
  }

  private clearStableHoverCache() {
    this.stableStaticHoverCache.clear();
  }

  private setStableHoverCacheValue(key: string, value: string) {
    if (this.stableStaticHoverCache.has(key)) {
      this.stableStaticHoverCache.delete(key);
    }
    this.stableStaticHoverCache.set(key, value);

    if (this.stableStaticHoverCache.size <= MAX_STABLE_HOVER_CACHE_ENTRIES) {
      return;
    }

    const oldestKey = this.stableStaticHoverCache.keys().next().value;
    if (typeof oldestKey === "string") {
      this.stableStaticHoverCache.delete(oldestKey);
    }
  }

  private clearHoverPrefetchTimer() {
    if (this.hoverPrefetchTimer !== null) {
      window.clearTimeout(this.hoverPrefetchTimer);
      this.hoverPrefetchTimer = null;
    }
  }

  private clearMainFileDiagnostics() {
    const view = this.getMainFileView();
    if (!view) {
      return;
    }

    view.dispatch(setDiagnostics(view.state, []));
  }

  private scheduleHoverPrefetch() {
    if (!this.connected) {
      return;
    }

    const offsets = collectHoverPrefetchOffsets(this.documentContent);
    if (offsets.length === 0) {
      return;
    }

    this.clearHoverPrefetchTimer();
    const revision = this.documentRevision;
    this.hoverPrefetchTimer = window.setTimeout(() => {
      this.hoverPrefetchTimer = null;
      void this.prefetchHoverOffsets(offsets, revision);
    }, this.hoverPrefetchDelayMs);
  }

  private async prefetchHoverOffsets(offsets: number[], revision: number) {
    if (this.documentRevision !== revision) {
      return;
    }

    for (const offset of offsets) {
      const cacheKey = `${revision}:${offset}`;
      if (this.prefetchedHoverKeys.has(cacheKey)) {
        continue;
      }

      const stableHoverCacheKey = getStableHoverCacheKeyAtOffset(this.documentContent, offset);
      if (stableHoverCacheKey && this.stableStaticHoverCache.has(stableHoverCacheKey)) {
        continue;
      }

      try {
        const hoverText = await this.requestHoverAtOffset(offset, {
          prefetch: true,
        });
        if (hoverText) {
          this.prefetchedHoverKeys.add(cacheKey);
        } else {
          this.prefetchedHoverKeys.delete(cacheKey);
        }
      } catch {
        this.prefetchedHoverKeys.delete(cacheKey);
        // Best-effort prefetch only.
      }

      if (this.documentRevision !== revision) {
        return;
      }
    }
  }

  async start(initialContent: string) {
    this.documentContent = initialContent;
    this.transport.setBootEnvironment({
      extraPaths: Array.from(this.extraPaths),
      files: [],
      packages: [],
      pythonVersion: "",
    });
    await this.transport.start(initialContent);
    await this.ensureConnected();
    this.flushClientSync();
    const mainFileVersion = this.getMainFileVersion();

    const mirrorSync = this.transport.syncFile(
      PYTHON_MAIN_FILE_PATH,
      initialContent,
      mainFileVersion,
    );
    const trackedMirrorSync = mirrorSync.finally(() => {
      if (this.pendingMirrorSync === trackedMirrorSync) {
        this.pendingMirrorSync = null;
      }
    });
    this.pendingMirrorSync = trackedMirrorSync;
    await trackedMirrorSync;
    this.applyConfiguration({
      baselineOnly: true,
    });
    this.documentRevision += 1;
    this.prefetchedHoverKeys.clear();
    this.scheduleHoverPrefetch();
  }

  async syncDocument(content: string) {
    this.documentContent = content;
    this.lastDocumentSyncAt = performance.now();
    this.documentRevision += 1;
    this.inFlightHoverRequests.clear();
    this.prefetchedHoverKeys.clear();
    this.clearHoverPrefetchTimer();
    this.clearMainFileDiagnostics();
    if (!this.connected) {
      return;
    }

    this.flushClientSync();
    const mainFileVersion = this.getMainFileVersion();

    const mirrorSync = this.transport
      .syncFile(PYTHON_MAIN_FILE_PATH, content, mainFileVersion)
      .catch((error) => {
        console.warn("Failed to mirror main.py into the ty worker file system", error);
      });
    const trackedMirrorSync = mirrorSync.finally(() => {
      if (this.pendingMirrorSync === trackedMirrorSync) {
        this.pendingMirrorSync = null;
      }
    });
    this.pendingMirrorSync = trackedMirrorSync;
    this.scheduleClientSync();
    this.scheduleHoverPrefetch();
  }

  async syncEnvironment(snapshot: PythonEnvironmentSnapshot) {
    const tySnapshot = createTyEnvironmentSnapshot(snapshot);
    this.lastEnvironmentSyncAt = performance.now();
    this.clearStableHoverCache();
    for (const extraPath of tySnapshot.extraPaths) {
      if (extraPath) {
        this.extraPaths.add(extraPath);
      }
    }

    if (!this.connected) {
      this.transport.setBootEnvironment(tySnapshot);
      await this.transport.start(this.documentContent);
      await this.ensureConnected();
      this.flushClientSync();
      await this.awaitMirrorSyncCompletion();
      const mainFileVersion = this.getMainFileVersion();
      if (tySnapshot.files.length > 0) {
        await this.transport.syncFiles(tySnapshot.files, mainFileVersion);
      }
      await this.transport.syncEnvironment(tySnapshot, mainFileVersion);
      this.applyConfiguration();
      this.inFlightHoverRequests.clear();
      this.prefetchedHoverKeys.clear();
      this.scheduleHoverPrefetch();
      return;
    }

    this.flushClientSync();
    await this.awaitMirrorSyncCompletion();
    const mainFileVersion = this.getMainFileVersion();
    if (tySnapshot.files.length > 0) {
      await this.transport.syncFiles(tySnapshot.files, mainFileVersion);
    }

    await this.transport.syncEnvironment(tySnapshot, mainFileVersion);
    this.applyConfiguration();
    this.inFlightHoverRequests.clear();
    this.prefetchedHoverKeys.clear();
    this.scheduleHoverPrefetch();
  }

  async getHoverAtOffset(offset: number) {
    this.clearHoverPrefetchTimer();
    return this.requestHoverAtOffset(offset);
  }

  async getHoverProfiles() {
    const workerProfiles = await this.transport.getHoverProfiles();
    return {
      frontendRecent: this.frontendHoverProfiles.map((profile) => ({ ...profile })),
      lspRecent: this.transport.getRecentLspEvents(),
      transportRecent: workerProfiles.transportRecent,
      worker: workerProfiles.worker,
    };
  }

  dispose() {
    this.clearClientSyncTimer();
    this.clearHoverPrefetchTimer();
    this.clearHoverTooltipDelayUpdateTimer();
    this.inFlightHoverRequests.clear();
    this.transport.dispose();
  }
}

export { TyLanguageService as PythonLanguageService };
