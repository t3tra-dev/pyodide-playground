export const SYNC_HEADER_INTS = 2;
export const SYNC_BUFFER_BYTES = 1024 * 1024;
export const SYNC_BUFFER_TOTAL_BYTES =
  SYNC_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT + SYNC_BUFFER_BYTES;
export const STDIN_HEADER_INTS = 2;
export const STDIN_BUFFER_BYTES = 64 * 1024;
export const STDIN_BUFFER_TOTAL_BYTES =
  STDIN_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT + STDIN_BUFFER_BYTES;

export type JsonPrimitive = boolean | number | string | null;
export type SerializedHandleShape = "array";
export type SerializedSymbolName = "iterator" | "asyncIterator" | "toPrimitive" | "toStringTag";
export type SerializedPropertyKey =
  | number
  | string
  | { kind: "symbol"; name: SerializedSymbolName };

export type SerializedValue =
  | { kind: "undefined" }
  | { kind: "primitive"; value: JsonPrimitive }
  | { kind: "bigint"; value: string }
  | { kind: "array"; items: SerializedValue[] }
  | { kind: "propertyKeys"; items: SerializedPropertyKey[] }
  | { kind: "object"; entries: Array<[string, SerializedValue]> }
  | {
      kind: "boundMethod";
      handleId: number;
      property: SerializedPropertyKey;
    }
  | {
      kind: "handle";
      handleId: number;
      callable: boolean;
      proxyShape?: SerializedHandleShape;
    }
  | { kind: "workerHandle"; handleId: number; callable: boolean }
  | { kind: "promise"; handleId: number };

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}

export type BridgeOperation =
  | {
      kind: "get";
      handleId: number;
      property: SerializedPropertyKey;
    }
  | {
      kind: "set";
      handleId: number;
      property: SerializedPropertyKey;
      value: SerializedValue;
    }
  | {
      kind: "apply";
      handleId: number;
      thisArg: SerializedValue;
      args: SerializedValue[];
    }
  | {
      kind: "applyMethod";
      handleId: number;
      property: SerializedPropertyKey;
      args: SerializedValue[];
    }
  | {
      kind: "construct";
      handleId: number;
      args: SerializedValue[];
    }
  | {
      kind: "has";
      handleId: number;
      property: SerializedPropertyKey;
    }
  | {
      kind: "delete";
      handleId: number;
      property: SerializedPropertyKey;
    }
  | {
      kind: "ownKeys";
      handleId: number;
    }
  | {
      kind: "getOwnPropertyDescriptor";
      handleId: number;
      property: SerializedPropertyKey;
    };

export interface BridgeSuccessResponse {
  ok: true;
  value: SerializedValue;
}

export interface BridgeErrorResponse {
  ok: false;
  error: SerializedError;
}

export type BridgeResponse = BridgeErrorResponse | BridgeSuccessResponse;

export interface AwaitPromiseRequest {
  kind: "await-promise";
  handleId: number;
}

export interface InvokeWorkerHandleRequest {
  kind: "invoke-worker-handle";
  handleId: number;
  thisArg: SerializedValue;
  args: SerializedValue[];
}

export interface SyncBufferViews {
  header: Int32Array;
  payload: Uint8Array;
}

export interface StdinBufferViews {
  header: Int32Array;
  payload: Uint8Array;
}

export function createSyncBufferViews(buffer: SharedArrayBuffer): SyncBufferViews {
  return {
    header: new Int32Array(buffer, 0, SYNC_HEADER_INTS),
    payload: new Uint8Array(
      buffer,
      SYNC_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT,
      SYNC_BUFFER_BYTES,
    ),
  };
}

export function createStdinBufferViews(buffer: SharedArrayBuffer): StdinBufferViews {
  return {
    header: new Int32Array(buffer, 0, STDIN_HEADER_INTS),
    payload: new Uint8Array(
      buffer,
      STDIN_HEADER_INTS * Int32Array.BYTES_PER_ELEMENT,
      STDIN_BUFFER_BYTES,
    ),
  };
}
