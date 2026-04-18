export function normalizeHoverMarkdown(markdown: string) {
  return markdown
    .replace(/^```[^\n]*\n?/u, "")
    .replace(/\n?```$/u, "")
    .trim();
}

export function containsUnknownInHoverMarkdown(markdown: string) {
  return normalizeHoverMarkdown(markdown).includes("Unknown");
}

export function containsOpaqueAnyGenericHoverMarkdown(markdown: string) {
  const normalized = normalizeHoverMarkdown(markdown);
  return /\b(?:Map|WeakMap|Set|WeakSet)\[Any(?:,\s*Any)?\]/u.test(normalized);
}

export function isBareNoneHoverMarkdown(markdown: string) {
  const normalized = normalizeHoverMarkdown(markdown);
  return normalized === "None" || normalized === "Literal[None]";
}

export function extractPrimaryTypeNameFromHoverMarkdown(markdown: string) {
  const normalized = normalizeHoverMarkdown(markdown);
  const match = normalized.match(/\b([A-Z][A-Za-z0-9_]*)(?:\[[^\]]*\])?\b/u);
  return match?.[1] ?? null;
}

export function extractPrimaryTypeExpressionFromHoverMarkdown(markdown: string) {
  const normalized = normalizeHoverMarkdown(markdown);
  const firstLine = normalized.split("\n")[0]?.trim() ?? "";
  if (!firstLine) {
    return null;
  }

  if (
    /^(?:async\s+)?def\s+/u.test(firstLine) ||
    /^class\s+/u.test(firstLine) ||
    /^bound method\b/u.test(firstLine)
  ) {
    return null;
  }

  if (
    !/^[A-Z][A-Za-z0-9_]*(?:\[[^\]]+\])?(?:\s*\|\s*[A-Z][A-Za-z0-9_]*(?:\[[^\]]+\])?)*$/u.test(
      firstLine,
    )
  ) {
    return null;
  }

  return firstLine;
}
