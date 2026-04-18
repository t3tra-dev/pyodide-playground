import { splitTopLevelCommaSeparated } from "./sourceParsingUtils";

export function normalizeTypeParts(parts: string[]) {
  const normalized = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const nextPart = String(part || "Any").trim() || "Any";
    if (seen.has(nextPart)) {
      continue;
    }
    seen.add(nextPart);
    normalized.push(nextPart);
  }

  return normalized;
}

export function parseExplicitGenericType(typeText: string) {
  const trimmedTypeText = typeText.trim();
  const baseNameMatch = trimmedTypeText.match(/^([A-Za-z_][A-Za-z0-9_]*)\[/u);
  if (!baseNameMatch?.[1] || !trimmedTypeText.endsWith("]")) {
    return null;
  }

  const baseTypeName = baseNameMatch[1];
  const typeArgumentsSource = trimmedTypeText.slice(baseTypeName.length + 1, -1);
  return {
    baseTypeName,
    typeArguments: splitTopLevelCommaSeparated(typeArgumentsSource),
  };
}

export function substituteTypeParameters(
  typeText: string,
  typeParameterNames: string[],
  typeArguments: string[],
  shadowedTypeParameterNames: Iterable<string> = [],
) {
  let result = typeText;
  const shadowed = new Set(shadowedTypeParameterNames);

  for (let index = 0; index < Math.min(typeParameterNames.length, typeArguments.length); index++) {
    const parameterName = typeParameterNames[index]?.trim();
    const argumentName = typeArguments[index]?.trim();
    if (!parameterName || !argumentName || shadowed.has(parameterName)) {
      continue;
    }

    result = result.replace(
      new RegExp(`\\b${parameterName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "gu"),
      argumentName,
    );
  }

  return result;
}

export function extractCallableTypeParameterNames(signatureText: string) {
  const match = signatureText.match(/^\s*(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\[([^\]]+)\]/u);
  if (!match?.[1]) {
    return [];
  }

  return splitTopLevelCommaSeparated(match[1])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/:.*/u, "").trim());
}

export function unwrapClassObjectType(typeText: string) {
  const parsedType = parseExplicitGenericType(typeText);
  if (!parsedType || parsedType.baseTypeName !== "type") {
    return null;
  }

  return parsedType.typeArguments[0]?.trim() ?? null;
}
