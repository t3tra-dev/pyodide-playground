const SDL_MUTATING_CONTEXT_METHODS = new Set([
  "clearRect",
  "drawImage",
  "fill",
  "fillRect",
  "fillText",
  "putImageData",
  "stroke",
  "strokeRect",
  "strokeText",
]);

type JsGlobalsBridge = {
  createJSGlobals(): Record<string, unknown>;
};

type TargetCanvasLike = {
  addEventListener?: (...args: unknown[]) => unknown;
  blur?: (...args: unknown[]) => unknown;
  dispatchEvent?: (...args: unknown[]) => unknown;
  focus?: (...args: unknown[]) => unknown;
  getBoundingClientRect?: (...args: unknown[]) => unknown;
  getContext?: (...args: unknown[]) => unknown;
  height?: unknown;
  ownerDocument?: unknown;
  parentNode?: unknown;
  removeEventListener?: (...args: unknown[]) => unknown;
  requestPointerLock?: (...args: unknown[]) => unknown;
  width?: unknown;
};

let experimentalSdlGlobalsInstalled = false;
const workerScope = globalThis as DedicatedWorkerGlobalScope & typeof globalThis;

function normalizeCanvasDimension(value: unknown, fallback: number) {
  const normalized =
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : Number(value);

  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback;
  }

  return normalized;
}

function enqueueMicrotask(callback: () => void) {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(callback);
    return;
  }

  void Promise.resolve().then(callback);
}

function postSdlFrame(offscreenCanvas: OffscreenCanvas, width: number, height: number) {
  if (typeof offscreenCanvas.transferToImageBitmap === "function") {
    const bitmap = offscreenCanvas.transferToImageBitmap();
    workerScope.postMessage({ type: "sdl-frame", bitmap, width, height }, [bitmap]);
    return;
  }

  if (typeof createImageBitmap === "function") {
    void createImageBitmap(offscreenCanvas)
      .then((bitmap) => {
        workerScope.postMessage({ type: "sdl-frame", bitmap, width, height }, [bitmap]);
      })
      .catch((error) => {
        console.warn("Failed to create an SDL frame bitmap", error);
      });
  }
}

export function createSdlScreenCanvas(targetCanvas: TargetCanvasLike) {
  if (typeof OffscreenCanvas === "undefined") {
    return targetCanvas;
  }

  const initialWidth = normalizeCanvasDimension(targetCanvas.width, 320);
  const initialHeight = normalizeCanvasDimension(targetCanvas.height, 180);
  const offscreenCanvas = new OffscreenCanvas(initialWidth, initialHeight);
  const offscreenContext = offscreenCanvas.getContext("2d");
  if (!offscreenContext) {
    return targetCanvas;
  }

  const style = {
    removeProperty() {},
    setProperty() {},
  };
  let flushQueued = false;

  const scheduleFlush = () => {
    if (flushQueued) {
      return;
    }

    flushQueued = true;
    enqueueMicrotask(() => {
      flushQueued = false;
      postSdlFrame(offscreenCanvas, offscreenCanvas.width, offscreenCanvas.height);
    });
  };

  const setSize = (nextWidth: unknown, nextHeight: unknown) => {
    const width = normalizeCanvasDimension(nextWidth, offscreenCanvas.width || 320);
    const height = normalizeCanvasDimension(nextHeight, offscreenCanvas.height || 180);
    if (offscreenCanvas.width !== width) {
      offscreenCanvas.width = width;
    }
    if (offscreenCanvas.height !== height) {
      offscreenCanvas.height = height;
    }
    if (targetCanvas.width !== width) {
      targetCanvas.width = width;
    }
    if (targetCanvas.height !== height) {
      targetCanvas.height = height;
    }
    scheduleFlush();
  };

  let canvas: Record<string, unknown>;
  const context = new Proxy(offscreenContext, {
    get(target, property, receiver) {
      if (property === "canvas") {
        return canvas;
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }

      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (SDL_MUTATING_CONTEXT_METHODS.has(String(property))) {
          scheduleFlush();
        }
        return result;
      };
    },
  });

  canvas = {
    addEventListener: (...args: unknown[]) => targetCanvas.addEventListener?.(...args),
    blur: (...args: unknown[]) => targetCanvas.blur?.(...args),
    dispatchEvent: (...args: unknown[]) => targetCanvas.dispatchEvent?.(...args),
    focus: (...args: unknown[]) => targetCanvas.focus?.(...args),
    getBoundingClientRect: (...args: unknown[]) => targetCanvas.getBoundingClientRect?.(...args),
    getContext: (kind: string, ...args: unknown[]) => {
      if (kind === "2d") {
        return context;
      }

      return targetCanvas.getContext?.(kind, ...args);
    },
    id: "canvas",
    removeEventListener: (...args: unknown[]) => targetCanvas.removeEventListener?.(...args),
    requestPointerLock: (...args: unknown[]) => targetCanvas.requestPointerLock?.(...args),
    style,
  };

  Object.defineProperties(canvas, {
    height: {
      configurable: true,
      enumerable: true,
      get() {
        return offscreenCanvas.height;
      },
      set(value: unknown) {
        setSize(offscreenCanvas.width, value);
      },
    },
    ownerDocument: {
      configurable: true,
      enumerable: false,
      get() {
        return targetCanvas.ownerDocument;
      },
    },
    parentNode: {
      configurable: true,
      enumerable: false,
      get() {
        return targetCanvas.parentNode;
      },
    },
    width: {
      configurable: true,
      enumerable: true,
      get() {
        return offscreenCanvas.width;
      },
      set(value: unknown) {
        setSize(value, offscreenCanvas.height);
      },
    },
  });

  return canvas;
}

export function ensureExperimentalSdlGlobals(bridge: JsGlobalsBridge) {
  if (experimentalSdlGlobalsInstalled) {
    return;
  }

  const jsGlobals = bridge.createJSGlobals() as Record<string, unknown>;
  const target = self as unknown as Record<string, unknown>;

  const assignIfMissing = (key: string, value: unknown) => {
    if (key in target) {
      return;
    }

    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true,
    });
  };

  assignIfMissing("window", jsGlobals);
  assignIfMissing("document", jsGlobals.document);
  assignIfMissing("screen", jsGlobals.screen);
  assignIfMissing("ImageData", jsGlobals.ImageData);
  assignIfMissing("HTMLCanvasElement", jsGlobals.HTMLCanvasElement);
  experimentalSdlGlobalsInstalled = true;
}
