import {
  parsePythonAst as parsePythonAstViaPyodide,
  type PythonAstNode,
  type PythonAstScalar,
  type PythonAstValue,
} from "./pyodideApi";

export type { PythonAstNode, PythonAstScalar, PythonAstValue };

export async function parsePythonAst(
  source: string,
  options: {
    filename?: string;
    mode?: "eval" | "exec" | "single";
  } = {},
) {
  return await parsePythonAstViaPyodide(source, options);
}
