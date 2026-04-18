import { PYTHON_MAIN_FILE_URI } from "../pythonWorkspace";
import { lspPositionToOffset, offsetToLspPosition } from "./lspUtils";

type HoverPayload =
  | string
  | {
      kind?: string;
      language?: string;
      value?: string;
    };

type ImportedBinding = {
  importedName: string;
  localName: string;
  moduleName: string;
};

const COMMON_PYTHON_BUILTIN_SYMBOLS = [
  "print",
  "len",
  "range",
  "open",
  "dict",
  "list",
  "set",
  "tuple",
  "str",
  "int",
  "float",
  "bool",
];
const COMMON_PYTHON_BUILTIN_SYMBOL_SET = new Set(COMMON_PYTHON_BUILTIN_SYMBOLS);

export const HOVER_EMPTY_RESULT_RETRY_DELAY_MS = 150;
export const HOVER_EMPTY_RESULT_RETRY_LIMIT = 48;
export const HOVER_EMPTY_RESULT_RETRY_WINDOW_MS = 10000;
export const HOVER_ACTIVE_LSP_SYNC_DEFER_MS = 2500;
export const HOVER_PREFETCH_DELAY_MS = 250;
export const LSP_SYNC_DEBOUNCE_MS = 1000;
export const MAX_STABLE_HOVER_CACHE_ENTRIES = 256;

function formatHoverPayload(payload: HoverPayload) {
  if (typeof payload === "string") {
    return payload;
  }

  if (payload && typeof payload === "object") {
    return payload.value ?? "";
  }

  return "";
}

function normalizeHoverTextForCompletenessCheck(text: string) {
  return text
    .replace(/^```[^\n]*\n?/u, "")
    .replace(/\n?```$/u, "")
    .trim();
}

export function formatHoverResult(result: unknown) {
  if (!result || typeof result !== "object" || !("contents" in result)) {
    return null;
  }

  const contents = (result as { contents?: HoverPayload | HoverPayload[] }).contents;
  if (!contents) {
    return null;
  }

  if (Array.isArray(contents)) {
    const parts = contents.map((entry) => formatHoverPayload(entry)).filter(Boolean);
    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  const formatted = formatHoverPayload(contents);
  return formatted || null;
}

export function isIncompleteImportedHoverText(
  formattedHover: string | null,
  stableHoverCacheKey: string | null,
) {
  if (!formattedHover || !stableHoverCacheKey) {
    return false;
  }

  if (
    !stableHoverCacheKey.startsWith("import:") &&
    !stableHoverCacheKey.startsWith("member:") &&
    !stableHoverCacheKey.startsWith("js:")
  ) {
    return false;
  }

  const normalizedHoverText = normalizeHoverTextForCompletenessCheck(formattedHover);
  return /\bUnknown\b/.test(normalizedHoverText) || normalizedHoverText === "@Todo";
}

export function safeErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }

  try {
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string") {
        return message;
      }

      if (message !== undefined) {
        return String(message);
      }
    }
  } catch {
    return "<uninspectable error>";
  }

  try {
    return String(error);
  } catch {
    return "<uninspectable error>";
  }
}

export function shouldSuppressPassiveLspError(error: unknown) {
  const message = safeErrorMessage(error);
  return (
    message.includes("Permission denied to access object") ||
    message.includes("Ty transport is not ready") ||
    message.includes("Ty worker was disposed") ||
    message.includes("ty transport is not ready") ||
    message.includes("ty worker was disposed") ||
    message.includes("Client not connected") ||
    message.includes("Request timed out")
  );
}

export function shouldSuppressHoverError(error: unknown) {
  return shouldSuppressPassiveLspError(error);
}

export function normalizeLspRequestError(error: unknown) {
  if (error instanceof Error) {
    const safeMessage = safeErrorMessage(error);
    if (safeMessage === error.message) {
      return error;
    }

    const normalizedError = new Error(safeMessage);
    normalizedError.name = error.name || "Error";
    return normalizedError;
  }

  return new Error(safeErrorMessage(error));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findWordOffset(documentText: string, symbol: string) {
  const match = new RegExp(`\\b${escapeRegExp(symbol)}\\b`).exec(documentText);
  return match?.index ?? -1;
}

function extractImportedHoverSymbols(documentText: string) {
  return Array.from(
    new Set(parseImportedBindings(documentText).map((binding) => binding.localName)),
  );
}

function parseImportedBindings(documentText: string) {
  const bindings: ImportedBinding[] = [];

  for (const match of documentText.matchAll(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/gm)) {
    const moduleName = match[1] ?? "";
    const importedClause = match[2] ?? "";
    const sanitizedClause = importedClause.split("#", 1)[0] ?? "";
    for (const segment of sanitizedClause.split(",")) {
      const trimmed = segment.trim();
      if (!trimmed || trimmed === "*") {
        continue;
      }

      const aliasMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(
        trimmed,
      );
      if (!aliasMatch) {
        continue;
      }

      bindings.push({
        importedName: aliasMatch[1],
        localName: aliasMatch[2] ?? aliasMatch[1],
        moduleName,
      });
    }
  }

  for (const match of documentText.matchAll(/^\s*import\s+(.+)$/gm)) {
    const importedClause = match[1] ?? "";
    const sanitizedClause = importedClause.split("#", 1)[0] ?? "";
    for (const segment of sanitizedClause.split(",")) {
      const trimmed = segment.trim();
      if (!trimmed) {
        continue;
      }

      const aliasMatch = /^([A-Za-z_][A-Za-z0-9_.]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(
        trimmed,
      );
      if (!aliasMatch) {
        continue;
      }

      const importedName = aliasMatch[1] ?? "";
      const localName = aliasMatch[2] ?? importedName.split(".", 1)[0] ?? importedName;
      if (!importedName || !localName) {
        continue;
      }

      bindings.push({
        importedName,
        localName,
        moduleName: importedName,
      });
    }
  }

  return bindings;
}

export function getIdentifierAtOffset(documentText: string, offset: number) {
  const safeOffset = Math.max(0, Math.min(offset, documentText.length));
  if (safeOffset < 0 || safeOffset >= documentText.length) {
    return null;
  }
  let start = safeOffset;
  let end = safeOffset;

  const isIdentifierChar = (value: string | undefined) =>
    value !== undefined && /[A-Za-z0-9_]/.test(value);

  if (!isIdentifierChar(documentText[safeOffset])) {
    return null;
  }

  while (start > 0 && isIdentifierChar(documentText[start - 1])) {
    start -= 1;
  }

  while (end < documentText.length && isIdentifierChar(documentText[end])) {
    end += 1;
  }

  if (start === end) {
    return null;
  }

  const text = documentText.slice(start, end);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    return null;
  }

  return { end, start, text };
}

function isBuiltinSymbolShadowed(documentText: string, symbol: string) {
  const escapedSymbol = escapeRegExp(symbol);
  const shadowingPatterns = [
    new RegExp(`(^|\\n)\\s*(?:async\\s+def|def|class)\\s+${escapedSymbol}\\b`),
    new RegExp(`(^|\\n)\\s*${escapedSymbol}\\s*(?::[^=\\n]+)?=`),
    new RegExp(
      `(^|\\n)\\s*(?:import\\s+[^\\n]*\\bas\\s+${escapedSymbol}\\b|from\\s+[^\\n]+\\s+import\\s+[^\\n]*\\b${escapedSymbol}\\b(?:\\s+as\\s+\\w+)?)`,
    ),
    new RegExp(
      `(^|\\n)\\s*(?:for|async\\s+for|with|async\\s+with|except\\*?|match)\\s+${escapedSymbol}\\b`,
    ),
  ];

  return shadowingPatterns.some((pattern) => pattern.test(documentText));
}

function hasConflictingLocalDefinition(documentText: string, symbol: string) {
  const escapedSymbol = escapeRegExp(symbol);
  const conflictingPatterns = [
    new RegExp(`(^|\\n)\\s*(?:async\\s+def|def|class)\\s+${escapedSymbol}\\b`),
    new RegExp(`(^|\\n)\\s*${escapedSymbol}\\s*(?::[^=\\n]+)?=`),
    new RegExp(
      `(^|\\n)\\s*(?:for|async\\s+for|with|async\\s+with|except\\*?|match)\\s+${escapedSymbol}\\b`,
    ),
    new RegExp(
      `(^|\\n)\\s*(?:import\\s+[^\\n]*\\bas\\s+${escapedSymbol}\\b|from\\s+(?!js\\b)[^\\n]+\\s+import\\s+[^\\n]*\\b${escapedSymbol}\\b(?:\\s+as\\s+\\w+)?)`,
    ),
  ];

  return conflictingPatterns.some((pattern) => pattern.test(documentText));
}

function hasConflictingLocalValueDefinition(documentText: string, symbol: string) {
  const escapedSymbol = escapeRegExp(symbol);
  const conflictingPatterns = [
    new RegExp(`(^|\\n)\\s*(?:async\\s+def|def|class)\\s+${escapedSymbol}\\b`),
    new RegExp(`(^|\\n)\\s*${escapedSymbol}\\s*(?::[^=\\n]+)?=`),
    new RegExp(
      `(^|\\n)\\s*(?:for|async\\s+for|with|async\\s+with|except\\*?|match)\\s+${escapedSymbol}\\b`,
    ),
  ];

  return conflictingPatterns.some((pattern) => pattern.test(documentText));
}

function getCacheableBuiltinSymbolAtOffset(documentText: string, offset: number) {
  const identifier = getIdentifierAtOffset(documentText, offset);
  if (!identifier || !COMMON_PYTHON_BUILTIN_SYMBOL_SET.has(identifier.text)) {
    return null;
  }

  if (documentText[identifier.start - 1] === ".") {
    return null;
  }

  if (isBuiltinSymbolShadowed(documentText, identifier.text)) {
    return null;
  }

  return identifier.text;
}

function getCacheableJsImportAtOffset(documentText: string, offset: number) {
  const identifier = getIdentifierAtOffset(documentText, offset);
  if (!identifier) {
    return null;
  }

  if (documentText[identifier.start - 1] === ".") {
    return null;
  }

  const matchingBindings = parseImportedBindings(documentText).filter(
    (binding) => binding.moduleName === "js" && binding.localName === identifier.text,
  );
  if (matchingBindings.length !== 1) {
    return null;
  }

  if (hasConflictingLocalDefinition(documentText, identifier.text)) {
    return null;
  }

  const binding = matchingBindings[0];
  return `js:${binding.importedName}:${binding.localName}`;
}

function getCacheableImportedBindingAtOffset(documentText: string, offset: number) {
  const identifier = getIdentifierAtOffset(documentText, offset);
  if (!identifier) {
    return null;
  }

  if (documentText[identifier.start - 1] === ".") {
    return null;
  }

  const matchingBindings = parseImportedBindings(documentText).filter(
    (binding) => binding.localName === identifier.text,
  );
  if (matchingBindings.length !== 1) {
    return null;
  }

  if (hasConflictingLocalValueDefinition(documentText, identifier.text)) {
    return null;
  }

  const binding = matchingBindings[0];
  return `import:${binding.moduleName}:${binding.importedName}:${binding.localName}`;
}

function getCacheableImportedMemberAccessAtOffset(documentText: string, offset: number) {
  const identifier = getIdentifierAtOffset(documentText, offset);
  if (!identifier || documentText[identifier.start - 1] !== ".") {
    return null;
  }

  let baseStart = identifier.start - 1;
  while (baseStart > 0 && /[A-Za-z0-9_]/.test(documentText[baseStart - 1] ?? "")) {
    baseStart -= 1;
  }
  const baseText = documentText.slice(baseStart, identifier.start - 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(baseText)) {
    return null;
  }

  const matchingBindings = parseImportedBindings(documentText).filter(
    (binding) => binding.localName === baseText,
  );
  if (matchingBindings.length !== 1) {
    return null;
  }

  if (hasConflictingLocalValueDefinition(documentText, baseText)) {
    return null;
  }

  const binding = matchingBindings[0];
  return `member:${binding.moduleName}:${binding.importedName}:${binding.localName}:${identifier.text}`;
}

export function getStableHoverCacheKeyAtOffset(documentText: string, offset: number) {
  return (
    getCacheableBuiltinSymbolAtOffset(documentText, offset) ??
    getCacheableJsImportAtOffset(documentText, offset) ??
    getCacheableImportedMemberAccessAtOffset(documentText, offset) ??
    getCacheableImportedBindingAtOffset(documentText, offset)
  );
}

export function buildHoverRequestCandidateParams(documentText: string, params: unknown) {
  if (!params || typeof params !== "object") {
    return [params];
  }

  const hoverParams = params as {
    position?: { character?: number; line?: number };
    textDocument?: { uri?: string };
  };
  if (hoverParams.textDocument?.uri !== PYTHON_MAIN_FILE_URI || !hoverParams.position) {
    return [params];
  }

  const baseOffset = lspPositionToOffset(documentText, hoverParams.position);
  const identifier = getIdentifierAtOffset(documentText, baseOffset);
  const candidates: unknown[] = [];
  const seenOffsets = new Set<number>();
  const documentLength = documentText.length;
  const addOffset = (offset: number) => {
    const safeOffset = Math.max(0, Math.min(offset, documentLength));
    if (seenOffsets.has(safeOffset)) {
      return;
    }

    seenOffsets.add(safeOffset);
    candidates.push({
      ...hoverParams,
      position: offsetToLspPosition(documentText, safeOffset),
      textDocument: hoverParams.textDocument,
    });
  };
  if (identifier) {
    if (documentText[identifier.start - 1] === ".") {
      return [
        {
          ...hoverParams,
          position: offsetToLspPosition(documentText, identifier.start),
          textDocument: hoverParams.textDocument,
        },
      ];
    }

    addOffset(baseOffset);
    addOffset(identifier.start);
    addOffset(identifier.end - 1);
    return candidates;
  }

  return [
    {
      ...hoverParams,
      position: offsetToLspPosition(documentText, baseOffset),
      textDocument: hoverParams.textDocument,
    },
  ];
}

export function normalizeHoverResultRange(documentText: string, params: unknown, result: unknown) {
  if (!result || typeof result !== "object" || !("contents" in result)) {
    return result;
  }

  const hoverParams = params as {
    position?: { character?: number; line?: number };
    textDocument?: { uri?: string };
  };
  if (hoverParams.textDocument?.uri !== PYTHON_MAIN_FILE_URI || !hoverParams.position) {
    return result;
  }

  const offset = lspPositionToOffset(documentText, hoverParams.position);
  const identifier = getIdentifierAtOffset(documentText, offset);
  if (!identifier) {
    return result;
  }

  return {
    ...(result as Record<string, unknown>),
    range: {
      end: offsetToLspPosition(documentText, identifier.end),
      start: offsetToLspPosition(documentText, identifier.start),
    },
  };
}

export function createCachedHoverResult(documentText: string, offset: number, hoverText: string) {
  const identifier = getIdentifierAtOffset(documentText, offset);
  const result: Record<string, unknown> = {
    contents: {
      kind: "markdown",
      value: hoverText,
    },
  };

  if (!identifier) {
    return result;
  }

  return {
    ...result,
    range: {
      end: offsetToLspPosition(documentText, identifier.end),
      start: offsetToLspPosition(documentText, identifier.start),
    },
  };
}

export function collectHoverPrefetchOffsets(documentText: string) {
  const offsets: number[] = [];
  const seenOffsets = new Set<number>();

  const pushOffset = (offset: number) => {
    if (offset < 0 || seenOffsets.has(offset) || offsets.length >= 3) {
      return;
    }

    seenOffsets.add(offset);
    offsets.push(offset);
  };

  for (const match of documentText.matchAll(
    /\b[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)\b/g,
  )) {
    const memberName = match[1];
    if (!memberName || match.index === undefined) {
      continue;
    }

    pushOffset(match.index + match[0].length - memberName.length);
    if (offsets.length >= 3) {
      return offsets;
    }
  }

  for (const symbol of extractImportedHoverSymbols(documentText)) {
    pushOffset(findWordOffset(documentText, symbol));
    if (offsets.length >= 3) {
      return offsets;
    }
  }

  for (const symbol of COMMON_PYTHON_BUILTIN_SYMBOLS) {
    pushOffset(findWordOffset(documentText, symbol));
    if (offsets.length >= 3) {
      return offsets;
    }
  }

  return offsets;
}
