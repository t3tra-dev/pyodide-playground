import { FileHandle, Position, Workspace } from "../../../.generated/ty-wasm/ty_wasm.js";
import { PYTHON_MAIN_FILE_PATH } from "../../pythonWorkspace";
import { TyAssignmentHoverInference } from "./assignmentHoverInference";
import { TyLoopTargetHoverInference } from "./loopTargetHoverInference";
import {
  extractIdentifierAtOffset,
  extractStringLiteralArgument,
  positionToOffset,
} from "./sourceParsingUtils";
import { TySourceTypeInference } from "./sourceTypeInference";
import { TyStubHoverSupport } from "./stubHoverSupport";

type PlainPosition = { character: number; line: number };
type PlainRange = { end: PlainPosition; start: PlainPosition };

type TySourceHoverFallbackOptions = {
  definitionPathToUri: (path: string) => string;
  getFileHandles: () => Map<string, FileHandle>;
  getMainHandle: () => FileHandle | undefined;
  resolveHandleForUri: (uri: string) => FileHandle;
  safeFree: (value: { free?: () => void } | null | undefined) => void;
  toLspRange: (
    range?: ({ end: Position; start: Position } & { free?: () => void }) | null,
  ) => PlainRange | null;
  toTyPosition: (position?: { character?: number; line?: number }) => Position;
  workspace: Workspace;
};

function splitTopLevelDotSeparated(sourceText: string) {
  const parts: string[] = [];
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

    if (character === "." && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      const nextPart = current.trim();
      if (nextPart) {
        parts.push(nextPart);
      }
      current = "";
      continue;
    }

    current += character;
  }

  const tail = current.trim();
  if (tail) {
    parts.push(tail);
  }

  return parts;
}

function isTopLevelExpressionBoundary(character: string | undefined) {
  return Boolean(character && /[\s=+\-*/%<>!&|^~?:;,]/u.test(character));
}

function extractAttributeChainAtOffset(
  sourceText: string,
  position?: { character?: number; line?: number },
) {
  const offset = positionToOffset(sourceText, position);
  if (offset < 0 || offset >= sourceText.length) {
    return null;
  }

  let start = offset;
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let quote: '"' | "'" | null = null;

  for (let index = offset - 1; index >= 0; index--) {
    const character = sourceText[index];
    const previous = index > 0 ? sourceText[index - 1] : "";

    if (quote) {
      start = index;
      if (character === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      start = index;
      continue;
    }

    if (character === ")") {
      roundDepth += 1;
      start = index;
      continue;
    }
    if (character === "(") {
      if (roundDepth === 0) {
        break;
      }
      roundDepth -= 1;
      start = index;
      continue;
    }
    if (character === "]") {
      squareDepth += 1;
      start = index;
      continue;
    }
    if (character === "[") {
      if (squareDepth === 0) {
        break;
      }
      squareDepth -= 1;
      start = index;
      continue;
    }
    if (character === "}") {
      curlyDepth += 1;
      start = index;
      continue;
    }
    if (character === "{") {
      if (curlyDepth === 0) {
        break;
      }
      curlyDepth -= 1;
      start = index;
      continue;
    }

    if (
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      isTopLevelExpressionBoundary(character)
    ) {
      break;
    }

    start = index;
  }

  let end = offset;
  roundDepth = 0;
  squareDepth = 0;
  curlyDepth = 0;
  quote = null;

  for (let index = offset; index < sourceText.length; index++) {
    const character = sourceText[index];
    const previous = index > 0 ? sourceText[index - 1] : "";

    if (quote) {
      end = index + 1;
      if (character === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      end = index + 1;
      continue;
    }

    if (character === "(" && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      break;
    }
    if (character === "(") {
      roundDepth += 1;
      end = index + 1;
      continue;
    }
    if (character === ")") {
      if (roundDepth === 0) {
        break;
      }
      roundDepth -= 1;
      end = index + 1;
      continue;
    }
    if (character === "[") {
      squareDepth += 1;
      end = index + 1;
      continue;
    }
    if (character === "]") {
      if (squareDepth === 0) {
        break;
      }
      squareDepth -= 1;
      end = index + 1;
      continue;
    }
    if (character === "{") {
      curlyDepth += 1;
      end = index + 1;
      continue;
    }
    if (character === "}") {
      if (curlyDepth === 0) {
        break;
      }
      curlyDepth -= 1;
      end = index + 1;
      continue;
    }

    if (
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      isTopLevelExpressionBoundary(character)
    ) {
      break;
    }

    end = index + 1;
  }

  const expression = sourceText.slice(start, end).trim();
  if (!expression.includes(".")) {
    return null;
  }

  const parts = splitTopLevelDotSeparated(expression);
  const hoveredIdentifier = extractIdentifierAtOffset(sourceText, position)?.identifier ?? null;
  const hoveredPartIndex = hoveredIdentifier ? parts.lastIndexOf(hoveredIdentifier) : -1;
  return parts.length >= 2
    ? {
        expression,
        hoveredPartIndex,
        parts,
        startOffset: start,
      }
    : null;
}

function isCalledAttributeMemberAtOffset(
  sourceText: string,
  position?: { character?: number; line?: number },
) {
  const identifier = extractIdentifierAtOffset(sourceText, position);
  if (!identifier) {
    return false;
  }

  let offset = identifier.endOffset;
  while (offset < sourceText.length && /\s/u.test(sourceText[offset] ?? "")) {
    offset += 1;
  }

  return sourceText[offset] === "(";
}

function extractCallLiteralArgumentAtOffset(
  sourceText: string,
  chainInfo: { expression: string; hoveredPartIndex: number; parts: string[]; startOffset: number },
) {
  if (!chainInfo.parts[chainInfo.hoveredPartIndex]) {
    return null;
  }

  const memberSuffix = chainInfo.parts.slice(chainInfo.hoveredPartIndex).join(".");
  const callStartOffset =
    chainInfo.startOffset +
    Math.max(0, chainInfo.expression.lastIndexOf(memberSuffix)) +
    memberSuffix.length;
  if (sourceText[callStartOffset] !== "(") {
    return null;
  }

  let depth = 0;
  for (let offset = callStartOffset; offset < sourceText.length; offset++) {
    const character = sourceText[offset];
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        const argumentsSource = sourceText.slice(callStartOffset + 1, offset);
        return extractStringLiteralArgument(argumentsSource);
      }
    }
  }

  return null;
}

export class TySourceHoverFallback {
  private readonly assignmentHoverInference: TyAssignmentHoverInference;
  private readonly loopTargetHoverInference: TyLoopTargetHoverInference;
  private readonly sourceTypeInference: TySourceTypeInference;
  private readonly stubHoverSupport: TyStubHoverSupport;

  constructor(private readonly options: TySourceHoverFallbackOptions) {
    this.stubHoverSupport = new TyStubHoverSupport(options);
    this.sourceTypeInference = new TySourceTypeInference({
      getMainHandle: options.getMainHandle,
      resolveMemberTypeFromStubSources: (
        ownerTypeName,
        memberName,
        preferredStringLiteralArg = null,
        callArgumentsSource = null,
      ) =>
        this.stubHoverSupport.resolveMemberTypeFromStubSources(
          ownerTypeName,
          memberName,
          preferredStringLiteralArg,
          callArgumentsSource,
        ),
      toTyPosition: options.toTyPosition,
      workspace: options.workspace,
    });
    this.assignmentHoverInference = new TyAssignmentHoverInference({
      getMainHandle: options.getMainHandle,
      resolveCalledMemberTypeFromSource: (handle, sourceText, expressionText, seenExpressions) =>
        this.sourceTypeInference.resolveCalledMemberTypeFromSource(
          handle,
          sourceText,
          expressionText,
          seenExpressions,
        ),
      resolveExpressionTypeNameFromSource: (handle, sourceText, expressionText, seenExpressions) =>
        this.sourceTypeInference.resolveExpressionTypeNameFromSource(
          handle,
          sourceText,
          expressionText,
          seenExpressions,
        ),
      workspace: options.workspace,
    });
    this.loopTargetHoverInference = new TyLoopTargetHoverInference({
      getMainHandle: options.getMainHandle,
      resolveExpressionTypeNameFromSource: (handle, sourceText, expressionText, seenExpressions) =>
        this.sourceTypeInference.resolveExpressionTypeNameFromSource(
          handle,
          sourceText,
          expressionText,
          seenExpressions,
        ),
      workspace: options.workspace,
    });
  }

  synthesizeVariableHoverFromAssignmentCall(
    uri: string,
    position?: { character?: number; line?: number },
  ) {
    return this.assignmentHoverInference.synthesizeVariableHoverFromAssignmentCall(uri, position);
  }

  synthesizeVariableHoverFromAssignmentExpression(
    uri: string,
    position?: { character?: number; line?: number },
  ) {
    return this.assignmentHoverInference.synthesizeVariableHoverFromAssignmentExpression(
      uri,
      position,
    );
  }

  synthesizeLoopTargetHover(uri: string, position?: { character?: number; line?: number }) {
    return this.loopTargetHoverInference.synthesizeLoopTargetHover(uri, position);
  }

  hasStubMember(ownerTypeName: string, memberName: string) {
    return this.stubHoverSupport.hasMemberInStubSources(ownerTypeName, memberName);
  }

  synthesizeHoverFromStubSource(uri: string, position?: { character?: number; line?: number }) {
    if (uri !== "file:///main.py") {
      return null;
    }

    const mainHandle = this.options.getMainHandle();
    if (!mainHandle) {
      return null;
    }

    const mainSourceText = this.options.workspace.sourceText(mainHandle);
    const chainInfo = extractAttributeChainAtOffset(mainSourceText, position);
    if (!chainInfo || chainInfo.parts.length < 2) {
      return null;
    }

    const hoveredPartIndex =
      chainInfo.hoveredPartIndex >= 1 ? chainInfo.hoveredPartIndex : chainInfo.parts.length - 1;
    const ownerExpression = chainInfo.parts.slice(0, hoveredPartIndex).join(".");
    const memberName = chainInfo.parts[hoveredPartIndex] ?? "";
    if (!ownerExpression || !memberName) {
      return null;
    }

    const ownerTypeName =
      this.sourceTypeInference.resolveExpressionTypeNameAtOffset(
        mainHandle,
        mainSourceText,
        chainInfo.startOffset,
        ownerExpression,
      ) ||
      this.sourceTypeInference.resolveExpressionTypeNameFromSource(
        mainHandle,
        mainSourceText,
        ownerExpression,
      );
    if (!ownerTypeName) {
      return null;
    }

    const preferredStringLiteralArg = extractCallLiteralArgumentAtOffset(mainSourceText, chainInfo);
    const snippet = this.stubHoverSupport.buildMemberHoverSnippetFromStubSources(
      ownerTypeName,
      memberName,
      preferredStringLiteralArg,
    );
    if (!snippet) {
      return null;
    }

    return {
      contents: {
        kind: "markdown",
        value: `\`\`\`python\n${snippet}\n\`\`\``,
      },
      range: null,
    };
  }

  synthesizeHoverFromDefinition(uri: string, position?: { character?: number; line?: number }) {
    const loopTargetHover = this.loopTargetHoverInference.synthesizeLoopTargetHover(uri, position);
    if (loopTargetHover) {
      return loopTargetHover;
    }
    return this.stubHoverSupport.synthesizeHoverFromDefinition(uri, position);
  }
}
