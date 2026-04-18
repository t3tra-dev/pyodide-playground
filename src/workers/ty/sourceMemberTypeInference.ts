import { FileHandle } from "../../../.generated/ty-wasm/ty_wasm.js";
import {
  extractStringLiteralArgument,
  parseCallExpression,
  splitTopLevelCommaSeparated,
} from "./sourceParsingUtils";

type TySourceMemberTypeInferenceOptions = {
  resolveExpressionTypeNameFromSource: (
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions?: Set<string>,
  ) => string | null;
  resolveMemberTypeFromStubSources: (
    ownerTypeName: string,
    memberName: string,
    preferredStringLiteralArg?: string | null,
    callArgumentsSource?: string | null,
  ) => string | null;
};

export class TySourceMemberTypeInference {
  constructor(private readonly options: TySourceMemberTypeInferenceOptions) {}

  private extractNamedFunctionReturnType(sourceText: string, functionName: string) {
    const lines = sourceText.split("\n");
    const pattern = new RegExp(
      `^\\s*(?:async\\s+)?def\\s+${functionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`,
      "u",
    );

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      if (!pattern.test(line)) {
        continue;
      }

      let signatureSource = line.trim();
      for (let nextLineIndex = lineIndex + 1; nextLineIndex < lines.length; nextLineIndex++) {
        if (signatureSource.includes(":")) {
          break;
        }
        signatureSource += (lines[nextLineIndex] ?? "").trim();
      }

      const returnTypeMatch = signatureSource.match(/->\s*(.+?)\s*:/u);
      return returnTypeMatch?.[1]?.trim() ?? null;
    }

    return null;
  }

  private inferCallbackReturnTypeFromCall(sourceText: string, argumentsSource: string) {
    const firstArgument = splitTopLevelCommaSeparated(argumentsSource)[0]?.trim();
    if (!firstArgument || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(firstArgument)) {
      return null;
    }

    return this.extractNamedFunctionReturnType(sourceText, firstArgument);
  }

  resolveCalledMemberTypeFromSource(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions: Set<string>,
  ) {
    const callExpression = parseCallExpression(expressionText);
    if (!callExpression) {
      return null;
    }

    const lastDotIndex = callExpression.calleeExpression.lastIndexOf(".");
    if (lastDotIndex === -1) {
      return null;
    }

    const ownerExpression = callExpression.calleeExpression.slice(0, lastDotIndex);
    const memberName = callExpression.calleeExpression.slice(lastDotIndex + 1);
    if (!ownerExpression || !memberName) {
      return null;
    }

    const ownerTypeName = this.options.resolveExpressionTypeNameFromSource(
      handle,
      sourceText,
      ownerExpression,
      seenExpressions,
    );
    if (!ownerTypeName) {
      return null;
    }

    const resolvedMemberType = this.options.resolveMemberTypeFromStubSources(
      ownerTypeName,
      memberName,
      extractStringLiteralArgument(callExpression.argumentsSource),
      callExpression.argumentsSource,
    );
    if (!resolvedMemberType) {
      return null;
    }

    const callbackReturnType = this.inferCallbackReturnTypeFromCall(
      sourceText,
      callExpression.argumentsSource,
    );
    if (
      callbackReturnType &&
      memberName === "map" &&
      /^Array\[[^\]]+\]$/u.test(resolvedMemberType)
    ) {
      return `Array[${callbackReturnType}]`;
    }

    return resolvedMemberType;
  }

  resolveMemberAccessTypeFromSource(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions: Set<string>,
  ) {
    const memberAccessIndex = expressionText.lastIndexOf(".");
    if (memberAccessIndex === -1) {
      return null;
    }

    const ownerExpression = expressionText.slice(0, memberAccessIndex);
    const memberName = expressionText.slice(memberAccessIndex + 1);
    if (!ownerExpression || !memberName) {
      return null;
    }

    const ownerTypeName = this.options.resolveExpressionTypeNameFromSource(
      handle,
      sourceText,
      ownerExpression,
      seenExpressions,
    );
    if (!ownerTypeName) {
      return null;
    }

    return this.options.resolveMemberTypeFromStubSources(ownerTypeName, memberName, null, null);
  }
}
