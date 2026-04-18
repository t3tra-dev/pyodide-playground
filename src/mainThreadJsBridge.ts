import {
  type AwaitPromiseRequest,
  type BridgeOperation,
  type BridgeResponse,
  createSyncBufferViews,
  type InvokeWorkerHandleRequest,
  type SerializedError,
  type SerializedPropertyKey,
  type SerializedValue,
} from "./jsBridgeProtocol";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Object]" && (prototype === Object.prototype || prototype === null);
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<unknown>).then === "function"
  );
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
  };
}

function toError(error: SerializedError) {
  const normalized = new Error(error.message);
  normalized.name = error.name ?? "RemoteError";

  if (error.stack) {
    normalized.stack = error.stack;
  }

  return normalized;
}

function hasOwnOrPrototypeProperty(value: object, key: PropertyKey) {
  return key in value;
}

function deserializePropertyKey(property: SerializedPropertyKey) {
  if (typeof property === "object" && property !== null) {
    switch (property.name) {
      case "iterator":
        return Symbol.iterator;
      case "asyncIterator":
        return Symbol.asyncIterator;
      case "toPrimitive":
        return Symbol.toPrimitive;
      case "toStringTag":
        return Symbol.toStringTag;
    }
  }

  return property;
}

function serializePropertyKey(property: PropertyKey): SerializedPropertyKey | null {
  if (typeof property === "string" || typeof property === "number") {
    return property;
  }

  switch (property) {
    case Symbol.iterator:
      return { kind: "symbol", name: "iterator" };
    case Symbol.asyncIterator:
      return { kind: "symbol", name: "asyncIterator" };
    case Symbol.toPrimitive:
      return { kind: "symbol", name: "toPrimitive" };
    case Symbol.toStringTag:
      return { kind: "symbol", name: "toStringTag" };
    default:
      return null;
  }
}

interface SerializeOptions {
  snapshotEvents?: boolean;
  temporaryHandleIds?: Set<number>;
}

export class MainThreadJsBridge {
  private readonly handles = new Map<number, unknown>();
  private readonly reverseHandles = new WeakMap<object, number>();
  private readonly syncViews;
  private readonly textEncoder = new TextEncoder();
  private readonly workerHandleCache = new Map<
    number,
    WeakRef<(...args: unknown[]) => Promise<unknown>>
  >();
  private readonly workerHandleFinalizer: FinalizationRegistry<number> | null;
  private nextHandleId = 1;

  constructor(
    private readonly syncBuffer: SharedArrayBuffer,
    private readonly invokeWorkerHandleRequest: (
      request: InvokeWorkerHandleRequest,
    ) => Promise<BridgeResponse>,
    private readonly releaseWorkerHandleRequest: (handleId: number) => Promise<void>,
  ) {
    this.syncViews = createSyncBufferViews(syncBuffer);
    this.registerHandle(globalThis, 0);
    this.workerHandleFinalizer =
      typeof FinalizationRegistry === "undefined"
        ? null
        : new FinalizationRegistry((handleId) => {
            this.workerHandleCache.delete(handleId);
            void this.releaseWorkerHandleRequest(handleId);
          });
  }

  public getSyncBuffer() {
    return this.syncBuffer;
  }

  public respondToSyncRequest(operation: BridgeOperation) {
    this.writeSyncResponse(this.execute(operation));
  }

  public async respondToAsyncRequest(request: AwaitPromiseRequest) {
    try {
      const promise = this.getHandle(request.handleId);

      if (!isPromiseLike(promise)) {
        throw new TypeError("Remote handle is not a Promise");
      }

      return {
        ok: true,
        value: this.serializeValue(await promise),
      } satisfies BridgeResponse;
    } catch (error) {
      return {
        ok: false,
        error: serializeError(error),
      } satisfies BridgeResponse;
    }
  }

  private execute(operation: BridgeOperation): BridgeResponse {
    try {
      let result: unknown;

      switch (operation.kind) {
        case "get":
          result = Reflect.get(
            this.expectObjectLike(this.getHandle(operation.handleId)),
            deserializePropertyKey(operation.property),
          );
          break;
        case "set":
          Reflect.set(
            this.expectObjectLike(this.getHandle(operation.handleId)),
            deserializePropertyKey(operation.property),
            this.deserializeValue(operation.value),
          );
          result = undefined;
          break;
        case "has":
          result = Reflect.has(
            this.expectObjectLike(this.getHandle(operation.handleId)),
            deserializePropertyKey(operation.property),
          );
          break;
        case "delete":
          result = Reflect.deleteProperty(
            this.expectObjectLike(this.getHandle(operation.handleId)),
            deserializePropertyKey(operation.property),
          );
          break;
        case "ownKeys":
          return {
            ok: true,
            value: {
              kind: "propertyKeys",
              items: Reflect.ownKeys(
                this.expectObjectLike(this.getHandle(operation.handleId)),
              ).flatMap((key) => {
                const serializedKey = serializePropertyKey(key);
                return serializedKey === null ? [] : [serializedKey];
              }),
            } satisfies SerializedValue,
          };
        case "getOwnPropertyDescriptor":
          result = Reflect.getOwnPropertyDescriptor(
            this.expectObjectLike(this.getHandle(operation.handleId)),
            deserializePropertyKey(operation.property),
          );
          break;
        case "apply":
          result = Reflect.apply(
            this.expectFunction(this.getHandle(operation.handleId)),
            this.deserializeValue(operation.thisArg),
            operation.args.map((item) => this.deserializeValue(item)),
          );
          break;
        case "applyMethod": {
          const target = this.expectObjectLike(this.getHandle(operation.handleId));
          const method = Reflect.get(target, deserializePropertyKey(operation.property));
          result = Reflect.apply(
            this.expectFunction(method),
            target,
            operation.args.map((item) => this.deserializeValue(item)),
          );
          break;
        }
        case "construct":
          result = Reflect.construct(
            this.expectFunction(this.getHandle(operation.handleId)),
            operation.args.map((item) => this.deserializeValue(item)),
          );
          break;
      }

      return {
        ok: true,
        value: this.serializeValue(result),
      };
    } catch (error) {
      return {
        ok: false,
        error: serializeError(error),
      };
    }
  }

  private writeSyncResponse(response: BridgeResponse) {
    let encoded = this.textEncoder.encode(JSON.stringify(response));

    if (encoded.byteLength > this.syncViews.payload.byteLength) {
      encoded = this.textEncoder.encode(
        JSON.stringify({
          ok: false,
          error: {
            message: "Bridge response exceeded sync buffer size",
            name: "RangeError",
          },
        } satisfies BridgeResponse),
      );
    }

    this.syncViews.payload.set(encoded);
    Atomics.store(this.syncViews.header, 1, encoded.byteLength);
    Atomics.store(this.syncViews.header, 0, 1);
    Atomics.notify(this.syncViews.header, 0, 1);
  }

  private serializeValue(value: unknown, options: SerializeOptions = {}): SerializedValue {
    if (value === undefined) {
      return { kind: "undefined" };
    }

    if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    ) {
      return { kind: "primitive", value };
    }

    if (typeof value === "bigint") {
      return { kind: "bigint", value: value.toString() };
    }

    if (options.snapshotEvents && typeof Event !== "undefined" && value instanceof Event) {
      return this.serializeEventSnapshot(value, options);
    }

    if (isPlainObject(value)) {
      return {
        kind: "object",
        entries: Object.entries(value).map(([key, item]) => [
          key,
          this.serializeValue(item, options),
        ]),
      };
    }

    if (typeof value === "object" || typeof value === "function") {
      const handleId = this.registerHandle(value);

      if (isPromiseLike(value)) {
        return {
          kind: "promise",
          handleId,
        };
      }

      return {
        kind: "handle",
        handleId,
        callable: typeof value === "function",
        proxyShape: Array.isArray(value) ? "array" : undefined,
      };
    }

    throw new TypeError(`Unsupported bridge value type: ${typeof value}`);
  }

  private serializeEventSnapshot(event: Event, options: SerializeOptions): SerializedValue {
    const eventHandleId = this.registerTemporaryHandle(event, options.temporaryHandleIds);
    const entries: Array<[string, SerializedValue]> = [
      ["type", this.serializeValue(event.type)],
      ["bubbles", this.serializeValue(event.bubbles)],
      ["cancelable", this.serializeValue(event.cancelable)],
      ["composed", this.serializeValue(event.composed)],
      ["defaultPrevented", this.serializeValue(event.defaultPrevented)],
      ["eventPhase", this.serializeValue(event.eventPhase)],
      ["isTrusted", this.serializeValue(event.isTrusted)],
      ["timeStamp", this.serializeValue(event.timeStamp)],
      ["target", this.serializeValue(event.target)],
      ["currentTarget", this.serializeValue(event.currentTarget)],
    ];

    const addIfPresent = (key: string, rawValue: unknown) => {
      entries.push([key, this.serializeValue(rawValue)]);
    };

    if (hasOwnOrPrototypeProperty(event, "detail")) {
      addIfPresent("detail", (event as Event & { detail?: unknown }).detail);
    }

    if (hasOwnOrPrototypeProperty(event, "key")) {
      const keyboardEvent = event as Event & {
        code?: string;
        key?: string;
        repeat?: boolean;
      };
      addIfPresent("key", keyboardEvent.key);
      addIfPresent("code", keyboardEvent.code);
      addIfPresent("repeat", keyboardEvent.repeat);
    }

    if (hasOwnOrPrototypeProperty(event, "clientX")) {
      const pointerLikeEvent = event as Event & {
        button?: number;
        buttons?: number;
        clientX?: number;
        clientY?: number;
        pageX?: number;
        pageY?: number;
        screenX?: number;
        screenY?: number;
      };
      addIfPresent("clientX", pointerLikeEvent.clientX);
      addIfPresent("clientY", pointerLikeEvent.clientY);
      addIfPresent("pageX", pointerLikeEvent.pageX);
      addIfPresent("pageY", pointerLikeEvent.pageY);
      addIfPresent("screenX", pointerLikeEvent.screenX);
      addIfPresent("screenY", pointerLikeEvent.screenY);
      addIfPresent("button", pointerLikeEvent.button);
      addIfPresent("buttons", pointerLikeEvent.buttons);
    }

    const addMethodIfPresent = (key: string, property: string = key) => {
      if (typeof (event as Event & Record<string, unknown>)[property] !== "function") {
        return;
      }

      entries.push([
        key,
        {
          kind: "boundMethod",
          handleId: eventHandleId,
          property,
        },
      ]);
    };

    addMethodIfPresent("preventDefault");
    addMethodIfPresent("stopPropagation");
    addMethodIfPresent("stopImmediatePropagation");

    return {
      kind: "object",
      entries,
    };
  }

  private deserializeValue(value: SerializedValue): unknown {
    switch (value.kind) {
      case "undefined":
        return undefined;
      case "primitive":
        return value.value;
      case "bigint":
        return BigInt(value.value);
      case "array":
        return value.items.map((item) => this.deserializeValue(item));
      case "propertyKeys":
        return value.items.map((item) => deserializePropertyKey(item));
      case "object":
        return Object.fromEntries(
          value.entries.map(([key, item]) => [key, this.deserializeValue(item)]),
        );
      case "boundMethod":
        return (...args: unknown[]) => {
          const response = this.execute({
            kind: "applyMethod",
            handleId: value.handleId,
            property: value.property,
            args: args.map((arg) => this.serializeValue(arg, { snapshotEvents: true })),
          });

          if (!response.ok) {
            throw toError(response.error);
          }

          return this.deserializeValue(response.value);
        };
      case "workerHandle":
        return this.getWorkerHandleProxy(value.handleId);
      case "handle":
      case "promise":
        return this.getHandle(value.handleId);
    }
  }

  private getWorkerHandleProxy(handleId: number) {
    const cachedHandleRef = this.workerHandleCache.get(handleId);
    const cachedHandle = cachedHandleRef?.deref();
    if (cachedHandle) {
      return cachedHandle;
    }

    const callback = function (this: unknown, ...args: unknown[]): Promise<unknown> {
      const temporaryHandleIds = new Set<number>();
      let responsePromise: Promise<unknown>;

      try {
        responsePromise = bridge
          .invokeWorkerHandleRequest({
            kind: "invoke-worker-handle",
            handleId,
            thisArg: bridge.serializeValue(this),
            args: args.map((arg) =>
              bridge.serializeValue(arg, {
                snapshotEvents: true,
                temporaryHandleIds,
              }),
            ),
          })
          .then((response) => {
            if (!response.ok) {
              throw toError(response.error);
            }

            return bridge.deserializeValue(response.value);
          });
      } catch (error) {
        bridge.releaseHandles(temporaryHandleIds);
        throw error;
      }

      responsePromise.finally(() => {
        bridge.releaseHandles(temporaryHandleIds);
      });

      responsePromise.catch((error) => {
        console.error("Worker callback failed", error);
      });

      return responsePromise;
    };

    const bridge = this;
    this.workerHandleCache.set(handleId, new WeakRef(callback));
    this.workerHandleFinalizer?.register(callback, handleId);
    return callback;
  }

  private registerHandle(value: object, knownHandleId?: number): number {
    const existingHandleId = this.reverseHandles.get(value);
    if (existingHandleId !== undefined) {
      return existingHandleId;
    }

    const handleId = knownHandleId ?? this.nextHandleId++;
    this.handles.set(handleId, value);
    this.reverseHandles.set(value, handleId);
    return handleId;
  }

  private registerTemporaryHandle(value: object, temporaryHandleIds?: Set<number>) {
    const handleId = this.registerHandle(value);
    temporaryHandleIds?.add(handleId);
    return handleId;
  }

  private releaseHandle(handleId: number) {
    const value = this.handles.get(handleId);
    if (value === undefined) {
      return;
    }

    this.handles.delete(handleId);
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      this.reverseHandles.delete(value as object);
    }
  }

  private releaseHandles(handleIds: Iterable<number>) {
    for (const handleId of handleIds) {
      this.releaseHandle(handleId);
    }
  }

  private getHandle(handleId: number) {
    if (!this.handles.has(handleId)) {
      throw new ReferenceError(`Unknown remote handle: ${handleId}`);
    }

    return this.handles.get(handleId);
  }

  private expectFunction(value: unknown) {
    if (typeof value !== "function") {
      throw new TypeError("Remote handle is not callable");
    }

    return value;
  }

  private expectObjectLike(value: unknown) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") {
      throw new TypeError("Remote handle does not support property access");
    }

    return value;
  }
}
