import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { delimiter, dirname, relative, resolve } from "node:path";
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

function resolveCargoBinDir() {
  const homeDir = process.env.HOME;
  if (!homeDir) {
    return null;
  }

  const cargoBinDir = resolve(homeDir, ".cargo/bin");
  return existsSync(cargoBinDir) ? cargoBinDir : null;
}

function resolveWasmPackCommand() {
  const override = process.env.WASM_PACK_BIN;
  if (override) {
    return override;
  }

  const cargoBinDir = resolveCargoBinDir();
  if (cargoBinDir) {
    const cargoWasmPack = resolve(cargoBinDir, "wasm-pack");
    if (existsSync(cargoWasmPack)) {
      return cargoWasmPack;
    }
  }

  return "wasm-pack";
}

function buildWasmPackEnv() {
  const cargoBinDir = resolveCargoBinDir();
  const pathEntries = [
    ...(cargoBinDir ? [cargoBinDir] : []),
    ...(process.env.PATH ? [process.env.PATH] : []),
  ];

  return {
    ...process.env,
    PATH: pathEntries.join(delimiter),
  };
}

function runWasmPackBuild(relativeOutDir) {
  const env = buildWasmPackEnv();
  const wasmPackCommand = resolveWasmPackCommand();
  const wasmPackArgs = [
    "build",
    "--target",
    "web",
    "--out-dir",
    relativeOutDir,
    ".",
  ];

  const directResult = spawnSync(wasmPackCommand, wasmPackArgs, {
    cwd: crateDir,
    env,
    stdio: "inherit",
  });

  if (!directResult.error || directResult.error.code !== "ENOENT") {
    return directResult;
  }

  const shell = process.env.SHELL || "/usr/bin/bash";
  return spawnSync(
    shell,
    [
      "-lc",
      'source "$HOME/.cargo/env" && wasm-pack build --target web --out-dir "$1" .',
      "bash",
      relativeOutDir,
    ],
    {
      cwd: crateDir,
      env,
      stdio: "inherit",
    },
  );
}

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
  const result = runWasmPackBuild(relativeOutDir);

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
