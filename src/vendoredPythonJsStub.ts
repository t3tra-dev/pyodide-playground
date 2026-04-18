const pythonJsStubCache = new Map<string, Promise<{ pythonJsStubContent: string }>>();

async function fetchVendoredTextFile(baseUrl: string, relativePath: string, label: string) {
  const response = await fetch(new URL(relativePath, baseUrl));
  if (!response.ok) {
    throw new Error(`Failed to fetch vendored ${label}: ${response.status}`);
  }

  return await response.text();
}

export async function fetchVendoredPythonJsStub(baseUrl: string) {
  const cached = pythonJsStubCache.get(baseUrl);
  if (cached) {
    return await cached;
  }

  const pending = fetchVendoredTextFile(baseUrl, "js/__init__.pyi", "js module stub").then(
    (pythonJsStubContent) => ({
      pythonJsStubContent,
    }),
  );

  pythonJsStubCache.set(baseUrl, pending);
  try {
    return await pending;
  } catch (error) {
    pythonJsStubCache.delete(baseUrl);
    throw error;
  }
}
