import {
  type AwaitPromiseRequest,
  type BridgeOperation,
  type BridgeResponse,
  createSyncBufferViews,
  type InvokeWorkerHandleRequest,
  type SerializedError,
  type SerializedHandleShape,
  type SerializedPropertyKey,
  type SerializedValue,
} from "../../jsBridgeProtocol";

interface ProxyMeta {
  boundThisHandleId?: number;
  callable: boolean;
  constructorCallable?: (...args: unknown[]) => unknown;
  handleId: number;
  proxyShape?: SerializedHandleShape;
}

interface PyProxyLike {
  copy(): object;
  destroy(options?: { destroyRoundtrip?: boolean; message?: string }): void;
}

interface PyProxyConvertible extends PyProxyLike {
  toJs(options?: {
    create_pyproxies?: boolean;
    dict_converter?: (items: Iterable<[string, unknown]>) => unknown;
  }): unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Object]" && (prototype === Object.prototype || prototype === null);
}

function isPyProxyLike(value: unknown): value is PyProxyLike {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    typeof (value as PyProxyLike).copy === "function" &&
    typeof (value as PyProxyLike).destroy === "function"
  );
}

function isPyProxyConvertible(value: unknown): value is PyProxyConvertible {
  return isPyProxyLike(value) && typeof (value as PyProxyConvertible).toJs === "function";
}

function toError(error: SerializedError) {
  const normalized = new Error(error.message);
  normalized.name = error.name ?? "RemoteError";

  if (error.stack) {
    normalized.stack = error.stack;
  }

  return normalized;
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

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Promise<unknown>).then === "function"
  );
}

function canStructuredClone(value: unknown) {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeResultForPostMessage(value: unknown): unknown {
  if (typeof value !== "function" && isPyProxyConvertible(value)) {
    const converted = value.toJs({
      create_pyproxies: false,
      dict_converter: Object.fromEntries,
    });

    try {
      value.destroy();
    } catch {
      // Ignore cleanup failures during result normalization.
    }

    return normalizeResultForPostMessage(converted);
  }

  if (
    value === undefined ||
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeResultForPostMessage(item));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeResultForPostMessage(item)]),
    );
  }

  if (canStructuredClone(value)) {
    return value;
  }

  return String(value);
}

function serializePropertyKey(property: string | symbol): SerializedPropertyKey {
  if (typeof property === "string") {
    return property;
  }

  if (property === Symbol.iterator) {
    return {
      kind: "symbol",
      name: "iterator",
    };
  }

  if (property === Symbol.asyncIterator) {
    return {
      kind: "symbol",
      name: "asyncIterator",
    };
  }

  if (property === Symbol.toPrimitive) {
    return {
      kind: "symbol",
      name: "toPrimitive",
    };
  }

  if (property === Symbol.toStringTag) {
    return {
      kind: "symbol",
      name: "toStringTag",
    };
  }

  throw new TypeError(`Unsupported symbol property: ${String(property)}`);
}

function deserializePropertyKey(property: SerializedPropertyKey): PropertyKey {
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

function propertyKeyId(property: PropertyKey) {
  return typeof property === "symbol" ? `symbol:${String(property)}` : `key:${String(property)}`;
}

export class WorkerJsBridge {
  private readonly asyncRequests = new Map<number, (response: BridgeResponse) => void>();
  private readonly localHandles = new Map<number, unknown>();
  private readonly localHandleStableKeys = new Map<string, number>();
  private readonly localHandleStableKeysById = new Map<number, string>();
  private readonly localReverseHandles = new WeakMap<object, number>();
  private readonly promiseCache = new Map<number, Promise<unknown>>();
  private readonly proxyCache = new Map<string, object>();
  private readonly proxyMeta = new WeakMap<object, ProxyMeta>();
  private readonly syncViews;
  private readonly textDecoder = new TextDecoder();
  private nextAsyncRequestId = 1;
  private nextLocalHandleId = 1;

  constructor(syncBuffer: SharedArrayBuffer) {
    this.syncViews = createSyncBufferViews(syncBuffer);
  }

  public createJSGlobals() {
    return this.createRemoteProxy(0, false);
  }

  public resolveAsyncRequest(requestId: number, response: BridgeResponse) {
    const resolver = this.asyncRequests.get(requestId);
    if (!resolver) {
      return;
    }

    this.asyncRequests.delete(requestId);
    resolver(response);
  }

  public async invokeLocalHandle(request: InvokeWorkerHandleRequest) {
    try {
      const callback = this.getLocalHandle(request.handleId);

      if (typeof callback !== "function") {
        throw new TypeError("Worker handle is not callable");
      }

      const result = Reflect.apply(
        callback,
        this.deserializeValue(request.thisArg),
        request.args.map((arg) => this.deserializeValue(arg)),
      );

      const awaitedResult = isPromiseLike(result) ? await result : result;

      return {
        ok: true,
        value: this.serializeValue(awaitedResult),
      } satisfies BridgeResponse;
    } catch (error) {
      return {
        ok: false,
        error: serializeError(error),
      } satisfies BridgeResponse;
    }
  }

  public releaseLocalHandle(handleId: number) {
    const value = this.localHandles.get(handleId);
    if (value === undefined) {
      return;
    }

    this.localHandles.delete(handleId);
    const stableKey = this.localHandleStableKeysById.get(handleId);
    if (stableKey !== undefined) {
      this.localHandleStableKeysById.delete(handleId);
      this.localHandleStableKeys.delete(stableKey);
    }

    if (isPyProxyLike(value)) {
      try {
        value.destroy();
      } catch {
        // Ignore cleanup failures during best-effort handle release.
      }
    }
  }

  private createRemoteProxy(
    handleId: number,
    callable: boolean,
    boundThisHandleId?: number,
    proxyShape?: SerializedHandleShape,
  ) {
    const cacheKey = `${handleId}:${callable ? "call" : "obj"}:${
      boundThisHandleId ?? "none"
    }:${proxyShape ?? "default"}`;
    const existingProxy = this.proxyCache.get(cacheKey);

    if (existingProxy) {
      return existingProxy;
    }

    const meta: ProxyMeta = {
      handleId,
      callable,
      boundThisHandleId,
      proxyShape,
    };

    const target = callable
      ? function remoteCallable() {}
      : proxyShape === "array"
        ? []
        : Object.create(null);

    const handler: ProxyHandler<object> = {
      get: (_, property) => this.getProperty(meta, property),
      set: (_, property, value) => this.setProperty(meta, property, value),
      has: (_, property) => this.hasProperty(meta, property),
      deleteProperty: (_, property) => this.deleteProperty(meta, target, property),
      ownKeys: () => this.getOwnKeys(meta, target),
      getOwnPropertyDescriptor: (_, property) =>
        this.getOwnPropertyDescriptor(meta, target, property),
    };

    if (callable) {
      handler.apply = (_, thisArg, args) => this.applyFunction(meta, thisArg, args);
      handler.construct = (_, args) => this.constructFunction(meta, args) as object;
    }

    const proxy = new Proxy(target, handler);

    this.proxyCache.set(cacheKey, proxy);
    this.proxyMeta.set(proxy, meta);

    return proxy;
  }

  private getProperty(meta: ProxyMeta, property: string | symbol) {
    if (property === Symbol.toPrimitive) {
      return () => `[RemoteHandle ${meta.handleId}]`;
    }

    if (property === Symbol.toStringTag) {
      if (meta.callable) {
        return "RemoteFunction";
      }

      return meta.proxyShape === "array" ? "Array" : "RemoteObject";
    }

    if (property === "new" && meta.callable) {
      if (!meta.constructorCallable) {
        meta.constructorCallable = (...args: unknown[]) => this.constructFunction(meta, args);
      }

      return meta.constructorCallable;
    }

    const response = this.syncRequest({
      kind: "get",
      handleId: meta.handleId,
      property: serializePropertyKey(property),
    });

    const boundThisHandleId =
      response.kind === "handle" && response.callable ? meta.handleId : undefined;

    return this.deserializeValue(response, boundThisHandleId);
  }

  private setProperty(meta: ProxyMeta, property: string | symbol, value: unknown) {
    if (typeof property === "symbol") {
      return false;
    }

    this.syncRequest({
      kind: "set",
      handleId: meta.handleId,
      property: serializePropertyKey(property),
      value: this.serializeValue(value),
    });

    return true;
  }

  private hasProperty(meta: ProxyMeta, property: string | symbol) {
    if (
      property === Symbol.toPrimitive ||
      property === Symbol.toStringTag ||
      (property === "new" && meta.callable)
    ) {
      return true;
    }

    const response = this.syncRequest({
      kind: "has",
      handleId: meta.handleId,
      property: serializePropertyKey(property),
    });

    if (response.kind !== "primitive" || typeof response.value !== "boolean") {
      return false;
    }

    return response.value;
  }

  private deleteProperty(meta: ProxyMeta, target: object, property: string | symbol) {
    if (property === "new" && meta.callable) {
      return false;
    }

    const localDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
    if (localDescriptor && !localDescriptor.configurable) {
      return false;
    }

    if (
      typeof property === "symbol" &&
      property !== Symbol.toPrimitive &&
      property !== Symbol.toStringTag &&
      property !== Symbol.iterator &&
      property !== Symbol.asyncIterator
    ) {
      return Reflect.deleteProperty(target, property);
    }

    const response = this.syncRequest({
      kind: "delete",
      handleId: meta.handleId,
      property: serializePropertyKey(property),
    });

    return response.kind === "primitive" && response.value === true;
  }

  private getOwnKeys(meta: ProxyMeta, target: object): Array<string | symbol> {
    const localKeys = Reflect.ownKeys(target);
    const response = this.syncRequest({
      kind: "ownKeys",
      handleId: meta.handleId,
    });

    if (response.kind !== "propertyKeys") {
      return localKeys;
    }

    const seen = new Set(localKeys.map((key) => propertyKeyId(key)));
    const remoteKeys = response.items
      .map((item) => deserializePropertyKey(item))
      .map((key) => (typeof key === "number" ? String(key) : key))
      .filter((key) => {
        const id = propertyKeyId(key);
        if (seen.has(id)) {
          return false;
        }

        seen.add(id);
        return true;
      });

    return [...localKeys, ...remoteKeys];
  }

  private getOwnPropertyDescriptor(meta: ProxyMeta, target: object, property: string | symbol) {
    if (property === "new" && meta.callable) {
      if (!meta.constructorCallable) {
        meta.constructorCallable = (...args: unknown[]) => this.constructFunction(meta, args);
      }

      return {
        configurable: true,
        enumerable: false,
        writable: false,
        value: meta.constructorCallable,
      };
    }

    const localDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
    if (localDescriptor && !localDescriptor.configurable) {
      return localDescriptor;
    }

    if (
      typeof property === "symbol" &&
      property !== Symbol.toPrimitive &&
      property !== Symbol.toStringTag &&
      property !== Symbol.iterator &&
      property !== Symbol.asyncIterator
    ) {
      return localDescriptor;
    }

    const response = this.syncRequest({
      kind: "getOwnPropertyDescriptor",
      handleId: meta.handleId,
      property: serializePropertyKey(property),
    });
    const descriptor = this.deserializeValue(response);

    if (descriptor === undefined) {
      return localDescriptor;
    }

    if (descriptor === null || typeof descriptor !== "object") {
      return undefined;
    }

    return {
      configurable: true,
      ...(descriptor as PropertyDescriptor),
    };
  }

  private applyFunction(meta: ProxyMeta, thisArg: unknown, args: unknown[]) {
    const response = this.syncRequest({
      kind: "apply",
      handleId: meta.handleId,
      thisArg:
        meta.boundThisHandleId !== undefined
          ? { kind: "handle", handleId: meta.boundThisHandleId, callable: false }
          : this.serializeValue(thisArg),
      args: args.map((arg) => this.serializeValue(arg)),
    });

    return this.deserializeValue(response);
  }

  private applyBoundMethod(handleId: number, property: SerializedPropertyKey, args: unknown[]) {
    const response = this.syncRequest({
      kind: "applyMethod",
      handleId,
      property,
      args: args.map((arg) => this.serializeValue(arg)),
    });

    return this.deserializeValue(response);
  }

  private constructFunction(meta: ProxyMeta, args: unknown[]) {
    const response = this.syncRequest({
      kind: "construct",
      handleId: meta.handleId,
      args: args.map((arg) => this.serializeValue(arg)),
    });

    return this.deserializeValue(response);
  }

  private syncRequest(operation: BridgeOperation) {
    Atomics.store(this.syncViews.header, 0, 0);
    Atomics.store(this.syncViews.header, 1, 0);

    self.postMessage({
      type: "bridge-sync-request",
      operation,
    });

    Atomics.wait(this.syncViews.header, 0, 0);

    const payloadLength = Atomics.load(this.syncViews.header, 1);
    const payloadBytes = new Uint8Array(payloadLength);
    payloadBytes.set(this.syncViews.payload.subarray(0, payloadLength));
    const payload = this.textDecoder.decode(payloadBytes);
    const response = JSON.parse(payload) as BridgeResponse;

    if (!response.ok) {
      throw toError(response.error);
    }

    return response.value;
  }

  private asyncRequest(request: AwaitPromiseRequest) {
    const requestId = this.nextAsyncRequestId++;

    const promise = new Promise<BridgeResponse>((resolve) => {
      this.asyncRequests.set(requestId, resolve);
    });

    self.postMessage({
      type: "bridge-async-request",
      requestId,
      request,
    });

    return promise;
  }

  private createRemotePromise(handleId: number) {
    const cachedPromise = this.promiseCache.get(handleId);
    if (cachedPromise) {
      return cachedPromise;
    }

    const promise = this.asyncRequest({
      kind: "await-promise",
      handleId,
    }).then((response) => {
      if (!response.ok) {
        throw toError(response.error);
      }

      return this.deserializeValue(response.value);
    });

    this.promiseCache.set(handleId, promise);
    return promise;
  }

  private deserializeValue(value: SerializedValue, boundThisHandleId?: number): unknown {
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
        return (...args: unknown[]) => this.applyBoundMethod(value.handleId, value.property, args);
      case "workerHandle":
        throw new TypeError("Worker-owned handles cannot be deserialized inside the worker");
      case "handle":
        return this.createRemoteProxy(
          value.handleId,
          value.callable,
          boundThisHandleId,
          value.proxyShape,
        );
      case "promise":
        return this.createRemotePromise(value.handleId);
    }
  }

  private serializeValue(value: unknown): SerializedValue {
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      const meta = this.proxyMeta.get(value as object);

      if (meta) {
        return {
          kind: "handle",
          handleId: meta.handleId,
          callable: meta.callable,
          proxyShape: meta.proxyShape,
        };
      }
    }

    if (typeof value !== "function" && isPyProxyConvertible(value)) {
      const converted = value.toJs({
        create_pyproxies: false,
        dict_converter: Object.fromEntries,
      });
      return this.serializeValue(converted);
    }

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

    if (Array.isArray(value)) {
      return {
        kind: "array",
        items: value.map((item) => this.serializeValue(item)),
      };
    }

    if (isPlainObject(value)) {
      return {
        kind: "object",
        entries: Object.entries(value).map(([key, item]) => [key, this.serializeValue(item)]),
      };
    }

    if (typeof value === "function") {
      return {
        kind: "workerHandle",
        handleId: this.registerSerializableFunction(value),
        callable: true,
      };
    }

    if (typeof value === "object" && value !== null) {
      throw new TypeError(
        "Only primitives, plain objects, arrays, remote JS handles, and worker callbacks can cross the bridge",
      );
    }

    throw new TypeError(`Unsupported bridge value type: ${typeof value}`);
  }

  private registerLocalHandle(value: object) {
    const existingHandleId = this.localReverseHandles.get(value);
    if (existingHandleId !== undefined && this.localHandles.has(existingHandleId)) {
      return existingHandleId;
    }

    const handleId = this.nextLocalHandleId++;
    this.localHandles.set(handleId, value);
    this.localReverseHandles.set(value, handleId);
    return handleId;
  }

  private registerSerializableFunction(value: Function) {
    const existingHandleId = this.localReverseHandles.get(value);
    if (existingHandleId !== undefined && this.localHandles.has(existingHandleId)) {
      return existingHandleId;
    }

    if (isPyProxyLike(value)) {
      const stableKey = this.getStableFunctionKey(value);
      if (stableKey !== null) {
        const stableHandleId = this.localHandleStableKeys.get(stableKey);
        if (stableHandleId !== undefined && this.localHandles.has(stableHandleId)) {
          this.localReverseHandles.set(value, stableHandleId);
          return stableHandleId;
        }
      }

      const ownedValue = value.copy();
      const handleId = this.registerLocalHandle(ownedValue);

      this.localReverseHandles.set(value, handleId);

      if (stableKey !== null) {
        this.localHandleStableKeys.set(stableKey, handleId);
        this.localHandleStableKeysById.set(handleId, stableKey);
      }

      return handleId;
    }

    return this.registerLocalHandle(value);
  }

  private getStableFunctionKey(value: Function) {
    try {
      const type =
        typeof (value as { type?: unknown }).type === "string"
          ? String((value as { type?: unknown }).type)
          : "function";
      const repr = String(value);
      return `${type}:${repr}`;
    } catch {
      return null;
    }
  }

  private getLocalHandle(handleId: number) {
    if (!this.localHandles.has(handleId)) {
      throw new ReferenceError(`Unknown worker handle: ${handleId}`);
    }

    return this.localHandles.get(handleId);
  }
}
