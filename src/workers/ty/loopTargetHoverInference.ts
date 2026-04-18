import { FileHandle, Workspace } from "../../../.generated/ty-wasm/ty_wasm.js";
import { extractIdentifierAtOffset, splitTopLevelCommaSeparated } from "./sourceParsingUtils";
import { parseExplicitGenericType } from "./typeTextUtils";

type TyLoopTargetHoverInferenceOptions = {
  getMainHandle: () => FileHandle | undefined;
  resolveExpressionTypeNameFromSource: (
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions?: Set<string>,
  ) => string | null;
  workspace: Workspace;
};

type ForClause = {
  iterableSource: string;
  targetNames: string[];
};

function scanForClause(lineText: string, startIndex: number): ForClause | null {
  let quote: '"' | "'" | null = null;
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let targetEndIndex = -1;
  let iterableStartIndex = -1;

  for (let index = startIndex; index < lineText.length; index++) {
    const character = lineText[index] ?? "";
    const previous = index > 0 ? (lineText[index - 1] ?? "") : "";

    if (quote) {
      if (character === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === "(") {
      roundDepth += 1;
      continue;
    }
    if (character === ")") {
      roundDepth = Math.max(0, roundDepth - 1);
      continue;
    }
    if (character === "[") {
      squareDepth += 1;
      continue;
    }
    if (character === "]") {
      squareDepth = Math.max(0, squareDepth - 1);
      continue;
    }
    if (character === "{") {
      curlyDepth += 1;
      continue;
    }
    if (character === "}") {
      curlyDepth = Math.max(0, curlyDepth - 1);
      continue;
    }

    if (
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      lineText.slice(index, index + 4) === " in "
    ) {
      targetEndIndex = index;
      iterableStartIndex = index + 4;
      break;
    }
  }

  if (targetEndIndex === -1 || iterableStartIndex === -1) {
    return null;
  }

  const targetSource = lineText.slice(startIndex, targetEndIndex).trim();
  if (!targetSource) {
    return null;
  }

  quote = null;
  roundDepth = 0;
  squareDepth = 0;
  curlyDepth = 0;
  let iterableEndIndex = lineText.length;

  for (let index = iterableStartIndex; index < lineText.length; index++) {
    const character = lineText[index] ?? "";
    const previous = index > 0 ? (lineText[index - 1] ?? "") : "";

    if (quote) {
      if (character === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === "(") {
      roundDepth += 1;
      continue;
    }
    if (character === ")") {
      if (roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
        iterableEndIndex = index;
        break;
      }
      roundDepth = Math.max(0, roundDepth - 1);
      continue;
    }
    if (character === "[") {
      squareDepth += 1;
      continue;
    }
    if (character === "]") {
      if (roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
        iterableEndIndex = index;
        break;
      }
      squareDepth = Math.max(0, squareDepth - 1);
      continue;
    }
    if (character === "{") {
      curlyDepth += 1;
      continue;
    }
    if (character === "}") {
      if (roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
        iterableEndIndex = index;
        break;
      }
      curlyDepth = Math.max(0, curlyDepth - 1);
      continue;
    }

    if (
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0 &&
      lineText.slice(index, index + 4) === " if "
    ) {
      iterableEndIndex = index;
      break;
    }

    if (roundDepth === 0 && squareDepth === 0 && curlyDepth === 0 && character === ":") {
      iterableEndIndex = index;
      break;
    }
  }

  const iterableSource = lineText.slice(iterableStartIndex, iterableEndIndex).trim();
  if (!iterableSource) {
    return null;
  }

  const targetNames = splitTopLevelCommaSeparated(targetSource)
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry));
  if (targetNames.length === 0) {
    return null;
  }

  return {
    iterableSource,
    targetNames,
  };
}

function collectForClauses(lineText: string) {
  const clauses: ForClause[] = [];
  for (let index = 0; index < lineText.length; index++) {
    if (
      (index === 0 || /\s/u.test(lineText[index - 1] ?? "")) &&
      lineText.slice(index, index + 4) === "for "
    ) {
      const clause = scanForClause(lineText, index + 4);
      if (clause) {
        clauses.push(clause);
      }
    }
  }
  return clauses;
}

export class TyLoopTargetHoverInference {
  constructor(private readonly options: TyLoopTargetHoverInferenceOptions) {}

  synthesizeLoopTargetHover(uri: string, position?: { character?: number; line?: number }) {
    if (uri !== "file:///main.py") {
      return null;
    }

    const mainHandle = this.options.getMainHandle();
    if (!mainHandle || !position) {
      return null;
    }

    const sourceText = this.options.workspace.sourceText(mainHandle);
    const identifier = extractIdentifierAtOffset(sourceText, position);
    if (!identifier) {
      return null;
    }

    const lines = sourceText.split("\n");
    const lineText = lines[Math.max(0, position.line ?? 0)] ?? "";
    const clauses = collectForClauses(lineText);
    for (const clause of clauses) {
      const targetIndex = clause.targetNames.indexOf(identifier.identifier);
      if (targetIndex === -1) {
        continue;
      }

      const iterableType = this.options.resolveExpressionTypeNameFromSource(
        mainHandle,
        sourceText,
        clause.iterableSource,
      );
      if (!iterableType) {
        continue;
      }

      const parsedIterableType = parseExplicitGenericType(iterableType);
      if (
        parsedIterableType &&
        (parsedIterableType.baseTypeName === "Map" ||
          parsedIterableType.baseTypeName === "WeakMap") &&
        parsedIterableType.typeArguments.length >= 2 &&
        clause.targetNames.length === 2
      ) {
        const resolvedType = parsedIterableType.typeArguments[targetIndex]?.trim();
        if (!resolvedType) {
          continue;
        }
        return {
          contents: {
            kind: "markdown",
            value: `\`\`\`python\n${resolvedType}\n\`\`\``,
          },
          range: null,
        };
      }

      if (
        parsedIterableType &&
        (parsedIterableType.baseTypeName === "Set" ||
          parsedIterableType.baseTypeName === "WeakSet") &&
        parsedIterableType.typeArguments.length >= 1 &&
        clause.targetNames.length === 1 &&
        targetIndex === 0
      ) {
        const resolvedType = parsedIterableType.typeArguments[0]?.trim();
        if (!resolvedType) {
          continue;
        }
        return {
          contents: {
            kind: "markdown",
            value: `\`\`\`python\n${resolvedType}\n\`\`\``,
          },
          range: null,
        };
      }
    }

    return null;
  }
}
