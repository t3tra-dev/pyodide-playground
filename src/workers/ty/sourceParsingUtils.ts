export type PlainPosition = { character: number; line: number };

function isIdentifierCharacter(character: string | undefined) {
  return Boolean(character && /[A-Za-z0-9_]/u.test(character));
}

export function positionToOffset(
  sourceText: string,
  position?: { character?: number; line?: number },
) {
  if (!position) {
    return -1;
  }

  const lines = sourceText.split("\n");
  const targetLine = Math.max(0, Math.min(position.line ?? 0, lines.length - 1));
  const lineOffset = lines.slice(0, targetLine).reduce((total, line) => total + line.length + 1, 0);
  const boundedCharacter = Math.max(
    0,
    Math.min(position.character ?? 0, (lines[targetLine] ?? "").length),
  );
  return lineOffset + boundedCharacter;
}

export function extractIdentifierAtOffset(
  sourceText: string,
  position?: { character?: number; line?: number },
) {
  const offset = positionToOffset(sourceText, position);
  if (offset < 0 || offset >= sourceText.length) {
    return null;
  }
  if (!isIdentifierCharacter(sourceText[offset])) {
    return null;
  }

  let start = offset;
  let end = offset;

  while (start > 0 && isIdentifierCharacter(sourceText[start - 1])) {
    start -= 1;
  }

  while (end < sourceText.length && isIdentifierCharacter(sourceText[end])) {
    end += 1;
  }

  const identifier = sourceText.slice(start, end).trim();
  if (!identifier) {
    return null;
  }

  return {
    endOffset: end,
    identifier,
    startOffset: start,
  };
}

export function findIdentifierOffset(sourceText: string, identifier: string) {
  const pattern = new RegExp(`\\b${identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u");
  const match = pattern.exec(sourceText);
  return match?.index ?? -1;
}

export function offsetToPlainPosition(sourceText: string, offset: number): PlainPosition {
  const boundedOffset = Math.max(0, Math.min(sourceText.length, offset));
  const lines = sourceText.split("\n");
  let traversed = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    const nextTraversed = traversed + line.length;
    if (boundedOffset <= nextTraversed) {
      return {
        character: boundedOffset - traversed,
        line: lineIndex,
      };
    }
    traversed = nextTraversed + 1;
  }

  const lastLineIndex = Math.max(0, lines.length - 1);
  return {
    character: (lines[lastLineIndex] ?? "").length,
    line: lastLineIndex,
  };
}

export function extractStringLiteralArgument(argumentsSource: string) {
  const match = argumentsSource.trim().match(/^(['"])(.*)\1$/su);
  return match?.[2] ?? null;
}

export function splitTopLevelCommaSeparated(sourceText: string) {
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

export function findLatestAssignmentExpression(sourceText: string, identifier: string) {
  const assignmentPattern = new RegExp(
    `^\\s*${identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*=\\s*(.+)$`,
    "gmu",
  );
  const matches = Array.from(sourceText.matchAll(assignmentPattern));
  const match = matches[matches.length - 1];
  const firstLineExpression = match?.[1]?.trim();
  if (!match?.[0] || !firstLineExpression) {
    return null;
  }

  const expressionStartOffset = match.index + match[0].indexOf(match[1]);
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;
  let quote: '"' | "'" | null = null;
  let expression = "";

  for (let index = expressionStartOffset; index < sourceText.length; index++) {
    const character = sourceText[index];
    const previous = index > expressionStartOffset ? sourceText[index - 1] : "";

    if (!quote && character === "\n" && roundDepth === 0 && squareDepth === 0 && curlyDepth === 0) {
      break;
    }

    expression += character;

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
  }

  return expression.trim() || null;
}

export function parseCallExpression(expressionText: string) {
  const trimmedExpression = expressionText.trim();
  if (!trimmedExpression.endsWith(")")) {
    return null;
  }

  let roundDepth = 0;
  let quote: '"' | "'" | null = null;
  let openIndex = -1;

  for (let index = trimmedExpression.length - 1; index >= 0; index--) {
    const character = trimmedExpression[index];
    const previous = index > 0 ? trimmedExpression[index - 1] : "";

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

    if (character === ")") {
      roundDepth += 1;
      continue;
    }

    if (character === "(") {
      roundDepth -= 1;
      if (roundDepth === 0) {
        openIndex = index;
        break;
      }
      continue;
    }
  }

  if (openIndex === -1) {
    return null;
  }

  return {
    argumentsSource: trimmedExpression.slice(openIndex + 1, -1),
    calleeExpression: trimmedExpression.slice(0, openIndex).trim(),
  };
}
