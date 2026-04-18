import { dirname, extname, join, relative, resolve } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import {
  ensureTyWasmBuilt,
  getTyWasmOutputDir,
} from "./scripts/build-ty-wasm.mjs";
import {
  ensureVendoredPythonStubs,
  getVendoredStubsOutputDir,
} from "./scripts/vendor-pyodide-stubs.mjs";

const GITHUB_PAGES_BASE_PATH = "/pyodide-playground/";
const basePath =
  process.env.VITE_BASE_PATH?.trim() || (process.env.GITHUB_ACTIONS ? GITHUB_PAGES_BASE_PATH : "/");

function viteStaticCopyPyodide() {
  const pyodideDir = dirname(fileURLToPath(import.meta.resolve("pyodide")));

  return viteStaticCopy({
    targets: [
      {
        src: join(pyodideDir, "*"),
        dest: "pyodide",
        rename: { stripBase: true },
      },
    ],
  });
}

function getRequestRelativePath(requestUrl, prefix) {
  return decodeURIComponent(requestUrl.slice(prefix.length).split("?")[0]?.split("#")[0] ?? "");
}

function collectRelativeFiles(rootDir, currentDir = rootDir, files = []) {
  for (const entry of readdirSync(currentDir)) {
    const absolutePath = join(currentDir, entry);
    const entryStat = statSync(absolutePath);

    if (entryStat.isDirectory()) {
      collectRelativeFiles(rootDir, absolutePath, files);
      continue;
    }

    const relativePath = absolutePath.slice(rootDir.length + 1).replaceAll("\\", "/");
    files.push(relativePath);
  }

  return files;
}

function getTypeshedContentType(filePath) {
  switch (extname(filePath)) {
    case ".json":
      return "application/json; charset=utf-8";
    case ".md":
      return "text/markdown; charset=utf-8";
    case ".py":
    case ".pyi":
      return "text/x-python; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

function viteVendoredPythonStubAssets() {
  const stubPrefix = "/vendor/python-stubs/";
  let stubAssetsPromise;

  const ensureStubAssets = () => {
    stubAssetsPromise ??= ensureVendoredPythonStubs();
    return stubAssetsPromise;
  };

  const resolveVendoredStubPath = (requestUrl) => {
    const relativeRequestPath = getRequestRelativePath(requestUrl, stubPrefix);
    const resolvedPath = resolve(getVendoredStubsOutputDir(), relativeRequestPath);
    const relativeResolvedPath = relative(getVendoredStubsOutputDir(), resolvedPath);

    if (
      relativeResolvedPath.startsWith("..") ||
      relativeResolvedPath.includes("\\..") ||
      relativeResolvedPath === ""
    ) {
      return null;
    }

    const stats = statSync(resolvedPath, { throwIfNoEntry: false });
    if (!stats?.isFile()) {
      return null;
    }

    return resolvedPath;
  };

  return {
    name: "vendor-python-stubs",
    buildStart() {
      return ensureStubAssets();
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url ?? "";

        if (!requestUrl.startsWith(stubPrefix)) {
          next();
          return;
        }

        void ensureStubAssets()
          .then(() => {
            const resolvedPath = resolveVendoredStubPath(requestUrl);
            if (!resolvedPath) {
              next();
              return;
            }

            response.setHeader("Content-Type", getTypeshedContentType(resolvedPath));
            response.end(readFileSync(resolvedPath));
          })
          .catch(next);
      });
    },
    async generateBundle() {
      await ensureStubAssets();
      const outputDir = getVendoredStubsOutputDir();
      const relativeFiles = collectRelativeFiles(outputDir);

      for (const relativeFilePath of relativeFiles) {
        this.emitFile({
          type: "asset",
          fileName: `vendor/python-stubs/${relativeFilePath}`,
          source: readFileSync(resolve(outputDir, relativeFilePath)),
        });
      }
    },
  };
}

function viteTyWasmBuild() {
  let buildPromise;

  const ensureBuild = () => {
    buildPromise ??= Promise.resolve().then(() => {
      ensureTyWasmBuilt();
    });
    return buildPromise;
  };

  return {
    name: "ty-wasm-build",
    buildStart() {
      return ensureBuild();
    },
    configureServer(server) {
      server.watcher.add(getTyWasmOutputDir());
    },
  };
}

export default defineConfig({
  base: basePath,
  optimizeDeps: {
    exclude: ["pyodide"],
    include: ["react", "react-dom"],
  },
  plugins: [
    react(),
    viteTyWasmBuild(),
    viteStaticCopyPyodide(),
    viteVendoredPythonStubAssets(),
  ],
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  worker: {
    format: "es",
  },
  build: {
    chunkSizeWarningLimit: 1200,
  },
});
