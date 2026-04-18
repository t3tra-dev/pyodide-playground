import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { startCompletion } from "@codemirror/autocomplete";
import { forEachDiagnostic } from "@codemirror/lint";
import "./index.css";
import Sidebar from "./components/Sidebar";
import { useCodeMirrorEditor } from "./hooks/useCodeMirrorEditor";
import { usePythonLanguageService } from "./hooks/usePythonLanguageService";
import {
  asyncRunMainFile,
  collectTyEnvironment,
  enableExperimentalSdlSupport,
  ensureMatplotlibBridgePatched,
  initializePyodide,
  isPyodideReady,
  type InstalledPythonPackage,
  loadPackages,
  type PyodideExecutionTrace,
  resetMatplotlibFigures,
  resetSdlState,
  setLogCallback,
  setStdinRequestCallback,
  setStatusCallback,
  syncVirtualFile,
} from "./pyodideApi";
import { PYTHON_MAIN_FILE_PATH } from "./pythonWorkspace";
import { TerminalBuffer, type TerminalStreamType } from "./terminalOutput";

interface CodeSample {
  label: string;
  code: string;
}

function parsePackageSpecs(input: string) {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getRequirementName(spec: string) {
  const match = spec.trim().match(/^[A-Za-z0-9._-]+/);
  return match ? match[0].toLowerCase().replace(/_/g, "-") : "";
}

function trimSingleTrailingLineBreak(value: string) {
  return value.replace(/\r?\n$/, "");
}

type StreamOutputState = {
  buffer: TerminalBuffer;
  content: HTMLDivElement;
  element: HTMLDivElement;
  type: TerminalStreamType;
};

type PlaygroundDevApi = {
  clearOutput: () => void;
  collectTyEnvironment: (packages: string[]) => Promise<unknown>;
  focusEditor: () => void;
  getCode: () => string;
  getEditorDiagnostics: () => Array<{
    from: number;
    line: number;
    message: string;
    severity?: string;
    to: number;
  }>;
  getTyHoverProfiles: () => Promise<unknown>;
  getHoverText: (
    query: string,
    occurrence?: number,
    offsetWithinMatch?: number,
  ) => Promise<string | null>;
  getOutputLines: () => string[];
  getOutputText: () => string;
  getStatus: () => {
    isRunning: boolean;
    pyodideLoaded: boolean;
    statusMessage: string;
  };
  loadPackages: (packages: string[]) => Promise<void>;
  run: () => Promise<void>;
  selectSample: (label: string) => void;
  setCode: (code: string) => void;
  setCursorOffset: (offset: number, head?: number) => void;
  triggerCompletion: () => void;
  waitForIdle: (timeoutMs?: number) => Promise<void>;
  waitForTyReady: (timeoutMs?: number) => Promise<void>;
  waitForPyodideReady: (timeoutMs?: number) => Promise<void>;
};

declare global {
  interface Window {
    __playground__?: PlaygroundDevApi;
  }
}

type PyodideDocument = Document & {
  pyodideMplTarget?: HTMLElement | null;
  pyodideSdlTarget?: HTMLCanvasElement | null;
};

const INITIAL_EDITOR_VALUE = `print("Hello, Pyodide!")\n`;

const CODE_SAMPLES: CodeSample[] = [
  {
    label: "Hello World",
    code: 'print("Hello, World!")\n',
  },
  {
    label: "NumPy sample",
    code: "import numpy as np\narr = np.array([1, 2, 3])\nprint(arr * 2)\n",
  },
  {
    label: "DOM sample",
    code: `from typing import cast
from js import HTMLElement, console, document, window

output = document.querySelector(".output")

if output is None:
    raise RuntimeError("'.output' element was not found")

card = document.createElement("div")
card.classList.add("info")
card.style.borderLeft = "4px solid #16a34a"
card.style.padding = "10px 12px"
card.style.marginBottom = "8px"
card.textContent = f"path={window.location.pathname}"
output.appendChild(card)

for label in ("alpha", "beta", "gamma"):
    child = document.createElement("div")
    child.classList.add("log")
    child.textContent = f"item:{label}"
    card.appendChild(child)

transient = document.createElement("div")
transient.textContent = "remove me"
card.appendChild(transient)
transient.remove()

for child in card.children:
    typed_child = cast(HTMLElement, child)
    typed_child.style.color = "#dbeafe"
    typed_child.style.paddingLeft = "10px"
    typed_child.style.borderLeft = "3px solid #60a5fa"

response = await window.fetch("data:text/plain,bridge-ok")
text = await response.text()

console.log("bridge fetch text", text, "href", window.location.href)
print(f"child_count={card.children.length}, fetched={text}")\n`,
  },
  {
    label: "Matplotlib sample",
    code: 'import matplotlib\nimport matplotlib.pyplot as plt\nimport numpy as np\nx = np.linspace(0, 2 * np.pi, 100)\ny = np.sin(x)\n\nplt.figure(figsize=(8, 6))\nplt.plot(x, y)\nplt.title("Sin Wave")\nplt.grid(True)\nplt.show()\n',
  },
  {
    label: "Pygame sample",
    code: `import pygame

pygame.init()
screen = pygame.display.set_mode((320, 180))
screen.fill((20, 24, 32))
pygame.draw.rect(screen, (239, 68, 68), pygame.Rect(24, 24, 96, 56))
pygame.draw.circle(screen, (96, 165, 250), (220, 90), 36)
pygame.display.flip()
print(f"surface={screen.get_size()}")
pygame.quit()\n`,
  },
];

function App() {
  const [pyodideLoaded, setPyodideLoaded] = useState(isPyodideReady());
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isInstallingPackage, setIsInstallingPackage] = useState(false);
  const [installedPackages, setInstalledPackages] = useState<InstalledPythonPackage[]>([]);
  const [packageInput, setPackageInput] = useState("");
  const [packageStatusMessage, setPackageStatusMessage] = useState("");
  const [packageStatusType, setPackageStatusType] = useState<"info" | "error">("info");
  const [statusMessage, setStatusMessage] = useState<string>("Loading...");
  const currentEditorValueRef = useRef<string>(INITIAL_EDITOR_VALUE);
  const outputRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const outputContainerRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startPosRef = useRef(0);
  const startHeightsRef = useRef({ editor: 0, output: 0 });
  const loggerRef = useRef<HTMLDivElement | null>(null);
  const activeStreamOutputRef = useRef<StreamOutputState | null>(null);
  const adjustLayoutRef = useRef<() => void>(() => {});
  const matplotlibTargetsRef = useRef<Set<HTMLDivElement>>(new Set());
  const manualMatplotlibTargetRef = useRef<HTMLElement | null>(null);
  const matplotlibAutoTargetEnabledRef = useRef(false);
  const hadMatplotlibOutputRef = useRef(false);
  const sdlTargetsRef = useRef<Set<HTMLDivElement>>(new Set());
  const manualSdlTargetRef = useRef<HTMLCanvasElement | null>(null);
  const autoSdlTargetRef = useRef<HTMLCanvasElement | null>(null);
  const sdlAutoTargetEnabledRef = useRef(false);
  const hadSdlOutputRef = useRef(false);
  const pyodideSyncTimerRef = useRef<number | null>(null);
  const tyBaseEnvironmentReadyRef = useRef(false);
  const mirroredPyodidePackagesRef = useRef<Set<string>>(new Set());
  const isRunningStateRef = useRef(false);
  const pyodideLoadedRef = useRef(pyodideLoaded);
  const statusMessageRef = useRef(statusMessage);
  const matplotlibTraceCounterRef = useRef(1);
  const activeMatplotlibTraceRef = useRef<PyodideExecutionTrace | null>(null);
  const pythonLanguageService = usePythonLanguageService(INITIAL_EDITOR_VALUE);

  const logMatplotlibTrace = useCallback(
    (trace: PyodideExecutionTrace | null | undefined, label: string, detail?: unknown) => {
      if (!trace) {
        return;
      }

      const prefix = `[matplotlib-trace #${trace.id} +${Math.max(
        0,
        Date.now() - trace.startedAtMs,
      )}ms]`;
      if (detail === undefined) {
        console.info(`${prefix} ${label}`);
        return;
      }

      console.info(`${prefix} ${label}`, detail);
    },
    [],
  );

  const scrollOutputToBottom = useCallback(() => {
    if (!loggerRef.current) {
      return;
    }

    loggerRef.current.scrollTop = loggerRef.current.scrollHeight;
  }, []);

  const ensureStreamOutputState = useCallback((type: TerminalStreamType) => {
    if (!loggerRef.current) {
      return null;
    }

    let streamState = activeStreamOutputRef.current;
    if (!streamState || streamState.type !== type) {
      const element = document.createElement("div");
      element.className = `terminal-block ${type}`;
      element.dataset.streamType = type;
      const content = document.createElement("div");
      content.className = "terminal-screen";
      element.appendChild(content);
      loggerRef.current.appendChild(element);
      streamState = {
        buffer: new TerminalBuffer(),
        content,
        element,
        type,
      };
      activeStreamOutputRef.current = streamState;
    }

    return streamState;
  }, []);

  const resetOutput = useCallback(() => {
    activeStreamOutputRef.current = null;
    loggerRef.current?.replaceChildren();
  }, []);

  const appendStreamOutput = useCallback(
    (message: string, type: TerminalStreamType) => {
      if (!loggerRef.current || message.length === 0) {
        return;
      }

      const streamState = ensureStreamOutputState(type);
      if (!streamState) {
        return;
      }

      streamState.buffer.write(message);
      streamState.buffer.render(streamState.content);
      scrollOutputToBottom();
    },
    [ensureStreamOutputState, scrollOutputToBottom],
  );

  const requestTerminalInput = useCallback(() => {
    if (!loggerRef.current) {
      return Promise.resolve<string | null>("");
    }

    const streamState = ensureStreamOutputState("stdout");
    if (!streamState) {
      return Promise.resolve<string | null>("");
    }

    return new Promise<string | null>((resolve) => {
      const inputHost = document.createElement("span");
      inputHost.className = "stdin-host";

      const input = document.createElement("input");
      input.className = "stdin-input";
      input.type = "text";
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.spellcheck = false;

      const submit = () => {
        const value = input.value;
        streamState.buffer.write(value);
        streamState.buffer.write("\n");
        streamState.buffer.render(streamState.content);
        activeStreamOutputRef.current = streamState;
        scrollOutputToBottom();
        resolve(value);
      };

      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
          return;
        }

        event.preventDefault();
        submit();
      });

      inputHost.appendChild(input);
      streamState.buffer.render(streamState.content, { inputHost });
      requestAnimationFrame(() => {
        input.focus();
      });
      scrollOutputToBottom();
    });
  }, [ensureStreamOutputState, scrollOutputToBottom]);

  const syncTyEnvironment = useCallback(
    async (packages: string[] = []) => {
      const normalizedPackages = Array.from(
        new Set(packages.map((packageName) => String(packageName)).filter(Boolean)),
      );
      const shouldSyncBaseEnvironment = !tyBaseEnvironmentReadyRef.current;
      const packagesToMirror = normalizedPackages.filter(
        (packageName) => !mirroredPyodidePackagesRef.current.has(packageName),
      );

      if (!shouldSyncBaseEnvironment && packagesToMirror.length === 0) {
        return;
      }

      const packagesForSnapshot = shouldSyncBaseEnvironment ? normalizedPackages : packagesToMirror;
      const snapshot = await collectTyEnvironment(packagesForSnapshot);
      await pythonLanguageService.syncEnvironment(snapshot);
      packagesToMirror.forEach((packageName) => {
        mirroredPyodidePackagesRef.current.add(packageName);
      });
      tyBaseEnvironmentReadyRef.current = true;
    },
    [pythonLanguageService],
  );

  const clearMatplotlibTargets = useCallback(() => {
    manualMatplotlibTargetRef.current = null;
    matplotlibAutoTargetEnabledRef.current = false;

    for (const target of matplotlibTargetsRef.current) {
      if (target.parentNode) {
        target.parentNode.removeChild(target);
      }
    }

    matplotlibTargetsRef.current.clear();
  }, []);

  const clearSdlTargets = useCallback(() => {
    manualSdlTargetRef.current = null;
    autoSdlTargetRef.current = null;
    sdlAutoTargetEnabledRef.current = false;

    for (const target of sdlTargetsRef.current) {
      if (target.parentNode) {
        target.parentNode.removeChild(target);
      }
    }

    sdlTargetsRef.current.clear();
  }, []);

  const createMatplotlibTarget = useCallback(() => {
    const output = outputRef.current;
    if (!output) {
      return null;
    }

    const target = document.createElement("div");
    target.className = "matplotlib-output-target";
    target.style.display = "block";
    target.style.maxWidth = "100%";
    target.style.overflowX = "auto";
    output.appendChild(target);
    matplotlibTargetsRef.current.add(target);
    hadMatplotlibOutputRef.current = true;
    logMatplotlibTrace(activeMatplotlibTraceRef.current, "matplotlib target created");

    const observer = new MutationObserver(() => {
      if (!target.querySelector(".mpl-figure")) {
        return;
      }

      observer.disconnect();
      logMatplotlibTrace(activeMatplotlibTraceRef.current, "matplotlib figure mounted");
    });
    observer.observe(target, { childList: true, subtree: true });
    return target;
  }, [logMatplotlibTrace]);

  const createSdlTarget = useCallback(() => {
    if (autoSdlTargetRef.current?.isConnected) {
      return autoSdlTargetRef.current;
    }

    const output = outputRef.current;
    if (!output) {
      return null;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "sdl-output-target";
    const canvas = document.createElement("canvas");
    canvas.className = "sdl-canvas";
    canvas.id = "canvas";
    canvas.width = 320;
    canvas.height = 180;
    wrapper.appendChild(canvas);
    output.appendChild(wrapper);
    sdlTargetsRef.current.add(wrapper);
    autoSdlTargetRef.current = canvas;
    hadSdlOutputRef.current = true;
    return canvas;
  }, []);

  useEffect(() => {
    isRunningStateRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    pyodideLoadedRef.current = pyodideLoaded;
  }, [pyodideLoaded]);

  useEffect(() => {
    statusMessageRef.current = statusMessage;
  }, [statusMessage]);

  useEffect(() => {
    const pyodideDocument = document as PyodideDocument;
    const previousMplDescriptor = Object.getOwnPropertyDescriptor(
      pyodideDocument,
      "pyodideMplTarget",
    );
    const previousSdlDescriptor = Object.getOwnPropertyDescriptor(
      pyodideDocument,
      "pyodideSdlTarget",
    );

    Object.defineProperty(pyodideDocument, "pyodideMplTarget", {
      configurable: true,
      get() {
        if (manualMatplotlibTargetRef.current) {
          return manualMatplotlibTargetRef.current;
        }

        if (!matplotlibAutoTargetEnabledRef.current) {
          return null;
        }

        return createMatplotlibTarget();
      },
      set(value) {
        manualMatplotlibTargetRef.current = value instanceof HTMLElement ? value : null;
      },
    });

    Object.defineProperty(pyodideDocument, "pyodideSdlTarget", {
      configurable: true,
      get() {
        if (manualSdlTargetRef.current) {
          return manualSdlTargetRef.current;
        }

        if (!sdlAutoTargetEnabledRef.current) {
          return null;
        }

        return createSdlTarget();
      },
      set(value) {
        manualSdlTargetRef.current = value instanceof HTMLCanvasElement ? value : null;
      },
    });

    return () => {
      clearMatplotlibTargets();
      clearSdlTargets();
      if (previousMplDescriptor) {
        Object.defineProperty(pyodideDocument, "pyodideMplTarget", previousMplDescriptor);
      } else {
        delete pyodideDocument.pyodideMplTarget;
      }
      if (previousSdlDescriptor) {
        Object.defineProperty(pyodideDocument, "pyodideSdlTarget", previousSdlDescriptor);
      } else {
        delete pyodideDocument.pyodideSdlTarget;
      }
    };
  }, [clearMatplotlibTargets, clearSdlTargets, createMatplotlibTarget, createSdlTarget]);

  useEffect(() => {
    return () => {
      if (pyodideSyncTimerRef.current !== null) {
        window.clearTimeout(pyodideSyncTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setPyodideLoaded(isPyodideReady());

    if (outputRef.current) {
      loggerRef.current = outputRef.current;

      setLogCallback((message: string, type: TerminalStreamType) => {
        appendStreamOutput(message, type);
      });
      setStdinRequestCallback(requestTerminalInput);

      setStatusCallback((status) => {
        switch (status) {
          case "loading":
            setStatusMessage("Loading Pyodide...");
            setPyodideLoaded(false);
            break;
          case "ready":
            setStatusMessage("Pyodide is ready!");
            setPyodideLoaded(true);
            setLoadingError(null);
            break;
          case "error":
            setStatusMessage("An error occurred while loading Pyodide.");
            setPyodideLoaded(false);
            setLoadingError("Failed to load Pyodide.");
            break;
        }
      });

      void initializePyodide()
        .then(async () => {
          await pythonLanguageService.start(currentEditorValueRef.current);
          tyBaseEnvironmentReadyRef.current = true;
        })
        .catch((error) => {
          console.error("Failed to initialize ty environment", error);
        });
    }

    adjustLayout();

    const handleResize = () => {
      adjustLayoutRef.current();
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [appendStreamOutput, requestTerminalInput, syncTyEnvironment]);

  const {
    editor,
    focus: focusEditor,
    requestMeasure: requestEditorMeasure,
    setCursorOffset,
    setValue: setEditorCode,
    view: editorViewRef,
  } = useCodeMirrorEditor({
    extensions: [pythonLanguageService.extension],
    onChange: (value) => {
      currentEditorValueRef.current = value;

      void pythonLanguageService.syncDocument(value).catch((error) => {
        console.error("Failed to synchronize ty document", error);
      });

      if (pyodideSyncTimerRef.current !== null) {
        window.clearTimeout(pyodideSyncTimerRef.current);
      }

      pyodideSyncTimerRef.current = window.setTimeout(() => {
        if (!isPyodideReady()) {
          return;
        }

        void syncVirtualFile(PYTHON_MAIN_FILE_PATH, value).catch((error) => {
          console.warn("Failed to synchronize Pyodide main.py", error);
        });
      }, 120);
    },
    onRun: () => {
      void runCode();
    },
    value: INITIAL_EDITOR_VALUE,
  });

  const adjustLayout = useCallback(() => {
    if (!containerRef.current || !editorContainerRef.current || !outputContainerRef.current) {
      return;
    }

    const windowHeight = window.innerHeight;
    const containerRect = containerRef.current.getBoundingClientRect();
    const headerHeight = containerRect.top;
    const paddingBottom = 20;

    const availableHeight = windowHeight - headerHeight - paddingBottom;

    const editorHeight = availableHeight * 0.7;
    const outputHeight = availableHeight - editorHeight;

    editorContainerRef.current.style.height = `${editorHeight}px`;
    outputContainerRef.current.style.height = `${outputHeight}px`;
    requestEditorMeasure();
  }, [requestEditorMeasure]);

  useEffect(() => {
    adjustLayoutRef.current = adjustLayout;
  }, [adjustLayout]);

  const handleResizeStart = (
    e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>,
  ) => {
    if (!editorContainerRef.current || !outputContainerRef.current) return;

    isDraggingRef.current = true;

    const clientY =
      "touches" in e ? e.touches[0].clientY : (e as React.MouseEvent<HTMLDivElement>).clientY;

    startPosRef.current = clientY;
    startHeightsRef.current = {
      editor: editorContainerRef.current.offsetHeight,
      output: outputContainerRef.current.offsetHeight,
    };

    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("touchmove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
    document.addEventListener("touchend", handleResizeEnd);
  };

  const handleResizeMove = (e: MouseEvent | TouchEvent) => {
    if (
      !isDraggingRef.current ||
      !editorContainerRef.current ||
      !outputContainerRef.current ||
      !containerRef.current
    )
      return;

    const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
    const delta = clientY - startPosRef.current;

    const containerHeight = startHeightsRef.current.editor + startHeightsRef.current.output;

    let newEditorHeight = startHeightsRef.current.editor + delta;
    let newOutputHeight = startHeightsRef.current.output - delta;

    const minHeight = 100;
    if (newEditorHeight < minHeight) {
      newEditorHeight = minHeight;
      newOutputHeight = containerHeight - minHeight;
    } else if (newOutputHeight < minHeight) {
      newOutputHeight = minHeight;
      newEditorHeight = containerHeight - minHeight;
    }

    editorContainerRef.current.style.height = `${newEditorHeight}px`;
    outputContainerRef.current.style.height = `${newOutputHeight}px`;
    requestEditorMeasure();
  };

  const handleResizeEnd = () => {
    isDraggingRef.current = false;
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("touchmove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
    document.removeEventListener("touchend", handleResizeEnd);
  };

  const runCode = useCallback(async () => {
    if (isRunning) return;

    const hadMatplotlibOutput =
      hadMatplotlibOutputRef.current || matplotlibTargetsRef.current.size > 0;
    const hadSdlOutput = hadSdlOutputRef.current || sdlTargetsRef.current.size > 0;

    if (hadMatplotlibOutput) {
      try {
        await resetMatplotlibFigures();
      } catch (error) {
        console.warn("Failed to reset matplotlib state", error);
      }
    }

    if (hadSdlOutput) {
      try {
        await resetSdlState();
      } catch (error) {
        console.warn("Failed to reset SDL state", error);
      }
    }

    clearMatplotlibTargets();
    clearSdlTargets();
    hadMatplotlibOutputRef.current = false;
    hadSdlOutputRef.current = false;

    resetOutput();

    setIsRunning(true);
    const code = currentEditorValueRef.current;
    const usesMatplotlib = /\bmatplotlib\b|plt\.show\s*\(/.test(code);
    const usesSdl = /\bpygame\b|\bSDL\b/.test(code);
    const matplotlibTrace = usesMatplotlib
      ? {
          id: String(matplotlibTraceCounterRef.current++),
          startedAtMs: Date.now(),
        }
      : null;
    activeMatplotlibTraceRef.current = matplotlibTrace;
    matplotlibAutoTargetEnabledRef.current = usesMatplotlib;
    sdlAutoTargetEnabledRef.current = usesSdl;

    try {
      logMatplotlibTrace(matplotlibTrace, "run triggered");
      if (usesSdl) {
        await enableExperimentalSdlSupport();
      }

      if (pyodideSyncTimerRef.current !== null) {
        window.clearTimeout(pyodideSyncTimerRef.current);
        pyodideSyncTimerRef.current = null;
      }

      logMatplotlibTrace(matplotlibTrace, "about to execute main.py", {
        usesMatplotlib,
      });
      const response = await asyncRunMainFile(code, {}, { trace: matplotlibTrace ?? undefined });
      const result = response as any;
      logMatplotlibTrace(matplotlibTrace, "main.py execution completed", {
        hasError: Boolean(result.error),
      });

      if (result.error) {
        appendStreamOutput(trimSingleTrailingLineBreak(String(result.error)), "stderr");
      }
    } catch (err) {
      appendStreamOutput(
        trimSingleTrailingLineBreak(err instanceof Error ? err.message : String(err)),
        "stderr",
      );
    } finally {
      scrollOutputToBottom();
      setIsRunning(false);
    }
  }, [
    appendStreamOutput,
    clearMatplotlibTargets,
    clearSdlTargets,
    isRunning,
    resetOutput,
    scrollOutputToBottom,
    syncTyEnvironment,
  ]);

  const handleLoadPackages = useCallback(
    async (packages: string[]) => {
      const packageSpecs = packages.map((pkg) => String(pkg).trim()).filter(Boolean);
      if (packageSpecs.length === 0) {
        setPackageStatusType("error");
        setPackageStatusMessage("インストールするパッケージ名を入力してください。");
        return;
      }

      setIsInstallingPackage(true);
      setPackageStatusType("info");
      setPackageStatusMessage(`Installing: ${packageSpecs.join(", ")}`);

      const response = await loadPackages(packageSpecs);
      const result = response as any;

      if (result.error) {
        console.error("Failed to load Pyodide packages", result.error);
        setPackageStatusType("error");
        setPackageStatusMessage(String(result.error));
        setIsInstallingPackage(false);
        return;
      }

      const nextInstalledPackages = Array.isArray(result.installedPackages)
        ? result.installedPackages
        : [];
      setInstalledPackages(nextInstalledPackages);

      const updatedPackages =
        Array.isArray(result.newlyInstalledPackages) && result.newlyInstalledPackages.length > 0
          ? result.newlyInstalledPackages.map(String)
          : packageSpecs.map(getRequirementName).filter(Boolean);
      const installedPackageNames = nextInstalledPackages
        .map((pkg: InstalledPythonPackage) => pkg.distributionName)
        .filter(Boolean);
      const packagesToSync =
        installedPackageNames.length > 0 ? installedPackageNames : updatedPackages;

      const requestedPackageNames = packageSpecs.map(getRequirementName).filter(Boolean);
      const touchesMatplotlib =
        requestedPackageNames.includes("matplotlib") ||
        updatedPackages.some(
          (packageName: string) => getRequirementName(packageName) === "matplotlib",
        );

      try {
        if (touchesMatplotlib) {
          await ensureMatplotlibBridgePatched({
            force: updatedPackages.some(
              (packageName: string) => getRequirementName(packageName) === "matplotlib",
            ),
          });
        }

        packagesToSync.forEach((packageName: string) => {
          mirroredPyodidePackagesRef.current.delete(packageName);
        });
        await syncTyEnvironment(packagesToSync);

        setPackageStatusType("info");
        setPackageStatusMessage(
          updatedPackages.length > 0
            ? `Installed: ${updatedPackages.join(", ")}`
            : `Already available: ${packageSpecs.join(", ")}`,
        );
        setPackageInput("");
      } catch (error) {
        console.error("Failed to prepare installed packages for the ty environment", error);
        setPackageStatusType("error");
        setPackageStatusMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setIsInstallingPackage(false);
      }
    },
    [syncTyEnvironment],
  );

  const setEditorValueAndUpdate = useCallback(
    (value: string) => {
      currentEditorValueRef.current = value;
      setEditorCode(value);
      focusEditor();
    },
    [focusEditor, setEditorCode],
  );

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    window.__playground__ = {
      clearOutput: () => {
        resetOutput();
      },
      collectTyEnvironment: async (packages: string[]) => {
        return await collectTyEnvironment(packages);
      },
      getCode: () => currentEditorValueRef.current,
      getEditorDiagnostics: () => {
        const view = editorViewRef.current;
        if (!view) {
          return [];
        }

        const diagnostics: Array<{
          from: number;
          line: number;
          message: string;
          severity?: string;
          to: number;
        }> = [];
        forEachDiagnostic(view.state, (diagnostic, from, to) => {
          diagnostics.push({
            from,
            line: view.state.doc.lineAt(from).number,
            message: diagnostic.message,
            severity: diagnostic.severity,
            to,
          });
        });
        return diagnostics;
      },
      getTyHoverProfiles: async () => {
        return await pythonLanguageService.getHoverProfiles();
      },
      getHoverText: async (query: string, occurrence = 0, offsetWithinMatch = 0) => {
        if (!query) {
          throw new Error("Query must not be empty");
        }

        let fromIndex = 0;
        let foundIndex = -1;
        for (let index = 0; index <= occurrence; index++) {
          foundIndex = currentEditorValueRef.current.indexOf(query, fromIndex);
          if (foundIndex === -1) {
            throw new Error(`Query not found in editor content: ${query}`);
          }
          fromIndex = foundIndex + query.length;
        }

        return await pythonLanguageService.getHoverAtOffset(foundIndex + offsetWithinMatch);
      },
      getOutputLines: () =>
        Array.from(outputRef.current?.children ?? []).map((child) => child.textContent ?? ""),
      getOutputText: () =>
        Array.from(outputRef.current?.children ?? [])
          .map((child) => child.textContent ?? "")
          .join("\n"),
      getStatus: () => ({
        isRunning: isRunningStateRef.current,
        pyodideLoaded: pyodideLoadedRef.current,
        statusMessage: statusMessageRef.current,
      }),
      loadPackages: async (packages: string[]) => {
        await handleLoadPackages(packages);
      },
      run: async () => {
        await runCode();
      },
      selectSample: (label: string) => {
        const sample = CODE_SAMPLES.find((entry) => entry.label === label);
        if (!sample) {
          throw new Error(`Unknown code sample: ${label}`);
        }

        setEditorValueAndUpdate(sample.code);
      },
      setCode: (code: string) => {
        setEditorValueAndUpdate(code);
      },
      setCursorOffset: (offset: number, head = offset) => {
        setCursorOffset(offset, head);
      },
      triggerCompletion: () => {
        if (editorViewRef.current) {
          startCompletion(editorViewRef.current);
          editorViewRef.current.focus();
        }
      },
      waitForIdle: async (timeoutMs = 30000) => {
        const startedAt = Date.now();
        while (isRunningStateRef.current) {
          if (Date.now() - startedAt > timeoutMs) {
            throw new Error("Timed out waiting for code execution to finish");
          }

          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
      },
      waitForTyReady: async (timeoutMs = 30000) => {
        const startedAt = Date.now();
        while (!tyBaseEnvironmentReadyRef.current) {
          if (Date.now() - startedAt > timeoutMs) {
            throw new Error("Timed out waiting for ty environment to become ready");
          }

          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
      },
      waitForPyodideReady: async (timeoutMs = 30000) => {
        const startedAt = Date.now();
        while (!pyodideLoadedRef.current) {
          if (Date.now() - startedAt > timeoutMs) {
            throw new Error("Timed out waiting for Pyodide to become ready");
          }

          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
      },
      focusEditor: () => {
        editorViewRef.current?.focus();
      },
    };

    return () => {
      delete window.__playground__;
    };
  }, [handleLoadPackages, pythonLanguageService, runCode, setEditorValueAndUpdate]);

  const sidebarContent = useMemo(
    () => (
      <div className="sidebar-menu">
        <h4>Code Samples</h4>
        <ul className="sample-list" data-testid="sample-list">
          {CODE_SAMPLES.map((sample) => (
            <li
              key={sample.label}
              onClick={() => setEditorValueAndUpdate(sample.code)}
              data-sample-label={sample.label}
              data-testid={`sample-${sample.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
            >
              {sample.label}
            </li>
          ))}
        </ul>

        <h4>Package Loader</h4>
        <div className="package-loader">
          <div className="package-form">
            <input
              className="package-input"
              type="text"
              value={packageInput}
              onChange={(event) => setPackageInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                void handleLoadPackages(parsePackageSpecs(packageInput));
              }}
              placeholder="e.g. numpy, matplotlib, pygame-ce"
              disabled={!pyodideLoaded || isRunning || isInstallingPackage}
              data-testid="package-input"
            />
            <button
              onClick={() => void handleLoadPackages(parsePackageSpecs(packageInput))}
              disabled={!pyodideLoaded || isRunning || isInstallingPackage}
              className="package-install-button"
              data-testid="package-install-button"
            >
              {isInstallingPackage ? "Installing..." : "Install"}
            </button>
          </div>
          <p
            className={`package-status ${packageStatusType === "error" ? "error" : ""}`}
            data-testid="package-status"
          >
            {packageStatusMessage}
          </p>
          <div className="installed-packages-panel" data-testid="installed-packages-panel">
            {installedPackages.length === 0 ? (
              <div className="installed-packages-empty">
                No packages installed via the package loader yet.
              </div>
            ) : (
              <ul className="installed-package-list">
                {installedPackages.map((pkg) => (
                  <li
                    key={`${pkg.distributionName}@${pkg.version}`}
                    className="installed-package-item"
                  >
                    <span className="installed-package-name">{pkg.distributionName}</span>
                    <span className="installed-package-version">{pkg.version}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <h4>Pyodide State</h4>
        <div className="sidebar-info">
          <p data-testid="status-message">Status: {statusMessage}</p>
          <p>
            LSP: <code>ty</code> on <code>file:///main.py</code>
          </p>
        </div>
      </div>
    ),
    [
      handleLoadPackages,
      installedPackages,
      isInstallingPackage,
      isRunning,
      packageInput,
      packageStatusMessage,
      packageStatusType,
      pyodideLoaded,
      setEditorValueAndUpdate,
      statusMessage,
    ],
  );

  return (
    <div className="root-container">
      <Sidebar title="Menu">{sidebarContent}</Sidebar>
      <div className="app-container" ref={containerRef}>
        <h1 className="app-header">
          Pyodide Playground{" "}
          <span className="what-is" onClick={() => setShowDialog(true)}>
            What is Pyodide?
          </span>
        </h1>
        <div className="layout-container">
          <div className="editor-with-button-container" ref={editorContainerRef}>
            <div className="editor-container">
              <div ref={editor} className="code-editor" data-testid="editor"></div>
            </div>
            <button
              className="run-button"
              onClick={runCode}
              disabled={!pyodideLoaded || isRunning}
              type="button"
              data-testid="run-button"
            >
              {isRunning ? "Running..." : pyodideLoaded ? "▶ Run" : statusMessage}
            </button>
          </div>

          {/* リサイズするやつ */}
          <div
            className="resize-handle"
            ref={resizeHandleRef}
            onMouseDown={handleResizeStart}
            onTouchStart={handleResizeStart}
          >
            <div className="resize-handle-line"></div>
          </div>

          <div className="output-container" ref={outputContainerRef}>
            {loadingError && (
              <div className="error-message" data-testid="loading-error">
                Failed to load Pyodide: {loadingError}
              </div>
            )}
            <div ref={outputRef} className="output" data-testid="output"></div>
          </div>
        </div>
      </div>

      {showDialog && (
        <div className="dialog-overlay">
          <div className="dialog">
            <div className="dialog-header">
              <h2>What is Pyodide?</h2>
              <button className="close-button" onClick={() => setShowDialog(false)}>
                ×
              </button>
            </div>
            <div className="dialog-content">
              <p>
                Pyodide is a Python distribution for the browser and Node.js based on WebAssembly.
              </p>
              <p>It allows you to:</p>
              <ul>
                <li>Run Python code in the browser with full access to the browser's Web APIs</li>
                <li>Install pure Python packages from PyPI</li>
                <li>Seamlessly convert between Python and JavaScript data types</li>
                <li>
                  Use scientific packages like numpy, pandas, matplotlib, scikit-learn, and more
                </li>
              </ul>
              <p>
                Pyodide makes the Python scientific stack available in the browser, enabling data
                science and scientific computing without server-side processing.
              </p>
              <p>
                Learn more at{" "}
                <a href="https://pyodide.org" target="_blank" rel="noopener noreferrer">
                  pyodide.org
                </a>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
