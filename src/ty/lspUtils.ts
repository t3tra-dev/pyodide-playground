export function normalizeLspOutgoingMessage(message: string) {
  const payload = JSON.parse(message);

  if (payload?.method === "initialize" && payload.params) {
    payload.params.rootPath ??= "/";
    payload.params.workspaceFolders ??= [
      {
        name: "/",
        uri: "file:///",
      },
    ];
    payload.params.capabilities ??= {};
    payload.params.capabilities.workspace ??= {};
    payload.params.capabilities.workspace.configuration = true;
    payload.params.capabilities.workspace.workspaceFolders = true;
  }

  return payload;
}

export function getNestedSettingValue(source: Record<string, unknown>, section?: string) {
  if (!section) {
    return source;
  }

  const keys = String(section).split(".");
  let current: unknown = source;
  for (const key of keys) {
    if (!current || typeof current !== "object" || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current ?? null;
}

export function offsetToLspPosition(documentText: string, offset: number) {
  const safeOffset = Math.max(0, Math.min(offset, documentText.length));
  const prefix = documentText.slice(0, safeOffset);
  const lines = prefix.split("\n");
  const line = lines.length - 1;
  const character = lines.at(-1)?.length ?? 0;

  return { character, line };
}

export function lspPositionToOffset(
  documentText: string,
  position: { character?: number; line?: number } | null | undefined,
) {
  const targetLine = Math.max(0, Math.trunc(Number(position?.line ?? 0) || 0));
  const targetCharacter = Math.max(0, Math.trunc(Number(position?.character ?? 0) || 0));

  let offset = 0;
  let currentLine = 0;
  while (currentLine < targetLine && offset < documentText.length) {
    const nextBreak = documentText.indexOf("\n", offset);
    if (nextBreak === -1) {
      return documentText.length;
    }

    offset = nextBreak + 1;
    currentLine += 1;
  }

  return Math.max(0, Math.min(offset + targetCharacter, documentText.length));
}
