import { FileHandle, Workspace } from "../../../.generated/ty-wasm/ty_wasm.js";
import { extractIdentifierAtOffset, findLatestAssignmentExpression } from "./sourceParsingUtils";

type TyAssignmentHoverInferenceOptions = {
  getMainHandle: () => FileHandle | undefined;
  resolveCalledMemberTypeFromSource: (
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions?: Set<string>,
  ) => string | null;
  resolveExpressionTypeNameFromSource: (
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions?: Set<string>,
  ) => string | null;
  workspace: Workspace;
};

export class TyAssignmentHoverInference {
  constructor(private readonly options: TyAssignmentHoverInferenceOptions) {}

  synthesizeVariableHoverFromAssignmentCall(
    uri: string,
    position?: { character?: number; line?: number },
  ) {
    if (uri !== "file:///main.py") {
      return null;
    }

    const mainHandle = this.options.getMainHandle();
    if (!mainHandle) {
      return null;
    }

    const sourceText = this.options.workspace.sourceText(mainHandle);
    const identifier = extractIdentifierAtOffset(sourceText, position);
    if (!identifier) {
      return null;
    }
    const assignmentExpression = findLatestAssignmentExpression(sourceText, identifier.identifier);
    const returnType = assignmentExpression?.trim()
      ? this.options.resolveCalledMemberTypeFromSource(
          mainHandle,
          sourceText,
          assignmentExpression.trim(),
        )
      : null;
    if (!returnType) {
      return null;
    }

    return {
      contents: {
        kind: "markdown",
        value: `\`\`\`python\n${returnType}\n\`\`\``,
      },
      range: null,
    };
  }

  synthesizeVariableHoverFromAssignmentExpression(
    uri: string,
    position?: { character?: number; line?: number },
  ) {
    if (uri !== "file:///main.py") {
      return null;
    }

    const mainHandle = this.options.getMainHandle();
    if (!mainHandle) {
      return null;
    }

    const sourceText = this.options.workspace.sourceText(mainHandle);
    const identifier = extractIdentifierAtOffset(sourceText, position);
    if (!identifier) {
      return null;
    }
    const assignmentExpression = findLatestAssignmentExpression(sourceText, identifier.identifier);

    const resolvedTypeName = assignmentExpression?.trim()
      ? this.options.resolveExpressionTypeNameFromSource(
          mainHandle,
          sourceText,
          assignmentExpression.trim(),
        )
      : null;
    if (!resolvedTypeName) {
      return null;
    }

    return {
      contents: {
        kind: "markdown",
        value: `\`\`\`python\n${resolvedTypeName}\n\`\`\``,
      },
      range: null,
    };
  }
}
