import { FileHandle, Position, Workspace } from "../../../.generated/ty-wasm/ty_wasm.js";
import { TySourceAssignmentTypeInference } from "./sourceAssignmentTypeInference";
import { TySourceIdentifierTypeInference } from "./sourceIdentifierTypeInference";
import { TyJsCollectionTypeInference } from "./jsCollectionTypeInference";
import { TySourceMemberTypeInference } from "./sourceMemberTypeInference";
import { findIdentifierOffset } from "./sourceParsingUtils";

type TySourceTypeInferenceOptions = {
  getMainHandle: () => FileHandle | undefined;
  resolveMemberTypeFromStubSources: (
    ownerTypeName: string,
    memberName: string,
    preferredStringLiteralArg?: string | null,
    callArgumentsSource?: string | null,
  ) => string | null;
  toTyPosition: (position?: { character?: number; line?: number }) => Position;
  workspace: Workspace;
};

export class TySourceTypeInference {
  private readonly sourceAssignmentTypeInference: TySourceAssignmentTypeInference;
  private readonly sourceIdentifierTypeInference: TySourceIdentifierTypeInference;
  private readonly jsCollectionTypeInference: TyJsCollectionTypeInference;
  private readonly sourceMemberTypeInference: TySourceMemberTypeInference;

  constructor(private readonly options: TySourceTypeInferenceOptions) {
    this.sourceAssignmentTypeInference = new TySourceAssignmentTypeInference({
      resolveExpressionTypeNameFromSource: (handle, sourceText, expressionText, seenExpressions) =>
        this.resolveExpressionTypeNameFromSource(
          handle,
          sourceText,
          expressionText,
          seenExpressions,
        ),
    });
    this.sourceIdentifierTypeInference = new TySourceIdentifierTypeInference({
      toTyPosition: options.toTyPosition,
      workspace: options.workspace,
    });
    this.jsCollectionTypeInference = new TyJsCollectionTypeInference({
      resolveExpressionTypeNameFromSource: (handle, sourceText, expressionText, seenExpressions) =>
        this.resolveExpressionTypeNameFromSource(
          handle,
          sourceText,
          expressionText,
          seenExpressions,
        ),
    });
    this.sourceMemberTypeInference = new TySourceMemberTypeInference({
      resolveExpressionTypeNameFromSource: (handle, sourceText, expressionText, seenExpressions) =>
        this.resolveExpressionTypeNameFromSource(
          handle,
          sourceText,
          expressionText,
          seenExpressions,
        ),
      resolveMemberTypeFromStubSources: (
        ownerTypeName,
        memberName,
        preferredStringLiteralArg = null,
        callArgumentsSource = null,
      ) =>
        this.options.resolveMemberTypeFromStubSources(
          ownerTypeName,
          memberName,
          preferredStringLiteralArg,
          callArgumentsSource,
        ),
    });
  }

  resolveExpressionTypeNameAtOffset(
    handle: FileHandle,
    sourceText: string,
    expressionStartOffset: number,
    expressionText: string,
  ) {
    return this.sourceIdentifierTypeInference.resolveTypeNameAtOffset(
      handle,
      sourceText,
      expressionStartOffset,
      expressionText,
    );
  }

  resolveCalledMemberTypeFromSource(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions = new Set<string>(),
  ) {
    return this.sourceMemberTypeInference.resolveCalledMemberTypeFromSource(
      handle,
      sourceText,
      expressionText,
      seenExpressions,
    );
  }

  resolveExpressionTypeNameFromSource(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions = new Set<string>(),
  ): string | null {
    const normalizedExpression = expressionText.trim();
    if (!normalizedExpression) {
      return null;
    }

    if (seenExpressions.has(normalizedExpression)) {
      return null;
    }
    seenExpressions.add(normalizedExpression);

    const inferredJsArrayType = this.jsCollectionTypeInference.resolveArrayTypeFromSource(
      handle,
      sourceText,
      normalizedExpression,
      seenExpressions,
    );
    if (inferredJsArrayType) {
      return inferredJsArrayType;
    }

    const inferredJsCollectionType = this.jsCollectionTypeInference.resolveMapLikeTypeFromSource(
      handle,
      sourceText,
      normalizedExpression,
      seenExpressions,
    );
    if (inferredJsCollectionType) {
      return inferredJsCollectionType;
    }

    const inferredJsSetType = this.jsCollectionTypeInference.resolveSetLikeTypeFromSource(
      handle,
      sourceText,
      normalizedExpression,
      seenExpressions,
    );
    if (inferredJsSetType) {
      return inferredJsSetType;
    }

    if (/^[A-Z][A-Za-z0-9_]*$/u.test(normalizedExpression)) {
      return normalizedExpression;
    }

    const directIdentifierOffset = findIdentifierOffset(sourceText, normalizedExpression);
    if (directIdentifierOffset !== -1) {
      const directTypeName = this.sourceIdentifierTypeInference.resolveTypeNameAtOffset(
        handle,
        sourceText,
        directIdentifierOffset,
        normalizedExpression,
      );
      if (directTypeName && directTypeName !== "Unknown") {
        return directTypeName;
      }
    }

    const calledMemberType = this.sourceMemberTypeInference.resolveCalledMemberTypeFromSource(
      handle,
      sourceText,
      normalizedExpression,
      seenExpressions,
    );
    if (calledMemberType) {
      return calledMemberType;
    }

    const memberAccessType = this.sourceMemberTypeInference.resolveMemberAccessTypeFromSource(
      handle,
      sourceText,
      normalizedExpression,
      seenExpressions,
    );
    if (memberAccessType) {
      return memberAccessType;
    }

    const assignmentType = this.sourceAssignmentTypeInference.resolveAssignmentTypeFromSource(
      handle,
      sourceText,
      normalizedExpression,
      seenExpressions,
    );
    if (assignmentType) {
      return assignmentType;
    }

    return null;
  }
}
