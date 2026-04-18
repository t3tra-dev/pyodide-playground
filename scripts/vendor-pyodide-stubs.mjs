import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { dirname as pathDirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { buildTypeScriptJsStub, getTypeScriptJsStubVersion } from "./js-stubgen.mjs";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PYODIDE_LOCKFILE_PATH = resolve(ROOT_DIR, "node_modules/pyodide/pyodide-lock.json");
const DEFAULT_OUTPUT_DIR = resolve(tmpdir(), "pyodide-playground/vendor/python-stubs");
const OUTPUT_DIR = process.env.PYODIDE_VENDOR_STUBS_OUT_DIR
  ? resolve(process.env.PYODIDE_VENDOR_STUBS_OUT_DIR)
  : DEFAULT_OUTPUT_DIR;
const VENDORED_STUB_MANIFEST_VERSION = 5;

const TARGETS = [
  {
    distributionName: "pygame-ce",
    importName: "pygame",
    targetRevision: 0,
    selectFiles(entry) {
      return (
        entry.fileName.startsWith("pygame/") &&
        (entry.fileName.endsWith(".pyi") || entry.fileName.endsWith("/py.typed"))
      );
    },
    toVendoredFile(entry) {
      return {
        content: entry.data.toString("utf8"),
        relativePath: entry.fileName,
      };
    },
  },
  {
    distributionName: "js",
    importName: "js",
      targetRevision: 61,
    version: `typescript-${getTypeScriptJsStubVersion()}`,
    buildFiles() {
      return [
        {
          content: buildTypeScriptJsStub(),
          relativePath: "__init__.pyi",
        },
      ];
    },
  },
];

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function getPythonTag(pythonVersion) {
  const [major = "3", minor = "13"] = String(pythonVersion ?? "3.13").split(".");
  return `cp${major}${minor}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch JSON: ${url} (${response.status})`);
  }

  return await response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${url} (${response.status})`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function chooseWheel(urls, pythonTag) {
  const wheels = urls
    .filter(
      (entry) => entry.packagetype === "bdist_wheel" && String(entry.filename).endsWith(".whl"),
    )
    .map((entry) => {
      const filename = String(entry.filename);
      let score = 0;
      if (filename.includes(`-${pythonTag}-`)) {
        score += 1000;
      }
      if (filename.includes(`-${pythonTag.replace(/^cp/u, "py")}-`)) {
        score += 100;
      }
      if (filename.includes("py3-none-any")) {
        score += 80;
      }
      if (filename.includes("manylinux")) {
        score += 50;
      }
      if (filename.includes("x86_64")) {
        score += 10;
      }
      return { ...entry, filename, score };
    })
    .sort((left, right) => right.score - left.score || left.filename.localeCompare(right.filename));

  if (wheels.length === 0) {
    throw new Error("No wheel files were published for this package version");
  }

  return wheels[0];
}

function findEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new Error("End of central directory record was not found");
}

function extractZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  let directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let index = 0; index < totalEntries; index++) {
    if (buffer.readUInt32LE(directoryOffset) !== 0x02014b50) {
      throw new Error("Invalid central directory header signature");
    }

    const compressionMethod = buffer.readUInt16LE(directoryOffset + 10);
    const compressedSize = buffer.readUInt32LE(directoryOffset + 20);
    const fileNameLength = buffer.readUInt16LE(directoryOffset + 28);
    const extraFieldLength = buffer.readUInt16LE(directoryOffset + 30);
    const fileCommentLength = buffer.readUInt16LE(directoryOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(directoryOffset + 42);
    const fileName = buffer.toString(
      "utf8",
      directoryOffset + 46,
      directoryOffset + 46 + fileNameLength,
    );

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid local file header for ${fileName}`);
    }

    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
    const compressedData = buffer.subarray(dataOffset, dataOffset + compressedSize);

    let data;
    if (compressionMethod === 0) {
      data = compressedData;
    } else if (compressionMethod === 8) {
      data = inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${fileName}`);
    }

    entries.push({
      data,
      fileName,
    });

    directoryOffset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  return entries;
}

function loadExistingManifest(filePath) {
  try {
    return readJsonFile(filePath);
  } catch {
    return null;
  }
}

function ensureFileParentDirectory(filePath) {
  mkdirSync(pathDirname(filePath), { recursive: true });
}

function resolveTargetVersion(target, pyodideLockfile) {
  if (target.version) {
    return String(target.version);
  }

  const packageMetadata = pyodideLockfile.packages?.[target.distributionName];
  if (!packageMetadata?.version) {
    throw new Error(`Package ${target.distributionName} was not found in pyodide-lock.json`);
  }

  return String(packageMetadata.version);
}

function buildVendoredFiles(entries, target) {
  const files = entries
    .filter((entry) => target.selectFiles(entry))
    .map((entry) => target.toVendoredFile(entry))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  if (files.length === 0) {
    throw new Error(`No vendorable stub files were found for ${target.distributionName}`);
  }

  return target.patchFiles ? target.patchFiles(files) : files;
}

async function buildTarget(target, pyodideLockfile, outputDir = OUTPUT_DIR) {
  const version = resolveTargetVersion(target, pyodideLockfile);
  const targetRevision = Number(target.targetRevision ?? 0);
  const outputDirectoryPath = resolve(outputDir, target.distributionName);
  const outputFilePath = resolve(outputDirectoryPath, "index.json");
  rmSync(resolve(outputDir, `${target.distributionName}.json`), { force: true });
  const existingManifest = loadExistingManifest(outputFilePath);
  if (
    existingManifest?.manifestVersion === VENDORED_STUB_MANIFEST_VERSION &&
    Number(existingManifest?.targetRevision ?? 0) === targetRevision &&
    existingManifest?.version === version &&
    Array.isArray(existingManifest.files) &&
    existingManifest.files.length > 0 &&
    existingManifest.files.every((relativePath) =>
      existsSync(resolve(outputDirectoryPath, String(relativePath))),
    )
  ) {
    return {
      fileCount: existingManifest.files.length,
      outputDirectoryPath,
      outputFilePath,
      skipped: true,
      version,
    };
  }

  let files;
  let wheelFilename = null;
  if (typeof target.buildFiles === "function") {
    files = target.buildFiles({ pyodideLockfile, version });
  } else {
    const pythonTag = getPythonTag(pyodideLockfile.info?.python);
    const pypiMetadata = await fetchJson(
      `https://pypi.org/pypi/${encodeURIComponent(target.distributionName)}/${encodeURIComponent(version)}/json`,
    );
    const wheel = chooseWheel(pypiMetadata.urls ?? [], pythonTag);
    const wheelBuffer = await fetchBuffer(wheel.url);
    files = buildVendoredFiles(extractZipEntries(wheelBuffer), target);
    wheelFilename = wheel.filename;
  }

  rmSync(outputDirectoryPath, { recursive: true, force: true });
  mkdirSync(outputDirectoryPath, { recursive: true });
  for (const file of files) {
    const fileOutputPath = resolve(outputDirectoryPath, file.relativePath);
    ensureFileParentDirectory(fileOutputPath);
    writeFileSync(fileOutputPath, file.content, "utf8");
  }

  const manifest = {
    distributionName: target.distributionName,
    files: files.map((file) => file.relativePath),
    generatedAt: new Date().toISOString(),
    importName: target.importName,
    manifestVersion: VENDORED_STUB_MANIFEST_VERSION,
    pythonVersion: String(pyodideLockfile.info?.python ?? ""),
    targetRevision,
    version,
    ...(wheelFilename ? { wheelFilename } : {}),
  };

  mkdirSync(outputDir, { recursive: true });
  writeFileSync(outputFilePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    fileCount: files.length,
    outputDirectoryPath,
    outputFilePath,
    skipped: false,
    version,
  };
}

export function getVendoredStubsOutputDir() {
  return OUTPUT_DIR;
}

export async function ensureVendoredPythonStubs(outputDir = OUTPUT_DIR) {
  const pyodideLockfile = readJsonFile(PYODIDE_LOCKFILE_PATH);
  const assets = [];
  const activeTargets = new Set(TARGETS.map((target) => target.distributionName));

  for (const legacyTargetName of ["webtypy"]) {
    if (!activeTargets.has(legacyTargetName)) {
      rmSync(resolve(outputDir, legacyTargetName), { force: true, recursive: true });
      rmSync(resolve(outputDir, `${legacyTargetName}.json`), { force: true });
    }
  }

  for (const target of TARGETS) {
    const result = await buildTarget(target, pyodideLockfile, outputDir);
    assets.push({
      ...result,
      distributionName: target.distributionName,
    });
  }

  return assets;
}

async function main() {
  const assets = await ensureVendoredPythonStubs();

  for (const asset of assets) {
    const prefix = asset.skipped ? "[vendor:stubs] up-to-date" : "[vendor:stubs] wrote";
    const details = asset.skipped ? "" : ` (${asset.fileCount} files)`;
    console.info(
      `${prefix} ${asset.distributionName}@${asset.version} -> ${asset.outputFilePath}${details}`,
    );
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[vendor:stubs] failed", error);
    process.exitCode = 1;
  });
}
