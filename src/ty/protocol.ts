import type { PythonEnvironmentFile } from "../pythonWorkspace";

export type WorkspaceSettings = {
  environment: {
    "extra-paths": string[];
    "python-version"?: string;
  };
};

export type BootMessage = {
  extraPaths: string[];
  files: PythonEnvironmentFile[];
  id: number;
  pythonJsStubContent: string;
  pythonVersion: string;
  type: "boot";
};

export type SyncFileMessage = {
  content: string;
  id: number;
  path: string;
  type: "sync-file";
};

export type SyncFilesMessage = {
  files: PythonEnvironmentFile[];
  id: number;
  type: "sync-files";
};

export type SyncEnvironmentMessage = {
  extraPaths: string[];
  id: number;
  pythonVersion: string;
  type: "sync-environment";
};

export type GetHoverProfilesMessage = {
  id: number;
  type: "get-hover-profiles";
};

export type HoverMessage = {
  id: number;
  params: {
    position?: { character?: number; line?: number };
    textDocument?: { uri?: string };
  };
  type: "hover";
};

export type DefinitionMessage = {
  id: number;
  params: {
    position?: { character?: number; line?: number };
    textDocument?: { uri?: string };
  };
  type: "definition";
};

export type CompletionMessage = {
  id: number;
  params: {
    position?: { character?: number; line?: number };
    textDocument?: { uri?: string };
  };
  type: "completion";
};

export type SignatureHelpMessage = {
  id: number;
  params: {
    position?: { character?: number; line?: number };
    textDocument?: { uri?: string };
  };
  type: "signature-help";
};

export type WorkerRequest =
  | BootMessage
  | SyncFileMessage
  | SyncFilesMessage
  | SyncEnvironmentMessage
  | GetHoverProfilesMessage
  | HoverMessage
  | DefinitionMessage
  | CompletionMessage
  | SignatureHelpMessage;

export type ControlMessage = WorkerRequest;

export type WorkerResponse = {
  error?: string;
  id?: number;
  payload?: unknown;
  type?: "debug" | "response";
};

export type WorkerHoverProfileSnapshot = {
  active: unknown[];
  recent: unknown[];
};

export type TransportHoverProfile = {
  absoluteResponseReceivedAt: number | null;
  absoluteSentAt: number;
  character: number | null;
  id: number | string;
  interleavedMessageCount: number;
  interleavedMethodCounts: Record<string, number>;
  line: number | null;
  responseReceivedAt: number | null;
  roundTripMs: number | null;
  sentAt: number;
  uri: string | null;
};

export type TransportLspEvent = {
  diagnosticCount?: number | null;
  direction: "incoming" | "outgoing";
  id: number | string | null;
  uri?: string | null;
  method: string | null;
  timestamp: number;
};

export type FrontendHoverProfile = {
  documentRevision: number;
  elapsedMs: number | null;
  endedAt: number | null;
  id: number;
  offset: number;
  requestMs: number | null;
  stableCacheHit: boolean;
  startedAt: number;
};
