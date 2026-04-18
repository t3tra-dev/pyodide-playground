import { FileHandle, Position, Workspace } from "../../../.generated/ty-wasm/ty_wasm.js";
import {
  containsOpaqueAnyGenericHoverMarkdown,
  containsUnknownInHoverMarkdown,
  extractPrimaryTypeExpressionFromHoverMarkdown,
  extractPrimaryTypeNameFromHoverMarkdown,
  normalizeHoverMarkdown,
} from "./hoverMarkdownUtils";
import { findIdentifierOffset, offsetToPlainPosition } from "./sourceParsingUtils";

type TySourceIdentifierTypeInferenceOptions = {
  toTyPosition: (position?: { character?: number; line?: number }) => Position;
  workspace: Workspace;
};

export class TySourceIdentifierTypeInference {
  constructor(private readonly options: TySourceIdentifierTypeInferenceOptions) {}

  resolveTypeNameAtOffset(
    handle: FileHandle,
    sourceText: string,
    expressionStartOffset: number,
    expressionText: string,
  ) {
    const candidateOffsets = [
      expressionStartOffset + Math.max(0, expressionText.trimEnd().length - 1),
    ];

    if (!expressionText.includes(".")) {
      const firstIdentifierOffset = findIdentifierOffset(sourceText, expressionText.trim());
      if (firstIdentifierOffset !== -1) {
        candidateOffsets.push(firstIdentifierOffset);
      }
    }

    for (const candidateOffset of candidateOffsets) {
      const hover = this.options.workspace.hover(
        handle,
        this.options.toTyPosition(offsetToPlainPosition(sourceText, candidateOffset)),
      );
      const rawHoverMarkdown = hover?.markdown ?? "";
      const normalizedHoverMarkdown = normalizeHoverMarkdown(rawHoverMarkdown);
      const typeExpression = hover?.markdown
        ? extractPrimaryTypeExpressionFromHoverMarkdown(rawHoverMarkdown)
        : null;
      if (
        normalizedHoverMarkdown !== "@Todo" &&
        typeExpression &&
        !containsUnknownInHoverMarkdown(rawHoverMarkdown) &&
        !containsOpaqueAnyGenericHoverMarkdown(rawHoverMarkdown)
      ) {
        return typeExpression;
      }

      if (
        normalizedHoverMarkdown === "@Todo" ||
        containsUnknownInHoverMarkdown(rawHoverMarkdown) ||
        containsOpaqueAnyGenericHoverMarkdown(rawHoverMarkdown)
      ) {
        continue;
      }

      const typeName = hover?.markdown
        ? extractPrimaryTypeNameFromHoverMarkdown(rawHoverMarkdown)
        : null;
      if (typeName && typeName !== "Unknown") {
        return typeName;
      }
    }

    return null;
  }
}
