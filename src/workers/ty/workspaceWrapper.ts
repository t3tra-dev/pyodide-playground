import {
  CompletionKind,
  FileHandle,
  Position,
  Severity,
  Workspace,
} from "../../../.generated/ty-wasm/ty_wasm.js";
import { PYTHON_MAIN_FILE_PATH, type PythonEnvironmentFile } from "../../pythonWorkspace";
import { extractIdentifierAtOffset } from "./sourceParsingUtils";
import { TySourceHoverFallback } from "./sourceHoverFallback";

type PlainPosition = { character: number; line: number };
type PlainRange = { end: PlainPosition; start: PlainPosition };
const NON_HOVERABLE_PYTHON_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

function safeFree(value: { free?: () => void } | null | undefined) {
  try {
    value?.free?.();
  } catch {
    // Ignore stale wasm wrapper frees; we prefer deterministic cleanup over
    // letting FinalizationRegistry trip over invalidated pointers later.
  }
}

function toTyPosition(position?: { character?: number; line?: number }) {
  return new Position((position?.line ?? 0) + 1, (position?.character ?? 0) + 1);
}

function toLspPosition(position: Position): PlainPosition {
  return {
    character: Math.max(0, position.column - 1),
    line: Math.max(0, position.line - 1),
  };
}

function toLspRange(
  range?: ({ end: Position; start: Position } & { free?: () => void }) | null,
): PlainRange | null {
  if (!range) {
    return null;
  }

  const start = range.start;
  const end = range.end;

  try {
    return {
      end: toLspPosition(end),
      start: toLspPosition(start),
    };
  } finally {
    safeFree(start);
    safeFree(end);
    safeFree(range);
  }
}

function completionKindToLspKind(kind?: CompletionKind) {
  if (kind === undefined || kind === null) {
    return 6;
  }

  switch (kind) {
    case CompletionKind.Text:
      return 1;
    case CompletionKind.Method:
      return 2;
    case CompletionKind.Function:
      return 3;
    case CompletionKind.Constructor:
      return 4;
    case CompletionKind.Field:
      return 5;
    case CompletionKind.Variable:
      return 6;
    case CompletionKind.Class:
      return 7;
    case CompletionKind.Interface:
      return 8;
    case CompletionKind.Module:
      return 9;
    case CompletionKind.Property:
      return 10;
    case CompletionKind.Unit:
      return 11;
    case CompletionKind.Value:
      return 12;
    case CompletionKind.Enum:
      return 13;
    case CompletionKind.Keyword:
      return 14;
    case CompletionKind.Snippet:
      return 15;
    case CompletionKind.Color:
      return 16;
    case CompletionKind.File:
      return 17;
    case CompletionKind.Reference:
      return 18;
    case CompletionKind.Folder:
      return 19;
    case CompletionKind.EnumMember:
      return 20;
    case CompletionKind.Constant:
      return 21;
    case CompletionKind.Struct:
      return 22;
    case CompletionKind.Event:
      return 23;
    case CompletionKind.Operator:
      return 24;
    case CompletionKind.TypeParameter:
      return 25;
    default:
      return 6;
  }
}

function severityToLspSeverity(severity: Severity) {
  switch (severity) {
    case Severity.Info:
      return 3;
    case Severity.Warning:
      return 2;
    case Severity.Error:
    case Severity.Fatal:
      return 1;
    default:
      return 3;
  }
}

type EnclosingBlock = {
  async: boolean;
  indent: number;
  kind: "class" | "function" | "other";
};

function isAwaitOutsideAsyncDiagnostic(diagnosticId: string, message: string) {
  const normalizedMessage = message.trim();
  return (
    diagnosticId === "await-outside-async" ||
    normalizedMessage === "`await` should be used within an async function" ||
    normalizedMessage === "`await` outside of an asynchronous function"
  );
}

function findNearestEnclosingBlock(
  sourceText: string,
  targetLineIndex: number,
): EnclosingBlock | null {
  const lines = sourceText.split("\n");
  const stack: EnclosingBlock[] = [];

  for (let lineIndex = 0; lineIndex < Math.min(lines.length, targetLineIndex); lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const indent = getIndentWidth(line);
    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    if (/^async\s+def\s+/u.test(trimmedLine)) {
      stack.push({ async: true, indent, kind: "function" });
      continue;
    }

    if (/^def\s+/u.test(trimmedLine)) {
      stack.push({ async: false, indent, kind: "function" });
      continue;
    }

    if (/^class\s+/u.test(trimmedLine)) {
      stack.push({ async: false, indent, kind: "class" });
      continue;
    }

    if (trimmedLine.endsWith(":")) {
      stack.push({ async: false, indent, kind: "other" });
    }
  }

  const targetLine = lines[Math.max(0, targetLineIndex)] ?? "";
  const targetIndent = getIndentWidth(targetLine);
  while (stack.length > 0 && targetIndent <= stack[stack.length - 1]!.indent) {
    stack.pop();
  }

  for (let index = stack.length - 1; index >= 0; index--) {
    const block = stack[index];
    if (block?.kind === "function" || block?.kind === "class") {
      return block;
    }
  }

  return null;
}

function isNonHoverablePythonKeywordAtOffset(
  sourceText: string,
  position?: { character?: number; line?: number },
) {
  const identifier = extractIdentifierAtOffset(sourceText, position);
  if (!identifier) {
    return false;
  }

  return NON_HOVERABLE_PYTHON_KEYWORDS.has(identifier.identifier);
}

function shouldSuppressPyodideMainDiagnostic(
  sourceText: string,
  diagnosticId: string,
  message: string,
  range: { end: Position; start: Position } | undefined,
) {
  if (!range || !isAwaitOutsideAsyncDiagnostic(diagnosticId, message)) {
    return false;
  }

  const targetLineIndex = Math.max(0, range.start.line - 1);
  const nearestBlock = findNearestEnclosingBlock(sourceText, targetLineIndex);
  if (!nearestBlock) {
    return true;
  }

  return nearestBlock.kind === "function" && nearestBlock.async;
}

function extractMissingWindowMemberName(message: string) {
  const match = message.match(/^Object of type `Window` has no attribute `([^`]+)`$/u);
  return match?.[1] ?? null;
}

function extractMissingMemberDiagnostic(message: string) {
  const match = message.match(/^Object of type `([^`]+)` has no attribute `([^`]+)`$/u);
  if (!match?.[1] || !match?.[2]) {
    return null;
  }

  return {
    memberName: match[2],
    ownerTypeName: match[1],
  };
}

function isKnownBrowserWindowGlobalName(name: string) {
  return (
    name === "document" ||
    name === "window" ||
    name === "self" ||
    name === "globalThis" ||
    /^[A-Z][A-Za-z0-9_]*$/u.test(name)
  );
}

function fileUriToPath(uri: string) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "file:") {
    throw new Error(`Unsupported non-file URI: ${uri}`);
  }

  return decodeURIComponent(parsed.pathname || "/");
}

function getDirectoryPath(path: string) {
  const lastSlashIndex = path.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return "/";
  }

  return path.slice(0, lastSlashIndex);
}

function vendoredUriToPath(uri: string) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "vendored:") {
    throw new Error(`Unsupported vendored URI: ${uri}`);
  }

  const host = parsed.host ? `${parsed.host}` : "";
  const path = decodeURIComponent(parsed.pathname || "");
  return `${host}${path}` || "/";
}

function definitionPathToUri(path: string) {
  if (path.includes("://")) {
    return path;
  }

  if (path.startsWith("/")) {
    return `file://${path}`;
  }

  return `vendored://${path}`;
}

function getIndentWidth(line: string) {
  const match = line.match(/^\s*/u);
  return match?.[0].length ?? 0;
}

export class TyWorkspaceWrapper {
  private readonly fileContents = new Map<string, string>();
  private readonly directoryAnchorHandles = new Map<string, FileHandle>();
  private readonly fileHandles = new Map<string, FileHandle>();
  private readonly sourceHoverFallback: TySourceHoverFallback;
  private readonly vendoredFileHandles = new Map<string, FileHandle>();

  constructor(private readonly workspace: Workspace) {
    this.sourceHoverFallback = new TySourceHoverFallback({
      definitionPathToUri,
      getFileHandles: () => this.getAllFileHandles(),
      getMainHandle: () => this.fileHandles.get(PYTHON_MAIN_FILE_PATH),
      resolveHandleForUri: (uri) => this.resolveHandleForUri(uri),
      safeFree,
      toLspRange,
      toTyPosition,
      workspace: this.workspace,
    });
  }

  updateOptions(options: unknown) {
    this.rebuildOpenFilesAfterOptionsUpdate(options);
  }

  private getAllFileHandles() {
    return new Map([...this.fileHandles, ...this.vendoredFileHandles]);
  }

  private extractExtraPathsFromOptions(options: unknown) {
    const candidate =
      typeof options === "object" &&
      options !== null &&
      "environment" in options &&
      typeof (options as { environment?: unknown }).environment === "object" &&
      (options as { environment?: Record<string, unknown> }).environment !== null
        ? (options as { environment: Record<string, unknown> }).environment["extra-paths"]
        : [];

    return Array.isArray(candidate) ? candidate.map(String).filter(Boolean) : [];
  }

  private getDirectoryAnchorPath(directoryPath: string) {
    return directoryPath === "/"
      ? "/.__ty_directory_anchor__.pyi"
      : `${directoryPath}/.__ty_directory_anchor__.pyi`;
  }

  private resetDirectoryAnchors(directoryPaths: Iterable<string>) {
    for (const handle of this.directoryAnchorHandles.values()) {
      safeFree(handle);
    }
    this.directoryAnchorHandles.clear();

    for (const directoryPath of directoryPaths) {
      const normalizedDirectoryPath = directoryPath.trim();
      if (!normalizedDirectoryPath) {
        continue;
      }

      const anchorPath = this.getDirectoryAnchorPath(normalizedDirectoryPath);
      const handle = this.workspace.openFile(anchorPath, "");
      this.directoryAnchorHandles.set(anchorPath, handle);
    }
  }

  private rebuildOpenFilesAfterOptionsUpdate(options: unknown) {
    const openFiles = Array.from(this.fileContents.entries()).map(([path, content]) => ({
      content,
      path,
    }));
    const requiredDirectories = new Set(this.extractExtraPathsFromOptions(options));
    for (const file of openFiles) {
      requiredDirectories.add(getDirectoryPath(file.path));
    }

    this.resetDirectoryAnchors(requiredDirectories);

    for (const handle of this.fileHandles.values()) {
      try {
        this.workspace.closeFile(handle);
      } catch {
        // Ignore stale-handle close failures; the reload below will rebuild the state anyway.
      }
    }

    this.fileHandles.clear();
    for (const handle of this.vendoredFileHandles.values()) {
      safeFree(handle);
    }
    this.vendoredFileHandles.clear();
    this.workspace.updateOptions(options);
    this.resetDirectoryAnchors(requiredDirectories);

    for (const file of openFiles) {
      const handle = this.workspace.openFile(file.path, file.content);
      this.fileHandles.set(file.path, handle);
    }
  }

  clear() {
    this.fileContents.clear();
    this.fileHandles.clear();
    for (const handle of this.directoryAnchorHandles.values()) {
      safeFree(handle);
    }
    this.directoryAnchorHandles.clear();
    for (const handle of this.vendoredFileHandles.values()) {
      safeFree(handle);
    }
    this.vendoredFileHandles.clear();
  }

  syncFile(path: string, content: string) {
    this.fileContents.set(path, content);
    const existingHandle = this.fileHandles.get(path);

    if (existingHandle) {
      this.workspace.updateFile(existingHandle, content);
      return existingHandle;
    }

    const handle = this.workspace.openFile(path, content);
    this.fileHandles.set(path, handle);
    return handle;
  }

  syncFiles(files: PythonEnvironmentFile[]) {
    for (const file of files) {
      this.syncFile(file.path, file.content);
    }
  }

  collectMainDiagnostics() {
    const mainHandle = this.fileHandles.get(PYTHON_MAIN_FILE_PATH);
    if (!mainHandle) {
      return [];
    }

    const sourceText = this.workspace.sourceText(mainHandle);
    return this.workspace.checkFile(mainHandle).flatMap((diagnostic) => {
      try {
        const range = diagnostic.toRange(this.workspace);
        if (!range) {
          return [];
        }

        const diagnosticId = diagnostic.id();
        const diagnosticMessage = diagnostic.message();
        if (
          shouldSuppressPyodideMainDiagnostic(sourceText, diagnosticId, diagnosticMessage, range)
        ) {
          safeFree(range);
          return [];
        }

        const missingWindowMember = extractMissingWindowMemberName(diagnosticMessage);
        if (
          missingWindowMember &&
          (this.sourceHoverFallback.hasStubMember("Window", missingWindowMember) ||
            isKnownBrowserWindowGlobalName(missingWindowMember))
        ) {
          safeFree(range);
          return [];
        }

        const missingMemberDiagnostic = extractMissingMemberDiagnostic(diagnosticMessage);
        if (
          missingMemberDiagnostic &&
          this.sourceHoverFallback.hasStubMember(
            missingMemberDiagnostic.ownerTypeName,
            missingMemberDiagnostic.memberName,
          )
        ) {
          safeFree(range);
          return [];
        }

        return [
          {
            code: diagnosticId,
            message: diagnosticMessage,
            range: toLspRange(range),
            severity: severityToLspSeverity(diagnostic.severity()),
            source: "ty",
          },
        ];
      } finally {
        safeFree(diagnostic);
      }
    });
  }

  hover(uri: string, position?: { character?: number; line?: number }) {
    const handle = this.resolveHandleForUri(uri);
    const sourceText = uri === "file:///main.py" ? this.workspace.sourceText(handle) : null;
    if (sourceText && isNonHoverablePythonKeywordAtOffset(sourceText, position)) {
      return null;
    }
    if (sourceText && !extractIdentifierAtOffset(sourceText, position)) {
      return null;
    }
    const hover = this.workspace.hover(handle, toTyPosition(position));
    if (!hover) {
      return null;
    }

    try {
      return {
        contents: {
          kind: "markdown",
          value: hover.markdown,
        },
        range: toLspRange(hover.range),
      };
    } finally {
      safeFree(hover);
    }
  }

  definition(uri: string, position?: { character?: number; line?: number }) {
    const handle = this.resolveHandleForUri(uri);
    const links = this.workspace.gotoDefinition(handle, toTyPosition(position));

    return links.map((link) => {
      try {
        return {
          originSelectionRange: toLspRange(link.origin_selection_range ?? undefined),
          targetRange: toLspRange(link.full_range),
          targetSelectionRange: toLspRange(link.selection_range ?? link.full_range),
          targetUri: definitionPathToUri(link.path),
        };
      } finally {
        safeFree(link);
      }
    });
  }

  completion(uri: string, position?: { character?: number; line?: number }) {
    const handle = this.resolveHandleForUri(uri);
    const completions = this.workspace.completions(handle, toTyPosition(position));

    return {
      isIncomplete: true,
      items: completions.map((completion, index) => ({
        additionalTextEdits: completion.additional_text_edits?.map((edit) => ({
          newText: edit.new_text,
          range: toLspRange(edit.range),
        })),
        detail: completion.detail ?? undefined,
        documentation: completion.documentation
          ? {
              kind: "markdown",
              value: completion.documentation,
            }
          : undefined,
        insertText: completion.insert_text ?? completion.name,
        kind: completionKindToLspKind(completion.kind),
        label: completion.name,
        sortText: String(index).padStart(4, "0"),
      })),
    };
  }

  signatureHelp(uri: string, position?: { character?: number; line?: number }) {
    const handle = this.resolveHandleForUri(uri);
    const signatureHelp = this.workspace.signatureHelp(handle, toTyPosition(position));
    if (!signatureHelp) {
      return null;
    }

    return {
      activeParameter:
        signatureHelp.signatures[signatureHelp.active_signature ?? 0]?.active_parameter,
      activeSignature: signatureHelp.active_signature ?? 0,
      signatures: signatureHelp.signatures.map((signature) => ({
        documentation: signature.documentation
          ? {
              kind: "markdown",
              value: signature.documentation,
            }
          : undefined,
        label: signature.label,
        parameters: signature.parameters.map((parameter) => ({
          documentation: parameter.documentation
            ? {
                kind: "markdown",
                value: parameter.documentation,
              }
            : undefined,
          label: parameter.label,
        })),
      })),
    };
  }

  private resolveHandleForUri(uri?: string) {
    if (!uri) {
      throw new Error("Missing textDocument.uri");
    }

    if (uri.startsWith("vendored://")) {
      const vendoredPath = vendoredUriToPath(uri);
      const cachedHandle = this.vendoredFileHandles.get(vendoredPath);
      if (cachedHandle) {
        return cachedHandle;
      }

      const handle = this.workspace.getVendoredFile(vendoredPath);
      this.vendoredFileHandles.set(vendoredPath, handle);
      return handle;
    }

    const filePath = fileUriToPath(uri);
    const existingHandle = this.fileHandles.get(filePath);
    if (existingHandle) {
      return existingHandle;
    }

    throw new Error(`Unknown file handle for URI: ${uri}`);
  }
}
