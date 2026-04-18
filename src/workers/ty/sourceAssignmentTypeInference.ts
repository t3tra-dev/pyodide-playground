import { FileHandle } from "../../../.generated/ty-wasm/ty_wasm.js";
import { findLatestAssignmentExpression } from "./sourceParsingUtils";

type TySourceAssignmentTypeInferenceOptions = {
  resolveExpressionTypeNameFromSource: (
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions?: Set<string>,
  ) => string | null;
};

export class TySourceAssignmentTypeInference {
  constructor(private readonly options: TySourceAssignmentTypeInferenceOptions) {}

  resolveAssignmentTypeFromSource(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions: Set<string>,
  ) {
    const assignmentExpression = findLatestAssignmentExpression(sourceText, expressionText);
    if (!assignmentExpression) {
      return null;
    }

    return this.options.resolveExpressionTypeNameFromSource(
      handle,
      sourceText,
      assignmentExpression,
      seenExpressions,
    );
  }
}
