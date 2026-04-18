type MplToolbarImageProxy = {
  toJs: (options?: unknown) => Uint8Array;
};

type MplGlobal = Record<string, unknown> & {
  __pyodideCompatPatched__?: boolean;
  figure?: FigureConstructor;
  get_websocket_type?: () => WebSocketConstructor;
};

type FigureInstance = {
  __pyodideInitialResizeLocked__?: boolean;
  __pyodideLastResize__?: [number, number];
  canvas_div?: HTMLDivElement;
  root?: HTMLDivElement;
  ws?: {
    python_onmessage_callback?: unknown;
    readyState?: number;
    send?: (content: unknown) => void;
  };
};

type FigureConstructor = {
  new (...args: unknown[]): FigureInstance;
  prototype: FigureInstance & Record<string, unknown>;
  __pyodideCompatPatched__?: boolean;
};

type WebSocketInstance = {
  __pyodidePendingMessages__?: unknown[];
  onmessage?: (event: { data: unknown }) => void;
  onopen?: () => void;
  python_onmessage_callback?: unknown;
  readyState?: number;
};

type WebSocketConstructor = {
  new (...args: unknown[]): WebSocketInstance;
  prototype: WebSocketInstance & Record<string, unknown>;
  __pyodideCompatPatched__?: boolean;
};

type WindowWithMatplotlibCompat = Window &
  typeof globalThis & {
    mpl?: MplGlobal;
    __pyodideMatplotlibCompatInstalled__?: boolean;
  };

const iconByteCache = new Map<string, Uint8Array>();
const iconDataUrlCache = new Map<string, string>();
const providedToolbarIconDataUrls = new Map<string, string>();

function dataUrlToBytes(dataUrl: string) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function createPngBlob(source: ArrayBuffer | ArrayBufferView<ArrayBufferLike>) {
  const bytes =
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : Uint8Array.from(
          source instanceof Uint8Array
            ? source
            : new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
        );

  return new Blob([bytes], { type: "image/png" });
}

function createToolbarIconBytes(image: string) {
  const dataUrl = createToolbarIconDataUrl(image);
  const cached = iconByteCache.get(image);
  if (cached) {
    return cached;
  }
  const bytes = dataUrlToBytes(dataUrl);
  iconByteCache.set(image, bytes);
  return bytes;
}

function createToolbarIconDataUrl(image: string) {
  const provided = providedToolbarIconDataUrls.get(image);
  if (provided) {
    return provided;
  }

  const cached = iconDataUrlCache.get(image);
  if (cached) {
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 24;
  canvas.height = 24;
  const context = canvas.getContext("2d");

  if (!context) {
    const empty = "data:image/png;base64,";
    iconDataUrlCache.set(image, empty);
    return empty;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#d4d7dd";
  context.font = "bold 12px IBM Plex Sans, Segoe UI, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(image.slice(0, 1).toUpperCase(), 12, 13);

  const dataUrl = canvas.toDataURL("image/png");
  iconDataUrlCache.set(image, dataUrl);
  return dataUrl;
}

function createToolbarImageProxy(image: string): MplToolbarImageProxy {
  return {
    toJs: () => createToolbarIconBytes(image),
  };
}

function normalizeWorkerCallback(value: unknown) {
  if (typeof value === "function") {
    return value;
  }

  if (
    value &&
    typeof value === "object" &&
    typeof (value as { apply?: unknown }).apply === "function"
  ) {
    return (...args: unknown[]) =>
      (value as { apply: (thisArg: unknown, args: unknown[]) => unknown }).apply(undefined, args);
  }

  if (
    value &&
    typeof value === "object" &&
    typeof (value as { call?: unknown }).call === "function"
  ) {
    return (...args: unknown[]) =>
      (value as { call: (thisArg: unknown, ...args: unknown[]) => unknown }).call(
        undefined,
        ...args,
      );
  }

  return null;
}

function patchWebSocketType(WebSocketType: WebSocketConstructor) {
  if (WebSocketType.__pyodideCompatPatched__) {
    return WebSocketType;
  }

  const prototype = WebSocketType.prototype;

  prototype.open = function (python_onmessage_callback: unknown) {
    this.python_onmessage_callback = normalizeWorkerCallback(python_onmessage_callback);
    this.readyState = 1;
    this.onopen?.();
  };

  prototype.send = function (content: unknown) {
    const callback = normalizeWorkerCallback(this.python_onmessage_callback);

    if (!callback) {
      (this.__pyodidePendingMessages__ ??= []).push(content);
      return;
    }

    callback(content);
  };

  prototype.receive_binary = function (content: unknown) {
    if (typeof content === "string") {
      this.onmessage?.({ data: content });
      return;
    }

    if (ArrayBuffer.isView(content) || content instanceof ArrayBuffer) {
      const bytes =
        content instanceof ArrayBuffer
          ? new Uint8Array(content)
          : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
      this.onmessage?.({ data: createPngBlob(bytes) });
      return;
    }

    if (
      content &&
      typeof content === "object" &&
      typeof (content as { getBuffer?: unknown }).getBuffer === "function"
    ) {
      const typedContent = content as {
        getBuffer: () => {
          data: Uint8Array<ArrayBufferLike>;
          release: () => void;
        };
        destroy?: () => void;
      };
      const buffer = typedContent.getBuffer();

      try {
        this.onmessage?.({ data: createPngBlob(buffer.data) });
      } finally {
        buffer.release();
        typedContent.destroy?.();
      }
    }
  };

  WebSocketType.__pyodideCompatPatched__ = true;
  return WebSocketType;
}

function patchFigureConstructor(Figure: FigureConstructor) {
  if (Figure.__pyodideCompatPatched__) {
    return Figure;
  }

  const prototype = Figure.prototype as FigureInstance & {
    _init_canvas?: (...args: unknown[]) => void;
    request_resize?: (width: number, height: number) => void;
  };

  const originalInitCanvas = prototype._init_canvas;
  if (originalInitCanvas) {
    prototype._init_canvas = function (...args: unknown[]) {
      originalInitCanvas.apply(this, args);

      if (this.root) {
        this.root.style.display = "block";
        this.root.style.maxWidth = "100%";
      }

      if (this.canvas_div) {
        this.canvas_div.style.maxWidth = "100%";
        this.canvas_div.style.resize = "none";
      }
    };
  }

  const originalRequestResize = prototype.request_resize;
  if (originalRequestResize) {
    prototype.request_resize = function (width: number, height: number) {
      const nextWidth = Math.round(width);
      const nextHeight = Math.round(height);

      if (nextWidth < 32 || nextHeight < 32) {
        return;
      }

      const previous = this.__pyodideLastResize__;
      if (previous && previous[0] === nextWidth && previous[1] === nextHeight) {
        return;
      }

      if (this.__pyodideInitialResizeLocked__) {
        return;
      }

      const websocketCallback = normalizeWorkerCallback(this.ws?.python_onmessage_callback);

      if (!websocketCallback || this.ws?.readyState !== 1) {
        return;
      }

      this.__pyodideLastResize__ = [nextWidth, nextHeight];
      this.__pyodideInitialResizeLocked__ = true;
      originalRequestResize.call(this, nextWidth, nextHeight);
    };
  }

  Figure.__pyodideCompatPatched__ = true;
  return Figure;
}

function installObjectCompat(mpl: MplGlobal) {
  if (mpl.__pyodideCompatPatched__) {
    return mpl;
  }

  let figureConstructor = mpl.figure;
  let websocketFactory = mpl.get_websocket_type;

  Object.defineProperty(mpl, "toolbar_image_callback", {
    configurable: true,
    enumerable: true,
    get() {
      return (image: string) => createToolbarImageProxy(image);
    },
    set() {
      // Keep the local compatibility callback.
    },
  });

  Object.defineProperty(mpl, "set_toolbar_image_callback", {
    configurable: true,
    enumerable: true,
    get() {
      return () => {};
    },
    set() {
      // Keep the local compatibility callback.
    },
  });

  Object.defineProperty(mpl, "get_websocket_type", {
    configurable: true,
    enumerable: true,
    get() {
      const createWebSocket = websocketFactory;
      if (!createWebSocket) {
        return undefined;
      }

      return () => patchWebSocketType(createWebSocket());
    },
    set(value) {
      websocketFactory = value as typeof websocketFactory;
    },
  });

  Object.defineProperty(mpl, "figure", {
    configurable: true,
    enumerable: true,
    get() {
      if (!figureConstructor) {
        return undefined;
      }

      return patchFigureConstructor(figureConstructor);
    },
    set(value) {
      figureConstructor = value as typeof figureConstructor;
    },
  });

  mpl.__pyodideCompatPatched__ = true;
  return mpl;
}

export function installMatplotlibCompat() {
  if (typeof window === "undefined") {
    return;
  }

  const typedWindow = window as WindowWithMatplotlibCompat;
  if (typedWindow.__pyodideMatplotlibCompatInstalled__) {
    if (typedWindow.mpl) {
      installObjectCompat(typedWindow.mpl);
    }
    return;
  }

  typedWindow.__pyodideMatplotlibCompatInstalled__ = true;

  let currentMpl = typedWindow.mpl ? installObjectCompat(typedWindow.mpl) : undefined;

  Object.defineProperty(window, "mpl", {
    configurable: true,
    enumerable: true,
    get() {
      return currentMpl;
    },
    set(value) {
      if (value && typeof value === "object") {
        currentMpl = installObjectCompat(value as MplGlobal);
        return;
      }

      currentMpl = value as MplGlobal | undefined;
    },
  });
}

export function setMatplotlibToolbarIcons(toolbarIcons: Record<string, string> | null | undefined) {
  providedToolbarIconDataUrls.clear();

  if (!toolbarIcons || typeof toolbarIcons !== "object") {
    return;
  }

  for (const [image, dataUrl] of Object.entries(toolbarIcons)) {
    if (!image || typeof dataUrl !== "string" || dataUrl.length === 0) {
      continue;
    }

    providedToolbarIconDataUrls.set(image, dataUrl);
    iconDataUrlCache.delete(image);
    iconByteCache.delete(image);
  }
}
