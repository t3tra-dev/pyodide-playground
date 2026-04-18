import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const crateDir = resolve(rootDir, "third-party/ruff/crates/ty_wasm");
const outputDir = resolve(rootDir, ".generated/ty-wasm");
const requiredOutputFiles = [
  "ty_wasm.js",
  "ty_wasm_bg.wasm",
  "ty_wasm.d.ts",
  "package.json",
];

function hasBuiltOutput() {
  return requiredOutputFiles.every((fileName) =>
    existsSync(resolve(outputDir, fileName)),
  );
}

export function getTyWasmOutputDir() {
  return outputDir;
}

export function ensureTyWasmBuilt(options = {}) {
  const force = options.force === true;
  if (!force && hasBuiltOutput()) {
    return;
  }

  mkdirSync(outputDir, { recursive: true });

  const relativeOutDir = relative(crateDir, outputDir);
  const result = spawnSync(
    "wasm-pack",
    ["build", "--target", "web", "--out-dir", relativeOutDir, "."],
    {
      cwd: crateDir,
      env: {
        ...process.env,
      },
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw new Error(`failed to start wasm-pack: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const signalSuffix = result.signal ? ` (signal: ${result.signal})` : "";
    throw new Error(
      `wasm-pack build failed with exit code ${result.status ?? 1}${signalSuffix}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  ensureTyWasmBuilt({
    force: process.argv.includes("--force"),
  });
}
