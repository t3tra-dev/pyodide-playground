type PythonEnvironmentFileSnapshot = {
  content: string;
  path: string;
};

type PythonEnvironmentImportRootSnapshot = {
  hasLocalStub: boolean;
  importName: string;
  isPackage: boolean;
  path: string;
  sitePath: string;
};

type PythonEnvironmentPackageSnapshot = {
  distributionName: string;
  importRoots: PythonEnvironmentImportRootSnapshot[];
  version: string;
};

export type PythonEnvironmentSnapshotPayload = {
  extraPaths: string[];
  files: PythonEnvironmentFileSnapshot[];
  packages: PythonEnvironmentPackageSnapshot[];
  pythonVersion: string;
};

type VendoredStubIndex = {
  distributionName: string;
  files: string[];
  importName: string;
  pythonVersion: string;
  version: string;
  wheelFilename: string;
};
const VENDORED_STUB_DIRECTORY_NAMES = new Map<string, string>([["pygame-ce", "pygame-ce"]]);
const vendoredStubIndexCache = new Map<string, Promise<VendoredStubIndex | null>>();
const vendoredStubTextCache = new Map<string, Promise<string | null>>();

function normalizePosixPath(value: string) {
  const normalized = String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  if (!normalized) {
    return "";
  }

  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function getVendoredDirectoryName(distributionName: string) {
  return VENDORED_STUB_DIRECTORY_NAMES.get(distributionName) ?? null;
}

function getVendoredIndexUrl(vendorStubsBaseUrl: string, distributionName: string) {
  if (!vendorStubsBaseUrl) {
    return null;
  }

  const directoryName = getVendoredDirectoryName(distributionName);
  if (!directoryName) {
    return null;
  }

  return new URL(`${directoryName}/index.json`, vendorStubsBaseUrl).toString();
}

function getVendoredFileUrl(
  vendorStubsBaseUrl: string,
  distributionName: string,
  relativePath: string,
) {
  if (!vendorStubsBaseUrl) {
    return null;
  }

  const directoryName = getVendoredDirectoryName(distributionName);
  if (!directoryName) {
    return null;
  }

  return new URL(`${directoryName}/${relativePath}`, vendorStubsBaseUrl).toString();
}

async function fetchVendoredTextFile(url: string) {
  const cached = vendoredStubTextCache.get(url);
  if (cached) {
    return await cached;
  }

  const pending = fetch(url)
    .then(async (response) => (response.ok ? await response.text() : null))
    .catch(() => null);
  vendoredStubTextCache.set(url, pending);
  return await pending;
}

async function fetchVendoredIndex(
  vendorStubsBaseUrl: string,
  packageEntry: PythonEnvironmentPackageSnapshot,
  importName: string,
) {
  const url = getVendoredIndexUrl(vendorStubsBaseUrl, packageEntry.distributionName);
  if (!url) {
    return null;
  }

  const cached = vendoredStubIndexCache.get(url);
  if (cached) {
    const index = await cached;
    return index &&
      index.distributionName === packageEntry.distributionName &&
      index.importName === importName &&
      index.version === packageEntry.version
      ? index
      : null;
  }

  const pending = fetch(url)
    .then(async (response) => (response.ok ? ((await response.json()) as VendoredStubIndex) : null))
    .catch(() => null);
  vendoredStubIndexCache.set(url, pending);
  const index = await pending;

  return index &&
    index.distributionName === packageEntry.distributionName &&
    index.importName === importName &&
    index.version === packageEntry.version
    ? index
    : null;
}

export async function enrichTySnapshot(
  snapshot: PythonEnvironmentSnapshotPayload,
  vendorStubsBaseUrl: string,
): Promise<PythonEnvironmentSnapshotPayload> {
  const seenPaths = new Set(snapshot.files.map((file) => normalizePosixPath(file.path)));

  for (const packageEntry of snapshot.packages) {
    for (const importRoot of packageEntry.importRoots) {
      if (importRoot.hasLocalStub || !importRoot.importName || !importRoot.sitePath) {
        continue;
      }

      const vendoredIndex = await fetchVendoredIndex(
        vendorStubsBaseUrl,
        packageEntry,
        importRoot.importName,
      );
      if (!vendoredIndex) {
        continue;
      }

      const vendoredFiles = await Promise.all(
        vendoredIndex.files.map(async (relativePath) => {
          const fileUrl = getVendoredFileUrl(
            vendorStubsBaseUrl,
            packageEntry.distributionName,
            relativePath,
          );
          if (!fileUrl) {
            return null;
          }

          const content = await fetchVendoredTextFile(fileUrl);
          if (content === null) {
            return null;
          }

          return {
            content,
            relativePath,
          };
        }),
      );

      for (const file of vendoredFiles) {
        if (!file) {
          continue;
        }

        const normalizedPath = normalizePosixPath(`${importRoot.sitePath}/${file.relativePath}`);
        if (!normalizedPath || seenPaths.has(normalizedPath)) {
          continue;
        }

        seenPaths.add(normalizedPath);
        snapshot.files.push({
          content: file.content,
          path: normalizedPath,
        });
      }
    }
  }

  snapshot.files.sort((left, right) => left.path.localeCompare(right.path));
  snapshot.extraPaths = Array.from(
    new Set(snapshot.extraPaths.map(normalizePosixPath).filter(Boolean)),
  ).sort();
  return snapshot;
}

export function createTyEnvironmentSnapshotScript(targetPackages: string[]) {
  return `
import importlib.metadata
import importlib.util
import json
import sys
from pathlib import Path

TARGET_PACKAGES = ${JSON.stringify(targetPackages)}
EXCLUDED_DIR_NAMES = {
    "__pycache__",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    "benchmarks",
    "test",
    "tests",
    "testing",
}
TEXT_SUFFIXES = {".py", ".pyi"}

def iter_module_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in EXCLUDED_DIR_NAMES for part in path.parts):
            continue
        if path.name != "py.typed" and path.suffix not in TEXT_SUFFIXES:
            continue
        yield path

def get_distribution(package_name: str):
    try:
        return importlib.metadata.distribution(package_name)
    except importlib.metadata.PackageNotFoundError:
        return None

def get_top_level_imports(package_name: str, distribution):
    top_level_imports = []
    seen_imports = set()

    def add_import(value: str):
        candidate = (value or "").strip()
        if not candidate or candidate in seen_imports:
            return
        seen_imports.add(candidate)
        top_level_imports.append(candidate)

    if distribution is not None:
        top_level_text = distribution.read_text("top_level.txt") or ""
        for line in top_level_text.splitlines():
            add_import(line)

        for file_entry in distribution.files or []:
            entry_path = Path(file_entry)
            if not entry_path.parts:
                continue
            head = entry_path.parts[0]
            if head.endswith((".dist-info", ".data")):
                continue
            if len(entry_path.parts) > 1:
                add_import(head)
                continue
            if entry_path.suffix in TEXT_SUFFIXES:
                add_import(entry_path.stem)

    packages_map = importlib.metadata.packages_distributions()
    normalized_package_name = package_name.lower().replace("_", "-")
    for import_name, distributions in packages_map.items():
        normalized_distributions = {
            str(distribution_name).lower().replace("_", "-")
            for distribution_name in distributions or []
        }
        if normalized_package_name in normalized_distributions:
            add_import(import_name)

    normalized_name = package_name.replace("-", "_")
    add_import(normalized_name)

    return top_level_imports

def append_text_file(file_path: Path):
    normalized_path = file_path.as_posix()
    if normalized_path in seen_paths:
        return False

    try:
        content = file_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return False

    seen_paths.add(normalized_path)
    files.append({
        "content": content,
        "path": normalized_path,
    })
    return True

seen_paths = set()
files = []
extra_paths = set()
packages = []

for entry in sys.path:
    if not entry:
        continue
    try:
        path_entry = Path(entry)
    except Exception:
        continue
    if path_entry.exists() and path_entry.is_dir():
        extra_paths.add(path_entry.as_posix())

for package_name in TARGET_PACKAGES:
    distribution = get_distribution(package_name)
    distribution_name = package_name
    distribution_version = ""
    if distribution is not None:
        distribution_name = (
            distribution.metadata.get("Name")
            or distribution.metadata.get("name")
            or package_name
        )
        distribution_version = distribution.version or ""

    import_roots = []
    seen_import_roots = set()

    for import_name in get_top_level_imports(package_name, distribution):
        try:
            spec = importlib.util.find_spec(import_name)
        except Exception:
            continue

        if spec is None:
            continue

        if spec.submodule_search_locations:
            for location in spec.submodule_search_locations:
                root = Path(location)
                if not root.exists() or not root.is_dir():
                    continue

                site_path = root.parent.as_posix()
                extra_paths.add(site_path)
                has_local_stub = False
                for file_path in iter_module_files(root):
                    if file_path.name == "py.typed" or file_path.suffix == ".pyi":
                        has_local_stub = True
                    append_text_file(file_path)

                import_root_key = (import_name, root.as_posix())
                if import_root_key not in seen_import_roots:
                    seen_import_roots.add(import_root_key)
                    import_roots.append({
                        "hasLocalStub": has_local_stub,
                        "importName": import_name,
                        "isPackage": True,
                        "path": root.as_posix(),
                        "sitePath": site_path,
                    })
            continue

        origin = getattr(spec, "origin", None)
        if not origin or origin in {"built-in", "frozen"}:
            continue

        file_path = Path(origin)
        if not file_path.exists() or not file_path.is_file():
            continue
        site_path = file_path.parent.as_posix()
        extra_paths.add(site_path)

        candidate_paths = []
        stub_path = file_path.with_suffix(".pyi")
        if stub_path.exists() and stub_path.is_file():
            candidate_paths.append(stub_path)
        if file_path.name == "py.typed" or file_path.suffix in TEXT_SUFFIXES:
            candidate_paths.append(file_path)

        has_local_stub = False
        for candidate_path in candidate_paths:
            if candidate_path.name == "py.typed" or candidate_path.suffix == ".pyi":
                has_local_stub = True
            append_text_file(candidate_path)

        import_root_key = (import_name, file_path.as_posix())
        if import_root_key not in seen_import_roots:
            seen_import_roots.add(import_root_key)
            import_roots.append({
                "hasLocalStub": has_local_stub,
                "importName": import_name,
                "isPackage": False,
                "path": file_path.as_posix(),
                "sitePath": site_path,
            })

    if distribution_name or distribution_version or import_roots:
        packages.append({
            "distributionName": distribution_name,
            "importRoots": import_roots,
            "version": distribution_version,
        })

json.dumps(
    {
        "extraPaths": sorted(extra_paths),
        "files": files,
        "packages": packages,
        "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
    },
    separators=(",", ":"),
)
`;
}
