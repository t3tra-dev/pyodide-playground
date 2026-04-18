import { useCallback, useEffect, useRef } from "react";
import { EditorSelection, type Extension, EditorState } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
} from "@codemirror/commands";
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionStatus,
  completionKeymap,
  hasNextSnippetField,
  nextSnippetField,
} from "@codemirror/autocomplete";
import { python } from "@codemirror/lang-python";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";

interface UseCodeMirrorEditorProps {
  extensions?: Extension[];
  onChange?: (value: string) => void;
  onRun?: () => void;
  value?: string;
}

const PYTHON_INDENT = " ".repeat(4);
const PYTHON_INDENT_SIZE = PYTHON_INDENT.length;

export function insertPythonSoftTab(view: EditorView) {
  const { state } = view;

  if (state.facet(EditorState.readOnly)) {
    return false;
  }

  if (state.selection.ranges.some((range) => !range.empty)) {
    return indentMore(view);
  }

  const mainSelection = state.selection.main;
  const currentLine = state.doc.lineAt(mainSelection.from);
  const linePrefix = currentLine.text.slice(0, mainSelection.from - currentLine.from);

  if (/^\s*$/.test(linePrefix)) {
    return indentMore(view);
  }

  const changes = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    const column = range.from - line.from;
    const remainder = column % PYTHON_INDENT_SIZE;
    const indentWidth = remainder === 0 ? PYTHON_INDENT_SIZE : PYTHON_INDENT_SIZE - remainder;
    const insert = " ".repeat(indentWidth);

    return {
      changes: {
        from: range.from,
        to: range.to,
        insert,
      },
      range: EditorSelection.cursor(range.from + indentWidth),
    };
  });

  view.dispatch(changes);
  return true;
}

function handlePythonTab(view: EditorView) {
  const status = completionStatus(view.state);
  if (status === "active" || status === "pending") {
    return acceptCompletion(view);
  }

  if (hasNextSnippetField(view.state)) {
    return nextSnippetField(view);
  }

  return insertPythonSoftTab(view);
}

export function useCodeMirrorEditor(props: UseCodeMirrorEditorProps) {
  const editor = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const isEditorFocusedRef = useRef(false);
  const latestOnChangeRef = useRef(props.onChange);
  const latestExtensionsRef = useRef(props.extensions ?? []);
  const latestOnRunRef = useRef(props.onRun);
  const latestValueRef = useRef(props.value ?? "");

  useEffect(() => {
    latestOnChangeRef.current = props.onChange;
  }, [props.onChange]);

  useEffect(() => {
    latestExtensionsRef.current = props.extensions ?? [];
  }, [props.extensions]);

  useEffect(() => {
    latestOnRunRef.current = props.onRun;
  }, [props.onRun]);

  useEffect(() => {
    latestValueRef.current = props.value ?? "";

    const view = viewRef.current;
    if (!view) {
      return;
    }

    const nextValue = props.value ?? "";
    const currentValue = view.state.doc.toString();
    if (currentValue === nextValue) {
      return;
    }

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: nextValue,
      },
    });
  }, [props.value]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (!isEditorFocusedRef.current) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        latestOnRunRef.current?.();
      }
    };

    window.addEventListener("keydown", handleWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown, true);
    };
  }, []);

  useEffect(() => {
    const parent = editor.current;
    if (!parent || viewRef.current) {
      return;
    }

    const view = new EditorView({
      state: EditorState.create({
        doc: latestValueRef.current,
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          EditorState.tabSize.of(PYTHON_INDENT_SIZE),
          indentUnit.of(PYTHON_INDENT),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          highlightActiveLine(),
          history(),
          foldGutter(),
          lintGutter(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({
            interactionDelay: 0,
          }),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.domEventHandlers({
            keydown: (event, _eventView) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                latestOnRunRef.current?.();
                return true;
              }

              return false;
            },
            focus: () => {
              isEditorFocusedRef.current = true;
            },
            blur: () => {
              isEditorFocusedRef.current = false;
            },
          }),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                latestOnRunRef.current?.();
                return true;
              },
            },
            {
              key: "Tab",
              run: handlePythonTab,
            },
            {
              key: "Shift-Tab",
              run: indentLess,
            },
            {
              key: "Enter",
              run: insertNewlineAndIndent,
            },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...foldKeymap,
            ...lintKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          python(),
          oneDark,
          ...latestExtensionsRef.current,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) {
              return;
            }

            const nextValue = update.state.doc.toString();
            latestValueRef.current = nextValue;
            latestOnChangeRef.current?.(nextValue);
          }),
        ],
      }),
      parent,
    });

    viewRef.current = view;

    return () => {
      isEditorFocusedRef.current = false;
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  const setValue = useCallback((value: string) => {
    latestValueRef.current = value;

    const view = viewRef.current;
    if (!view) {
      return;
    }

    const currentValue = view.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  }, []);

  const getValue = useCallback(() => {
    return viewRef.current?.state.doc.toString() ?? latestValueRef.current;
  }, []);

  const focus = useCallback(() => {
    viewRef.current?.focus();
  }, []);

  const setCursorOffset = useCallback((offset: number, head = offset) => {
    const view = viewRef.current;
    if (!view) {
      return;
    }

    const documentLength = view.state.doc.length;
    const anchor = Math.max(0, Math.min(offset, documentLength));
    const selectionHead = Math.max(0, Math.min(head, documentLength));

    view.dispatch({
      selection: {
        anchor,
        head: selectionHead,
      },
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  const requestMeasure = useCallback(() => {
    viewRef.current?.requestMeasure();
  }, []);

  return {
    editor,
    focus,
    getValue,
    requestMeasure,
    setCursorOffset,
    setValue,
    view: viewRef,
  };
}
