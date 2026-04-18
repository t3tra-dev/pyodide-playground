export const PYTHON_MAIN_FILE_NAME = "main.py";
export const PYTHON_MAIN_FILE_PATH = `/${PYTHON_MAIN_FILE_NAME}`;
export const PYTHON_MAIN_FILE_URI = `file://${PYTHON_MAIN_FILE_PATH}`;
export const PYTHON_JS_STUB_PACKAGE_PATH = "/js";
export const PYTHON_JS_STUB_PATH = `${PYTHON_JS_STUB_PACKAGE_PATH}/__init__.pyi`;

export type PythonEnvironmentFile = {
  content: string;
  path: string;
};

export type PythonEnvironmentImportRoot = {
  hasLocalStub: boolean;
  importName: string;
  isPackage: boolean;
  path: string;
  sitePath: string;
};

export type PythonEnvironmentPackage = {
  distributionName: string;
  importRoots: PythonEnvironmentImportRoot[];
  version: string;
};

export type PythonEnvironmentSnapshot = {
  extraPaths: string[];
  files: PythonEnvironmentFile[];
  packages: PythonEnvironmentPackage[];
  pythonVersion: string;
};
