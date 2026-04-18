import { FileHandle, Position, Workspace } from "../../../.generated/ty-wasm/ty_wasm.js";
import {
  extractCallableTypeParameterNames,
  parseExplicitGenericType,
  substituteTypeParameters,
  unwrapClassObjectType,
} from "./typeTextUtils";

type PlainPosition = { character: number; line: number };
type PlainRange = { end: PlainPosition; start: PlainPosition };

type SourceClassInfo = {
  baseClassNames: string[];
  bodyEndLineIndex: number;
  bodyStartLineIndex: number;
  classIndentWidth: number;
  lines: string[];
  typeParameterNames: string[];
};

type TyStubHoverSupportOptions = {
  definitionPathToUri: (path: string) => string;
  getFileHandles: () => Map<string, FileHandle>;
  resolveHandleForUri: (uri: string) => FileHandle;
  safeFree: (value: { free?: () => void } | null | undefined) => void;
  toLspRange: (
    range?: ({ end: Position; start: Position } & { free?: () => void }) | null,
  ) => PlainRange | null;
  toTyPosition: (position?: { character?: number; line?: number }) => Position;
  workspace: Workspace;
};

function splitTopLevelCommaSeparated(sourceText: string) {
  const parts = [];
  let current = "";
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < sourceText.length; index++) {
    const character = sourceText[index];
    const previous = index > 0 ? sourceText[index - 1] : "";

    if (quote) {
      current += character;
      if (character === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "(") {
      roundDepth += 1;
      current += character;
      continue;
    }
    if (character === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
      current += character;
      continue;
    }
    if (character === "[") {
      squareDepth += 1;
      current += character;
      continue;
    }
    if (character === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
      current += character;
      continue;
    }
    if (character === "{") {
      curlyDepth += 1;
      current += character;
      continue;
    }
    if (character === "}") {
      curlyDepth = Math.max(0, curlyDepth - 1);
      current += character;
      continue;
    }

    if (character === "," && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function extractBaseClassNames(classLine: string) {
  const match = classLine.match(/^class\s+[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?\((.*)\):/u);
  if (!match?.[1]) {
    return [];
  }
  return splitTopLevelCommaSeparated(match[1])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/\[[^\]]+\]$/u, "").trim());
}

function extractClassTypeParameterNames(classLine: string) {
  const match = classLine.match(/^class\s+[A-Za-z_][A-Za-z0-9_]*\[([^\]]+)\]/u);
  if (!match?.[1]) {
    return [];
  }

  return splitTopLevelCommaSeparated(match[1])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/:.*/u, "").trim());
}

function getIndentWidth(line: string) {
  const match = line.match(/^\s*/u);
  return match?.[0].length ?? 0;
}

function findClassInfoInSource(sourceText: string, className: string): SourceClassInfo | null {
  const lines = sourceText.split("\n");
  let classLineIndex = -1;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const trimmedLine = line.trim();
    if (new RegExp(`^class\\s+${className}(?:\\[|\\(|:)`, "u").test(trimmedLine)) {
      classLineIndex = lineIndex;
      break;
    }
  }

  if (classLineIndex === -1) {
    return null;
  }

  const classLine = lines[classLineIndex] ?? "";
  const classIndentWidth = getIndentWidth(classLine);
  let bodyStartLineIndex = classLineIndex + 1;
  while (bodyStartLineIndex < lines.length) {
    const bodyLine = lines[bodyStartLineIndex] ?? "";
    const trimmedLine = bodyLine.trim();
    if (!trimmedLine) {
      bodyStartLineIndex += 1;
      continue;
    }
    if (getIndentWidth(bodyLine) <= classIndentWidth && !trimmedLine.startsWith("#")) {
      return null;
    }
    break;
  }

  let bodyEndLineIndex = lines.length;
  for (let lineIndex = bodyStartLineIndex; lineIndex < lines.length; lineIndex++) {
    const bodyLine = lines[lineIndex] ?? "";
    const trimmedLine = bodyLine.trim();
    if (!trimmedLine) {
      continue;
    }
    if (getIndentWidth(bodyLine) <= classIndentWidth && !trimmedLine.startsWith("#")) {
      bodyEndLineIndex = lineIndex;
      break;
    }
  }

  return {
    baseClassNames: extractBaseClassNames(classLine),
    bodyEndLineIndex,
    bodyStartLineIndex,
    classIndentWidth,
    lines,
    typeParameterNames: extractClassTypeParameterNames(classLine),
  };
}

function findClassMemberSnippetInSource(
  sourceText: string,
  className: string,
  memberName: string,
  visitedClassNames = new Set<string>(),
): string | null {
  if (visitedClassNames.has(className)) {
    return null;
  }
  visitedClassNames.add(className);

  const classInfo = findClassInfoInSource(sourceText, className);
  if (!classInfo) {
    return null;
  }

  const memberPattern = new RegExp(`^(?:async\\s+)?def\\s+${memberName}(?:\\[|\\()`, "u");
  const propertyPattern = new RegExp(
    `^${memberName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*:\\s*(.+)$`,
    "u",
  );

  for (
    let memberIndex = classInfo.bodyStartLineIndex;
    memberIndex < classInfo.bodyEndLineIndex;
    memberIndex++
  ) {
    const line = classInfo.lines[memberIndex] ?? "";
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const indentWidth = getIndentWidth(line);
    if (indentWidth <= classInfo.classIndentWidth && !trimmedLine.startsWith("#")) {
      break;
    }

    if (memberPattern.test(trimmedLine)) {
      return trimmedLine;
    }

    const propertyMatch = propertyPattern.exec(trimmedLine);
    if (propertyMatch?.[1]) {
      return `${memberName}: ${propertyMatch[1].trim()}`;
    }
  }

  for (const baseClassName of classInfo.baseClassNames) {
    const inheritedSnippet = findClassMemberSnippetInSource(
      sourceText,
      baseClassName,
      memberName,
      visitedClassNames,
    );
    if (inheritedSnippet) {
      return inheritedSnippet;
    }
  }

  return null;
}

function findClassPropertyTypeInSource(
  sourceText: string,
  className: string,
  propertyName: string,
  visitedClassNames = new Set<string>(),
): string | null {
  if (visitedClassNames.has(className)) {
    return null;
  }
  visitedClassNames.add(className);

  const classInfo = findClassInfoInSource(sourceText, className);
  if (!classInfo) {
    return null;
  }

  const propertyPattern = new RegExp(
    `^${propertyName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*:\\s*(.+)$`,
    "u",
  );

  for (
    let memberIndex = classInfo.bodyStartLineIndex;
    memberIndex < classInfo.bodyEndLineIndex;
    memberIndex++
  ) {
    const line = classInfo.lines[memberIndex] ?? "";
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const indentWidth = getIndentWidth(line);
    if (indentWidth <= classInfo.classIndentWidth && !trimmedLine.startsWith("#")) {
      break;
    }

    const propertyMatch = propertyPattern.exec(trimmedLine);
    if (!propertyMatch?.[1]) {
      continue;
    }

    return propertyMatch[1].trim();
  }

  for (const baseClassName of classInfo.baseClassNames) {
    const inheritedPropertyType = findClassPropertyTypeInSource(
      sourceText,
      baseClassName,
      propertyName,
      visitedClassNames,
    );
    if (inheritedPropertyType) {
      return inheritedPropertyType;
    }
  }

  return null;
}

function extractReturnTypeFromSignatureLine(signatureLine: string) {
  const match = signatureLine.match(/->\s*(.+?):\s*\.\.\.\s*$/u);
  return match?.[1]?.trim() ?? null;
}

function findClassMemberSignatureLinesInSource(
  sourceText: string,
  className: string,
  memberName: string,
  visitedClassNames = new Set<string>(),
): string[] {
  if (visitedClassNames.has(className)) {
    return [];
  }
  visitedClassNames.add(className);

  const classInfo = findClassInfoInSource(sourceText, className);
  if (!classInfo) {
    return [];
  }

  const memberPattern = new RegExp(`^(?:async\\s+)?def\\s+${memberName}(?:\\[|\\()`, "u");
  const signatureLines: string[] = [];

  for (
    let memberIndex = classInfo.bodyStartLineIndex;
    memberIndex < classInfo.bodyEndLineIndex;
    memberIndex++
  ) {
    const line = classInfo.lines[memberIndex] ?? "";
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    const indentWidth = getIndentWidth(line);
    if (indentWidth <= classInfo.classIndentWidth && !trimmedLine.startsWith("#")) {
      break;
    }

    if (!memberPattern.test(trimmedLine)) {
      continue;
    }

    signatureLines.push(trimmedLine);
  }

  if (signatureLines.length > 0) {
    return signatureLines;
  }

  for (const baseClassName of classInfo.baseClassNames) {
    const inheritedSignatureLines = findClassMemberSignatureLinesInSource(
      sourceText,
      baseClassName,
      memberName,
      visitedClassNames,
    );
    if (inheritedSignatureLines.length > 0) {
      return inheritedSignatureLines;
    }
  }

  return [];
}

function findClassMemberSignatureLineInSource(
  sourceText: string,
  className: string,
  memberName: string,
  preferredStringLiteralArg: string | null = null,
  callArgumentsSource: string | null = null,
) {
  const signatureLines = findClassMemberSignatureLinesInSource(sourceText, className, memberName);
  if (signatureLines.length === 0) {
    return null;
  }

  const literalPattern = preferredStringLiteralArg
    ? new RegExp(
        `Literal\\[[\"']${preferredStringLiteralArg.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[\"']\\]`,
        "u",
      )
    : null;
  if (literalPattern) {
    const literalMatchedSignatureLine = signatureLines.find((line) => literalPattern.test(line));
    if (literalMatchedSignatureLine) {
      return literalMatchedSignatureLine;
    }
  }

  if (callArgumentsSource && memberName === "new") {
    const callArguments = splitTopLevelCommaSeparated(callArgumentsSource);
    if (callArguments.length > 1) {
      const variadicSignatureLine = signatureLines.find((line) => /\*\w+:\s*/u.test(line));
      if (variadicSignatureLine) {
        return variadicSignatureLine;
      }
    }

    const firstArgument = callArguments[0]?.trim() ?? "";
    if (firstArgument) {
      const looksNumeric =
        /^[+-]?\d+$/u.test(firstArgument) || /^[+-]?(?:\d+\.\d+|\.\d+)$/u.test(firstArgument);
      if (!looksNumeric) {
        const variadicSignatureLine = signatureLines.find((line) => /\*\w+:\s*/u.test(line));
        if (variadicSignatureLine) {
          return variadicSignatureLine;
        }
      }
    }
  }

  return signatureLines[0] ?? null;
}

function extractLineSnippet(sourceText: string, lineIndex: number) {
  const lines = sourceText.split("\n");
  const line = lines[Math.max(0, lineIndex)] ?? "";
  return line.trim();
}

function positionToOffsetInSource(sourceText: string, position: Position) {
  const lines = sourceText.split("\n");
  const targetLineIndex = Math.max(0, position.line - 1);
  const boundedLineIndex = Math.min(targetLineIndex, lines.length - 1);
  const lineOffset = lines
    .slice(0, boundedLineIndex)
    .reduce((total, line) => total + line.length + 1, 0);
  const lineText = lines[boundedLineIndex] ?? "";
  const boundedColumn = Math.max(0, Math.min(position.column - 1, lineText.length));
  return lineOffset + boundedColumn;
}

function extractRangeSnippet(sourceText: string, range: { end: Position; start: Position }) {
  const startOffset = positionToOffsetInSource(sourceText, range.start);
  const endOffset = positionToOffsetInSource(sourceText, range.end);
  return sourceText.slice(startOffset, endOffset).trim();
}

function extractDefinitionBlockSnippet(
  sourceText: string,
  range: { end: Position; start: Position },
) {
  const lines = sourceText.split("\n");
  const anchorLineIndex = Math.max(0, range.start.line - 1);
  const definitionPattern = /^(?:async\s+def\s+|def\s+|class\s+)/u;
  const decoratorPattern = /^@/u;
  let definitionLineIndex = -1;

  for (
    let lineIndex = anchorLineIndex;
    lineIndex >= Math.max(0, anchorLineIndex - 12);
    lineIndex--
  ) {
    const trimmedLine = (lines[lineIndex] ?? "").trim();
    if (!trimmedLine) {
      continue;
    }
    if (definitionPattern.test(trimmedLine)) {
      definitionLineIndex = lineIndex;
      break;
    }
  }

  if (definitionLineIndex === -1) {
    return null;
  }

  let startLineIndex = definitionLineIndex;
  while (startLineIndex > 0 && decoratorPattern.test((lines[startLineIndex - 1] ?? "").trim())) {
    startLineIndex -= 1;
  }

  const baseIndentWidth = getIndentWidth(lines[definitionLineIndex] ?? "");
  let endLineIndex = definitionLineIndex;
  let sawTerminator = false;
  let awaitingSignatureClosure = /^(?:async\s+)?def\s+/u.test(
    (lines[definitionLineIndex] ?? "").trim(),
  );

  for (let lineIndex = definitionLineIndex + 1; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      if (sawTerminator) {
        break;
      }
      continue;
    }

    const indentWidth = getIndentWidth(line);
    const isSignatureClosureLine =
      awaitingSignatureClosure &&
      (/^\)\s*(?:->.*)?:\s*\.\.\.\s*$/u.test(trimmedLine) || /^\)\s*->/u.test(trimmedLine));
    if (
      indentWidth <= baseIndentWidth &&
      !decoratorPattern.test(trimmedLine) &&
      !isSignatureClosureLine
    ) {
      break;
    }

    endLineIndex = lineIndex;
    if (isSignatureClosureLine) {
      awaitingSignatureClosure = false;
      sawTerminator = true;
      break;
    }

    if (/:\s*\.\.\.\s*$/u.test(trimmedLine) || trimmedLine === "...") {
      sawTerminator = true;
      awaitingSignatureClosure = false;
      if (indentWidth <= baseIndentWidth) {
        break;
      }
    }
  }

  const snippet = lines
    .slice(startLineIndex, endLineIndex + 1)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return snippet || null;
}

function chooseDefinitionSnippet(sourceText: string, range: { end: Position; start: Position }) {
  const blockSnippet = extractDefinitionBlockSnippet(sourceText, range);
  if (blockSnippet) {
    const blockLines = blockSnippet.split("\n");
    if (!/^class\s+/u.test(blockSnippet) || blockLines.length <= 3) {
      return blockSnippet;
    }
  }

  const lineSnippet = extractLineSnippet(sourceText, Math.max(0, range.start.line - 1));
  if (lineSnippet) {
    return lineSnippet;
  }

  return extractRangeSnippet(sourceText, range);
}

function formatPythonHoverMarkdown(snippets: string[]) {
  return snippets.map((snippet) => `\`\`\`python\n${snippet}\n\`\`\``).join("\n---\n");
}

export class TyStubHoverSupport {
  constructor(private readonly options: TyStubHoverSupportOptions) {}

  private normalizeOwnerType(ownerTypeName: string) {
    const unwrappedOwnerTypeName = unwrapClassObjectType(ownerTypeName) ?? ownerTypeName;
    const parsedOwnerType = parseExplicitGenericType(unwrappedOwnerTypeName);
    return {
      ownerBaseTypeName: parsedOwnerType?.baseTypeName ?? unwrappedOwnerTypeName,
      parsedOwnerType,
    };
  }

  resolveMemberTypeFromStubSources(
    ownerTypeName: string,
    memberName: string,
    preferredStringLiteralArg: string | null = null,
    callArgumentsSource: string | null = null,
  ) {
    const { ownerBaseTypeName, parsedOwnerType } = this.normalizeOwnerType(ownerTypeName);

    for (const [path, handle] of this.options.getFileHandles()) {
      if (!path.endsWith(".pyi")) {
        continue;
      }

      const stubSourceText = this.options.workspace.sourceText(handle);
      const classInfo = findClassInfoInSource(stubSourceText, ownerBaseTypeName);
      const signatureLine = findClassMemberSignatureLineInSource(
        stubSourceText,
        ownerBaseTypeName,
        memberName,
        preferredStringLiteralArg,
        callArgumentsSource,
      );
      const signatureReturnType = signatureLine
        ? extractReturnTypeFromSignatureLine(
            parsedOwnerType && classInfo
              ? substituteTypeParameters(
                  signatureLine,
                  classInfo.typeParameterNames,
                  parsedOwnerType.typeArguments,
                  extractCallableTypeParameterNames(signatureLine),
                )
              : signatureLine,
          )
        : null;
      if (signatureReturnType) {
        return signatureReturnType;
      }

      const propertyType = findClassPropertyTypeInSource(
        stubSourceText,
        ownerBaseTypeName,
        memberName,
      );
      if (propertyType) {
        return parsedOwnerType && classInfo
          ? substituteTypeParameters(
              propertyType,
              classInfo.typeParameterNames,
              parsedOwnerType.typeArguments,
            )
          : propertyType;
      }
    }

    return null;
  }

  hasMemberInStubSources(ownerTypeName: string, memberName: string) {
    const { ownerBaseTypeName } = this.normalizeOwnerType(ownerTypeName);

    for (const [path, handle] of this.options.getFileHandles()) {
      if (!path.endsWith(".pyi")) {
        continue;
      }

      const sourceText = this.options.workspace.sourceText(handle);
      if (findClassMemberSnippetInSource(sourceText, ownerBaseTypeName, memberName)) {
        return true;
      }
    }

    return false;
  }

  buildMemberHoverSnippetFromStubSources(
    ownerTypeName: string,
    memberName: string,
    preferredStringLiteralArg: string | null = null,
  ) {
    const { ownerBaseTypeName, parsedOwnerType } = this.normalizeOwnerType(ownerTypeName);

    for (const [path, handle] of this.options.getFileHandles()) {
      if (!path.endsWith(".pyi")) {
        continue;
      }

      const sourceText = this.options.workspace.sourceText(handle);
      const classInfo = findClassInfoInSource(sourceText, ownerBaseTypeName);
      const signatureLines = findClassMemberSignatureLinesInSource(
        sourceText,
        ownerBaseTypeName,
        memberName,
      );
      const signatureLine = findClassMemberSignatureLineInSource(
        sourceText,
        ownerBaseTypeName,
        memberName,
        preferredStringLiteralArg,
        null,
      );
      const hasLiteralSpecificSignature = signatureLines.some((line) => line.includes("Literal["));
      const propertyType = findClassPropertyTypeInSource(sourceText, ownerBaseTypeName, memberName);
      const signatureSnippet =
        signatureLines.length > 1 &&
        (memberName === "new" || !preferredStringLiteralArg || !hasLiteralSpecificSignature)
          ? signatureLines
              .map((line) =>
                parsedOwnerType && classInfo
                  ? substituteTypeParameters(
                      line,
                      classInfo.typeParameterNames,
                      parsedOwnerType.typeArguments,
                      extractCallableTypeParameterNames(line),
                    )
                  : line,
              )
              .join("\n")
          : signatureLine && parsedOwnerType && classInfo
            ? substituteTypeParameters(
                signatureLine,
                classInfo.typeParameterNames,
                parsedOwnerType.typeArguments,
                extractCallableTypeParameterNames(signatureLine),
              )
            : signatureLine;
      const snippet =
        signatureSnippet ??
        (findClassMemberSnippetInSource(sourceText, ownerBaseTypeName, memberName) &&
        parsedOwnerType &&
        classInfo
          ? substituteTypeParameters(
              findClassMemberSnippetInSource(sourceText, ownerBaseTypeName, memberName) ?? "",
              classInfo.typeParameterNames,
              parsedOwnerType.typeArguments,
              extractCallableTypeParameterNames(
                findClassMemberSnippetInSource(sourceText, ownerBaseTypeName, memberName) ?? "",
              ),
            )
          : findClassMemberSnippetInSource(sourceText, ownerBaseTypeName, memberName)) ??
        (propertyType && parsedOwnerType && classInfo
          ? substituteTypeParameters(
              propertyType,
              classInfo.typeParameterNames,
              parsedOwnerType.typeArguments,
            )
          : propertyType);
      if (snippet) {
        return snippet;
      }
    }

    return null;
  }

  synthesizeHoverFromDefinition(uri: string, position?: { character?: number; line?: number }) {
    const handle = this.options.resolveHandleForUri(uri);
    const definitions = this.options.workspace.gotoDefinition(
      handle,
      this.options.toTyPosition(position),
    );
    const snippets: string[] = [];
    let range: PlainRange | null = null;

    for (const definition of definitions) {
      try {
        const targetUri = this.options.definitionPathToUri(definition.path);
        const targetHandle = this.options.resolveHandleForUri(targetUri);
        const targetRange = definition.selection_range ?? definition.full_range;
        const sourceText = this.options.workspace.sourceText(targetHandle);
        const snippet = chooseDefinitionSnippet(sourceText, targetRange);

        if (!snippet) {
          continue;
        }
        if (!snippets.includes(snippet)) {
          snippets.push(snippet);
        }
        range ??= this.options.toLspRange(definition.origin_selection_range ?? undefined);
        if (snippets.length >= 8) {
          break;
        }
      } catch {
        continue;
      } finally {
        this.options.safeFree(definition);
      }
    }

    if (snippets.length === 0) {
      return null;
    }

    return {
      contents: {
        kind: "markdown",
        value: formatPythonHoverMarkdown(snippets),
      },
      range,
    };
  }
}
