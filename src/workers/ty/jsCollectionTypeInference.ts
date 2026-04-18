import { FileHandle } from "../../../.generated/ty-wasm/ty_wasm.js";
import {
  findLatestAssignmentExpression,
  parseCallExpression,
  splitTopLevelCommaSeparated,
} from "./sourceParsingUtils";
import { normalizeTypeParts } from "./typeTextUtils";

type TyJsCollectionTypeInferenceOptions = {
  resolveExpressionTypeNameFromSource: (
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions?: Set<string>,
  ) => string | null;
};

export class TyJsCollectionTypeInference {
  constructor(private readonly options: TyJsCollectionTypeInferenceOptions) {}

  private inferSourceLiteralTypeName(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions: Set<string>,
  ) {
    const normalizedExpression = expressionText.trim();
    if (!normalizedExpression) {
      return null;
    }

    if (/^(['"]).*\1$/su.test(normalizedExpression)) {
      return "str";
    }

    if (/^[+-]?\d+$/u.test(normalizedExpression)) {
      return "int";
    }

    if (/^[+-]?(?:\d+\.\d+|\.\d+)$/u.test(normalizedExpression)) {
      return "float";
    }

    if (normalizedExpression === "True" || normalizedExpression === "False") {
      return "bool";
    }

    return this.options.resolveExpressionTypeNameFromSource(
      handle,
      sourceText,
      normalizedExpression,
      seenExpressions,
    );
  }

  private resolveSequenceElementTypeNames(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions: Set<string>,
  ) {
    const normalizedExpression = expressionText.trim();
    if (!normalizedExpression) {
      return null;
    }

    const assignmentExpression = findLatestAssignmentExpression(sourceText, normalizedExpression);
    const resolvedExpression =
      assignmentExpression && assignmentExpression !== normalizedExpression
        ? assignmentExpression
        : normalizedExpression;

    const callExpression = parseCallExpression(resolvedExpression);
    if (
      !callExpression ||
      !/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*Array\.new$/u.test(
        callExpression.calleeExpression.replace(/\s+/gu, ""),
      )
    ) {
      return null;
    }

    const itemTypes = splitTopLevelCommaSeparated(callExpression.argumentsSource)
      .map((itemExpression) =>
        this.inferSourceLiteralTypeName(handle, sourceText, itemExpression, seenExpressions),
      )
      .filter((itemType): itemType is string => Boolean(itemType));

    const normalizedItemTypes = normalizeTypeParts(itemTypes);
    return normalizedItemTypes.length > 0 ? normalizedItemTypes : null;
  }

  resolveArrayTypeFromSource(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions: Set<string>,
  ): string | null {
    const normalizedExpression = expressionText.trim();
    if (!normalizedExpression) {
      return null;
    }

    const assignmentExpression = findLatestAssignmentExpression(sourceText, normalizedExpression);
    const resolvedExpression =
      assignmentExpression && assignmentExpression !== normalizedExpression
        ? assignmentExpression
        : normalizedExpression;

    const callExpression = parseCallExpression(resolvedExpression);
    if (
      !callExpression ||
      !/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*Array\.new$/u.test(
        callExpression.calleeExpression.replace(/\s+/gu, ""),
      )
    ) {
      return null;
    }

    const itemExpressions = splitTopLevelCommaSeparated(callExpression.argumentsSource);
    if (itemExpressions.length === 0) {
      return "Array[Any]";
    }

    if (
      itemExpressions.length === 1 &&
      /^[+-]?(?:\d+|\d+\.\d+|\.\d+)$/u.test(itemExpressions[0]?.trim() ?? "")
    ) {
      return null;
    }

    const itemTypes = itemExpressions
      .map((itemExpression) =>
        this.inferSourceLiteralTypeName(handle, sourceText, itemExpression, seenExpressions),
      )
      .filter((itemType): itemType is string => Boolean(itemType));

    const normalizedItemTypes = normalizeTypeParts(itemTypes);
    if (normalizedItemTypes.length === 0) {
      return null;
    }

    return `Array[${normalizedItemTypes.join(" | ")}]`;
  }

  resolveMapLikeTypeFromSource(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions: Set<string>,
  ): string | null {
    const normalizedExpression = expressionText.trim();
    if (!normalizedExpression) {
      return null;
    }

    const assignmentExpression = findLatestAssignmentExpression(sourceText, normalizedExpression);
    if (assignmentExpression && assignmentExpression !== normalizedExpression) {
      const resolvedAssignmentType = this.resolveMapLikeTypeFromSource(
        handle,
        sourceText,
        assignmentExpression,
        seenExpressions,
      );
      if (resolvedAssignmentType) {
        return resolvedAssignmentType;
      }
    }

    const callExpression = parseCallExpression(normalizedExpression);
    if (!callExpression) {
      return null;
    }

    const normalizedCalleeExpression = callExpression.calleeExpression.replace(/\s+/gu, "");
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*(?:Map|WeakMap)\.new$/u.test(normalizedCalleeExpression)) {
      return null;
    }

    const entryExpressions = splitTopLevelCommaSeparated(callExpression.argumentsSource);
    const firstEntryExpression = entryExpressions[0]?.trim();
    if (!firstEntryExpression) {
      return null;
    }

    const outerEntriesExpression =
      findLatestAssignmentExpression(sourceText, firstEntryExpression) ?? firstEntryExpression;
    const outerArrayCall = parseCallExpression(outerEntriesExpression);
    if (
      !outerArrayCall ||
      !/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*Array\.new$/u.test(
        outerArrayCall.calleeExpression.replace(/\s+/gu, ""),
      )
    ) {
      return null;
    }

    const keyTypes = [];
    const valueTypes = [];
    for (const pairExpression of splitTopLevelCommaSeparated(outerArrayCall.argumentsSource)) {
      const normalizedPairExpression =
        findLatestAssignmentExpression(sourceText, pairExpression.trim()) ?? pairExpression.trim();
      const pairArrayCall = parseCallExpression(normalizedPairExpression);
      if (
        !pairArrayCall ||
        !/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*Array\.new$/u.test(
          pairArrayCall.calleeExpression.replace(/\s+/gu, ""),
        )
      ) {
        return null;
      }

      const pairParts = splitTopLevelCommaSeparated(pairArrayCall.argumentsSource);
      if (pairParts.length !== 2) {
        return null;
      }

      const keyType = this.inferSourceLiteralTypeName(
        handle,
        sourceText,
        pairParts[0] ?? "",
        seenExpressions,
      );
      const valueType = this.inferSourceLiteralTypeName(
        handle,
        sourceText,
        pairParts[1] ?? "",
        seenExpressions,
      );
      if (!keyType || !valueType) {
        return null;
      }

      keyTypes.push(keyType);
      valueTypes.push(valueType);
    }

    const normalizedKeyTypes = normalizeTypeParts(keyTypes);
    const normalizedValueTypes = normalizeTypeParts(valueTypes);
    if (normalizedKeyTypes.length === 0 || normalizedValueTypes.length === 0) {
      return null;
    }

    const collectionTypeName = normalizedCalleeExpression.endsWith("WeakMap.new")
      ? "WeakMap"
      : "Map";
    return `${collectionTypeName}[${normalizedKeyTypes.join(" | ")}, ${normalizedValueTypes.join(" | ")}]`;
  }

  resolveSetLikeTypeFromSource(
    handle: FileHandle,
    sourceText: string,
    expressionText: string,
    seenExpressions: Set<string>,
  ): string | null {
    const normalizedExpression = expressionText.trim();
    if (!normalizedExpression) {
      return null;
    }

    const assignmentExpression = findLatestAssignmentExpression(sourceText, normalizedExpression);
    if (assignmentExpression && assignmentExpression !== normalizedExpression) {
      const resolvedAssignmentType = this.resolveSetLikeTypeFromSource(
        handle,
        sourceText,
        assignmentExpression,
        seenExpressions,
      );
      if (resolvedAssignmentType) {
        return resolvedAssignmentType;
      }
    }

    const callExpression = parseCallExpression(normalizedExpression);
    if (!callExpression) {
      return null;
    }

    const normalizedCalleeExpression = callExpression.calleeExpression.replace(/\s+/gu, "");
    if (!/^(?:[A-Za-z_][A-Za-z0-9_]*\.)*(?:Set|WeakSet)\.new$/u.test(normalizedCalleeExpression)) {
      return null;
    }

    const firstArgumentExpression = splitTopLevelCommaSeparated(
      callExpression.argumentsSource,
    )[0]?.trim();
    if (!firstArgumentExpression) {
      return null;
    }

    const itemTypes = this.resolveSequenceElementTypeNames(
      handle,
      sourceText,
      firstArgumentExpression,
      seenExpressions,
    );
    if (!itemTypes || itemTypes.length === 0) {
      return null;
    }

    const collectionTypeName = normalizedCalleeExpression.endsWith("WeakSet.new")
      ? "WeakSet"
      : "Set";
    return `${collectionTypeName}[${itemTypes.join(" | ")}]`;
  }
}
