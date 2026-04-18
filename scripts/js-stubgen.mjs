import { dirname, join } from "node:path";
import ts from "typescript";

const TYPE_SCRIPT_LIB_FILES = [
  "lib.es5.d.ts",
  "lib.es2015.core.d.ts",
  "lib.es2015.collection.d.ts",
  "lib.es2015.iterable.d.ts",
  "lib.es2015.promise.d.ts",
  "lib.es2015.proxy.d.ts",
  "lib.es2015.reflect.d.ts",
  "lib.es2015.symbol.d.ts",
  "lib.es2015.symbol.wellknown.d.ts",
  "lib.es2016.array.include.d.ts",
  "lib.es2017.object.d.ts",
  "lib.es2017.intl.d.ts",
  "lib.es2017.sharedmemory.d.ts",
  "lib.es2017.string.d.ts",
  "lib.es2017.typedarrays.d.ts",
  "lib.es2018.intl.d.ts",
  "lib.es2018.asynciterable.d.ts",
  "lib.es2018.promise.d.ts",
  "lib.es2020.bigint.d.ts",
  "lib.es2020.intl.d.ts",
  "lib.es2020.sharedmemory.d.ts",
  "lib.es2021.intl.d.ts",
  "lib.es2022.intl.d.ts",
  "lib.es2023.intl.d.ts",
  "lib.es2025.intl.d.ts",
  "lib.dom.d.ts",
  "lib.esnext.temporal.d.ts",
  "lib.esnext.intl.d.ts",
];
const HTML_DOCUMENT_CLASS_NAME = "HTMLDocument";
const GLOBAL_EVENT_HANDLERS_CLASS_NAME = "GlobalEventHandlers";
const GLOBAL_EVENT_HANDLERS_BASE_CLASS_NAME = "_JsGlobalEventHandlersBase";
const GLOBAL_EVENT_HANDLERS_EVENT_MAP_NAME = "GlobalEventHandlersEventMap";
const DOCUMENT_CLASS_NAME = "Document";
const DOCUMENT_BASE_CLASS_NAME = "_JsDocumentBase";
const DOCUMENT_EVENT_MAP_NAME = "DocumentEventMap";
const NODE_LIST_CLASS_NAME = "NodeList";
const NODE_LIST_BASE_CLASS_NAME = "_JsNodeListBase";
const HTML_ELEMENT_CLASS_NAME = "HTMLElement";
const HTML_ELEMENT_BASE_CLASS_NAME = "_JsHTMLElementBase";
const HTML_ELEMENT_EVENT_MAP_NAME = "HTMLElementEventMap";
const HTML_COLLECTION_CLASS_NAME = "HTMLCollection";
const HTML_COLLECTION_BASE_CLASS_NAME = "_JsHTMLCollectionBase";
const WINDOW_CLASS_NAME = "Window";
const WINDOW_BASE_CLASS_NAME = "_JsWindowBase";
const WINDOW_EVENT_MAP_NAME = "WindowEventMap";
const QUERYABLE_TAG_NAME_MAP_INTERFACE_NAMES = [
  "HTMLElementTagNameMap",
  "HTMLElementDeprecatedTagNameMap",
  "SVGElementTagNameMap",
  "MathMLElementTagNameMap",
];
const EXPLICIT_SYNTHETIC_CLASS_SPECS = [
  {
    additionalBases: [],
    className: HTML_DOCUMENT_CLASS_NAME,
    constructorInterfaceName: null,
    constructorVariableName: HTML_DOCUMENT_CLASS_NAME,
    instanceInterfaceName: HTML_DOCUMENT_CLASS_NAME,
    mode: "html-document",
  },
];
const EVENT_LISTENER_OVERLAY_SPECS = [
  {
    baseClassName: GLOBAL_EVENT_HANDLERS_BASE_CLASS_NAME,
    className: GLOBAL_EVENT_HANDLERS_CLASS_NAME,
    eventMapInterfaceName: GLOBAL_EVENT_HANDLERS_EVENT_MAP_NAME,
  },
  {
    baseClassName: DOCUMENT_BASE_CLASS_NAME,
    className: DOCUMENT_CLASS_NAME,
    eventMapInterfaceName: DOCUMENT_EVENT_MAP_NAME,
  },
  {
    baseClassName: HTML_ELEMENT_BASE_CLASS_NAME,
    className: HTML_ELEMENT_CLASS_NAME,
    eventMapInterfaceName: HTML_ELEMENT_EVENT_MAP_NAME,
  },
];
const ITERABLE_COLLECTION_OVERLAY_SPECS = [
  {
    baseClassName: NODE_LIST_BASE_CLASS_NAME,
    className: NODE_LIST_CLASS_NAME,
    itemType: "Node",
  },
  {
    baseClassName: HTML_COLLECTION_BASE_CLASS_NAME,
    className: HTML_COLLECTION_CLASS_NAME,
    itemType: "Element",
  },
];
const SYNTHETIC_SEQUENCE_CLASS_NAMES = new Set([
  "Array",
  "Float32Array",
  "Float64Array",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "ReadonlySet",
  "Set",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
]);
const SYNTHETIC_AWAITABLE_CLASS_NAMES = new Set(["Promise"]);
const SYNTHETIC_ITERABLE_CLASS_NAMES = new Set(["Map", "Set"]);
const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);
const IGNORED_INTERFACE_BASE_NAMES = new Set(["Pick", "Omit"]);
const CLASS_INSTANCE_METHOD_SKIP_NAMES = new Map([
  ["Array", new Set(["pop", "reverse", "sort"])],
  ["CallableFunction", new Set(["apply", "call", "bind"])],
  ["NewableFunction", new Set(["apply", "call", "bind"])],
  ["HTMLCollectionOf", new Set(["item"])],
  ["NodeListOf", new Set(["entries", "item", "forEach", "values"])],
]);
const CLASS_STATIC_METHOD_SKIP_NAMES = new Map([
  ["CSSNumericValue", new Set(["parse"])],
  ["Response", new Set(["json"])],
]);
const FLATTENED_MIXIN_CLASS_BASES = new Map([
  ["CharacterData", ["Node"]],
  ["Document", ["Node"]],
  ["DocumentFragment", ["Node"]],
  ["DocumentType", ["Node"]],
  ["Element", ["Node"]],
]);

function createTypeScriptContext() {
  const libDir = dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.Latest }));
  const rootNames = TYPE_SCRIPT_LIB_FILES.map((fileName) => join(libDir, fileName));
  const program = ts.createProgram({
    options: {
      noLib: true,
      target: ts.ScriptTarget.ESNext,
    },
    rootNames,
  });
  const interfaces = new Map();
  const typeAliases = new Map();
  const variables = new Map();

  const collectStatements = (statements) => {
    for (const statement of statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        const existingDeclarations = interfaces.get(statement.name.text) ?? [];
        existingDeclarations.push(statement);
        interfaces.set(statement.name.text, existingDeclarations);
        continue;
      }

      if (ts.isTypeAliasDeclaration(statement)) {
        typeAliases.set(statement.name.text, statement);
        continue;
      }

      if (ts.isModuleDeclaration(statement)) {
        const bodies = [];
        let currentBody = statement.body ?? null;
        while (currentBody) {
          if (ts.isModuleBlock(currentBody)) {
            bodies.push(currentBody);
            break;
          }
          if (ts.isModuleDeclaration(currentBody)) {
            currentBody = currentBody.body ?? null;
            continue;
          }
          break;
        }
        for (const body of bodies) {
          collectStatements(body.statements);
        }
        continue;
      }

      if (!ts.isVariableStatement(statement)) {
        continue;
      }

      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          variables.set(declaration.name.text, declaration);
        }
      }
    }
  };

  for (const fileName of rootNames) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
      throw new Error(`Failed to load TypeScript lib declaration: ${fileName}`);
    }
    collectStatements(sourceFile.statements);
  }

  return {
    interfaces,
    program,
    rootNames,
    typeAliases,
    variables,
  };
}

function collectStubClassNames(content) {
  return new Set(
    [...content.matchAll(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\([^\n]*\))?:/gm)]
      .map((match) => match[1] ?? "")
      .filter(Boolean),
  );
}

function collectStubClassBlocks(content) {
  const classMatches = [
    ...content.matchAll(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\([^\n]*\))?:/gm),
  ];
  return classMatches.map((match, index) => ({
    body: content.slice(match.index, classMatches[index + 1]?.index ?? content.length),
    end: classMatches[index + 1]?.index ?? content.length,
    name: match[1] ?? "",
    start: match.index ?? 0,
  }));
}

function collectStubClassMemberNames(blockText) {
  const memberNames = new Set();

  for (const match of blockText.matchAll(/^\s{4}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) {
    if (match[1]) {
      memberNames.add(match[1]);
    }
  }

  for (const match of blockText.matchAll(/^\s{4}def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)) {
    if (match[1]) {
      memberNames.add(match[1]);
    }
  }

  return memberNames;
}

function collectStubTopLevelAnnotatedNames(content) {
  return new Set(
    [...content.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)]
      .map((match) => match[1] ?? "")
      .filter(Boolean),
  );
}

function collectTypeParameterNames(declarations) {
  const names = [];
  const seen = new Set();

  for (const declaration of declarations ?? []) {
    for (const entry of declaration.typeParameters ?? []) {
      const name = toPythonIdentifier(entry.name.text);
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

function renderErasedGenericClassReference(context, className) {
  const typeParameterNames = collectTypeParameterNames(getInterfaceDeclarations(context, className));
  if (typeParameterNames.length === 0) {
    return className;
  }

  return `${className}[${typeParameterNames.map(() => PY_ANY).join(", ")}]`;
}

function getTypeReferenceAliasName(typeName) {
  return `_JsTypeRef_${typeName}`;
}

function renderAliasedGenericType(typeName, typeArguments, options = {}) {
  const aliasName = options.typeReferenceAliases?.get(typeName) ?? typeName;
  return renderExplicitGenericType(aliasName, typeArguments);
}

function renderIteratorLikeType(typeName, typeArguments = []) {
  const yieldedType = typeArguments[0] ?? PY_ANY;
  const returnType = typeArguments[1] ?? PY_ANY;
  const nextType = typeArguments[2] ?? PY_ANY;
  return renderExplicitGenericType(typeName, [yieldedType, returnType, nextType]);
}

function collectInterfaceMemberNames(interfaceDeclarations) {
  const memberNames = new Set();

  for (const declaration of Array.isArray(interfaceDeclarations)
    ? interfaceDeclarations
    : interfaceDeclarations
      ? [interfaceDeclarations]
      : []) {
    for (const member of declaration.members ?? []) {
      if (!("name" in member) || !member.name) {
        continue;
      }

      if (ts.isIdentifier(member.name)) {
        memberNames.add(member.name.text);
        continue;
      }

      if (ts.isStringLiteral(member.name)) {
        memberNames.add(member.name.text);
      }
    }
  }

  return memberNames;
}

function getConstructorFacadeClassName(targetClassName, constructorInterfaceName) {
  if (constructorInterfaceName && constructorInterfaceName.endsWith("Constructor")) {
    return constructorInterfaceName;
  }

  return `${targetClassName}Constructor`;
}

function getSyntheticClassAdditionalBases(className, classTypeParameterNames = []) {
  const itemType = classTypeParameterNames[0] ?? PY_ANY;
  const keyType = classTypeParameterNames[0] ?? PY_ANY;
  const valueType = classTypeParameterNames[1] ?? PY_ANY;

  switch (className) {
    case "Array":
      return [`list[${itemType}]`];
    case "Map":
      return [renderExplicitGenericType("ReadonlyMap", [keyType, valueType])];
    case "Set":
      return [renderExplicitGenericType("ReadonlySet", [itemType])];
    case "ReadonlyArray":
    case "ArrayLike":
      return [`${PY_SEQUENCE}[${itemType}]`];
    default:
      break;
  }

  if (SYNTHETIC_AWAITABLE_CLASS_NAMES.has(className)) {
    return [`${PY_AWAITABLE}[${itemType}]`];
  }

  if (SYNTHETIC_ITERABLE_CLASS_NAMES.has(className)) {
    return [renderIteratorLikeType("Iterable", [itemType])];
  }

  if (SYNTHETIC_SEQUENCE_CLASS_NAMES.has(className)) {
    return [`${PY_SEQUENCE}[${itemType}]`];
  }

  return [];
}

function isValidPythonIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name);
}

function toPythonIdentifier(name) {
  if (!isValidPythonIdentifier(name)) {
    return null;
  }

  return PYTHON_KEYWORDS.has(name) ? `${name}_` : name;
}

function renderEntityName(entityName) {
  if (ts.isIdentifier(entityName)) {
    return entityName.text;
  }

  if (ts.isQualifiedName(entityName)) {
    return entityName.right.text;
  }

  return entityName.getText();
}

function getInterfaceDeclarations(context, interfaceName) {
  return context.interfaces.get(interfaceName) ?? [];
}

function getInterfaceDeclarationsRecursive(context, interfaceName, seen = new Set()) {
  if (!interfaceName || seen.has(interfaceName)) {
    return [];
  }

  seen.add(interfaceName);
  const declarations = getInterfaceDeclarations(context, interfaceName);
  const nestedDeclarations = declarations.flatMap((declaration) =>
    getInterfaceBaseIdentifiers(declaration).flatMap((baseName) =>
      getInterfaceDeclarationsRecursive(context, baseName, seen),
    ),
  );

  return [...declarations, ...nestedDeclarations];
}

function getInterfaceMembers(interfaceDeclarations) {
  const declarations = Array.isArray(interfaceDeclarations)
    ? interfaceDeclarations
    : interfaceDeclarations
      ? [interfaceDeclarations]
      : [];

  return declarations.flatMap((declaration) => Array.from(declaration.members ?? []));
}

function renderHeritageBaseName(typeNode, renderTypeOptions = {}) {
  if (ts.isExpressionWithTypeArguments(typeNode)) {
    const baseIdentifier = renderEntityName(typeNode.expression);
    if (!baseIdentifier || IGNORED_INTERFACE_BASE_NAMES.has(baseIdentifier)) {
      return null;
    }
    const renderedTypeArguments = (typeNode.typeArguments ?? []).map((entry) =>
      renderTypeNode(entry, renderTypeOptions),
    );
    if (baseIdentifier === "ReadonlyArray") {
      const itemType = renderedTypeArguments[0] ?? PY_ANY;
      return `${PY_SEQUENCE}[${itemType}]`;
    }
    return renderExplicitGenericType(baseIdentifier, renderedTypeArguments);
  }

  return null;
}

function getInterfaceBaseIdentifiers(interfaceDeclarations) {
  const baseNames = [];
  const declarations = Array.isArray(interfaceDeclarations)
    ? interfaceDeclarations
    : interfaceDeclarations
      ? [interfaceDeclarations]
      : [];

  for (const interfaceDeclaration of declarations) {
    for (const heritageClause of interfaceDeclaration.heritageClauses ?? []) {
      if (heritageClause.token !== ts.SyntaxKind.ExtendsKeyword) {
        continue;
      }

      for (const typeNode of heritageClause.types) {
        const baseIdentifier = renderEntityName(typeNode.expression);
        if (baseIdentifier && !IGNORED_INTERFACE_BASE_NAMES.has(baseIdentifier)) {
          baseNames.push(baseIdentifier);
        }
      }
    }
  }

  return Array.from(new Set(baseNames));
}

function getInterfaceBaseNames(interfaceDeclarations, renderTypeOptions = {}) {
  const baseNames = [];
  const declarations = Array.isArray(interfaceDeclarations)
    ? interfaceDeclarations
    : interfaceDeclarations
      ? [interfaceDeclarations]
      : [];

  for (const interfaceDeclaration of declarations) {
    for (const heritageClause of interfaceDeclaration.heritageClauses ?? []) {
      if (heritageClause.token !== ts.SyntaxKind.ExtendsKeyword) {
        continue;
      }

      for (const typeNode of heritageClause.types) {
        const baseIdentifier = renderEntityName(typeNode.expression);
        if (baseIdentifier && IGNORED_INTERFACE_BASE_NAMES.has(baseIdentifier)) {
          continue;
        }
        const baseName =
          renderHeritageBaseName(typeNode, renderTypeOptions) ??
          baseIdentifier;
        if (baseName) {
          baseNames.push(baseName);
        }
      }
    }
  }

  return Array.from(new Set(baseNames));
}

function interfaceExtends(context, interfaceName, targetName, seen = new Set()) {
  if (!interfaceName || seen.has(interfaceName)) {
    return false;
  }
  if (interfaceName === targetName) {
    return true;
  }

  seen.add(interfaceName);
  for (const baseName of getInterfaceBaseIdentifiers(getInterfaceDeclarations(context, interfaceName))) {
    if (interfaceExtends(context, baseName, targetName, seen)) {
      return true;
    }
  }

  return false;
}

function getTypeAliasDeclaration(context, aliasName) {
  return context.typeAliases.get(aliasName) ?? null;
}

function isTypedDictCompatibleInterface(interfaceDeclarations) {
  const declarations = Array.isArray(interfaceDeclarations)
    ? interfaceDeclarations
    : interfaceDeclarations
      ? [interfaceDeclarations]
      : [];

  if (declarations.length === 0) {
    return false;
  }

  return declarations.every((declaration) =>
    Array.from(declaration.members ?? []).every((member) =>
      ts.isPropertySignature(member) ||
      ts.isMethodSignature(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member),
    ),
  );
}

function classifyTypeReferenceUsage(typeNode) {
  let current = typeNode;

  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isUnionTypeNode(parent) ||
      ts.isIntersectionTypeNode(parent) ||
      ts.isArrayTypeNode(parent) ||
      ts.isTupleTypeNode(parent) ||
      ts.isParenthesizedTypeNode(parent) ||
      ts.isTypeOperatorNode(parent) ||
      ts.isIndexedAccessTypeNode(parent) ||
      ts.isLiteralTypeNode(parent) ||
      ts.isConditionalTypeNode(parent) ||
      ts.isMappedTypeNode(parent) ||
      ts.isTypeLiteralNode(parent) ||
      ts.isTypeReferenceNode(parent)
    ) {
      current = parent;
      continue;
    }

    if (ts.isParameter(parent) && parent.type === current) {
      return { kind: "parameter", ownerName: null };
    }

    if (ts.isPropertySignature(parent) && parent.type === current) {
      const owner = parent.parent;
      return {
        kind: "property",
        ownerName:
          owner && ts.isInterfaceDeclaration(owner) ? owner.name.text : null,
      };
    }

    if (
      (ts.isMethodSignature(parent) ||
        ts.isFunctionTypeNode(parent) ||
        ts.isConstructSignatureDeclaration(parent) ||
        ts.isCallSignatureDeclaration(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isTypeAliasDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isHeritageClause(parent)) &&
      "type" in parent &&
      parent.type === current
    ) {
      if (ts.isTypeAliasDeclaration(parent)) {
        return { kind: "alias", ownerName: parent.name.text };
      }
      if (ts.isVariableDeclaration(parent)) {
        return { kind: "variable", ownerName: null };
      }
      if (ts.isHeritageClause(parent)) {
        return { kind: "heritage", ownerName: null };
      }
      return { kind: "return", ownerName: null };
    }

    break;
  }

  return { kind: "other", ownerName: null };
}

function collectTypedDictInterfaceNames(context, availableClassNames) {
  const candidateNames = new Set();
  const preferredTypedDictNames = new Set();

  for (const interfaceName of context.interfaces.keys()) {
    if (!shouldEmitInterfaceAsClass(interfaceName)) {
      continue;
    }

    const declarations = getInterfaceDeclarations(context, interfaceName);
    if (declarations.length === 0) {
      continue;
    }

    if (!isTypedDictCompatibleInterface(declarations)) {
      continue;
    }

    const constructorSource = getConstructorSourceForClass(context, interfaceName);
    if (constructorSource) {
      continue;
    }

    candidateNames.add(interfaceName);
    if (/(?:Init|InitDict|Options|Params|Settings|Configuration|Bag|Info)$/u.test(interfaceName)) {
      preferredTypedDictNames.add(interfaceName);
    }
  }

  let expandedPreferredTypedDicts = true;
  while (expandedPreferredTypedDicts) {
    expandedPreferredTypedDicts = false;
    for (const interfaceName of Array.from(preferredTypedDictNames)) {
      for (const baseName of getInterfaceBaseIdentifiers(getInterfaceDeclarations(context, interfaceName))) {
        if (!candidateNames.has(baseName) || preferredTypedDictNames.has(baseName)) {
          continue;
        }
        preferredTypedDictNames.add(baseName);
        expandedPreferredTypedDicts = true;
      }
    }
  }

  const directlyExposedNames = new Set();
  const classifyTypeReferenceUsageFromAncestors = (node, ancestors) => {
    let current = node;

    for (let index = ancestors.length - 1; index >= 0; index--) {
      const parent = ancestors[index];
      if (
        ts.isUnionTypeNode(parent) ||
        ts.isIntersectionTypeNode(parent) ||
        ts.isArrayTypeNode(parent) ||
        ts.isTupleTypeNode(parent) ||
        ts.isParenthesizedTypeNode(parent) ||
        ts.isTypeOperatorNode(parent) ||
        ts.isIndexedAccessTypeNode(parent) ||
        ts.isLiteralTypeNode(parent) ||
        ts.isConditionalTypeNode(parent) ||
        ts.isMappedTypeNode(parent) ||
        ts.isTypeLiteralNode(parent) ||
        ts.isTypeReferenceNode(parent)
      ) {
        current = parent;
        continue;
      }

      if (ts.isParameter(parent) && parent.type === current) {
        return { kind: "parameter", ownerName: null };
      }

      if (ts.isPropertySignature(parent) && parent.type === current) {
        const owner = ancestors
          .slice(0, index)
          .reverse()
          .find((entry) => ts.isInterfaceDeclaration(entry));
        return {
          kind: "property",
          ownerName: owner && ts.isInterfaceDeclaration(owner) ? owner.name.text : null,
        };
      }

      if (ts.isTypeAliasDeclaration(parent) && parent.type === current) {
        return { kind: "alias", ownerName: parent.name.text };
      }

      if (ts.isVariableDeclaration(parent) && parent.type === current) {
        return { kind: "variable", ownerName: null };
      }

      if (
        (ts.isMethodSignature(parent) ||
          ts.isFunctionTypeNode(parent) ||
          ts.isConstructSignatureDeclaration(parent) ||
          ts.isCallSignatureDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isFunctionDeclaration(parent)) &&
        parent.type === current
      ) {
        return { kind: "return", ownerName: null };
      }

      return { kind: "other", ownerName: null };
    }

    return { kind: "other", ownerName: null };
  };

  for (const fileName of context.rootNames) {
    const sourceFile = context.program.getSourceFile(fileName);
    if (!sourceFile) {
      continue;
    }

    const visit = (node, ancestors = []) => {
      if (ts.isExpressionWithTypeArguments(node)) {
        const typeName = renderEntityName(node.expression);
        if (candidateNames.has(typeName)) {
          directlyExposedNames.add(typeName);
        }
      }

      if (ts.isTypeReferenceNode(node)) {
        const typeName = renderEntityName(node.typeName);
        if (candidateNames.has(typeName)) {
          const usage = classifyTypeReferenceUsageFromAncestors(node, ancestors);
          if (
            usage.kind === "return" ||
            usage.kind === "variable" ||
            usage.kind === "heritage" ||
            usage.kind === "other"
          ) {
            directlyExposedNames.add(typeName);
          } else if (
            usage.kind === "property" &&
            usage.ownerName &&
            !candidateNames.has(usage.ownerName)
          ) {
            directlyExposedNames.add(typeName);
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
    };

    visit(sourceFile);
  }

  const typedDictNames = new Set(
    Array.from(candidateNames).filter(
      (name) => preferredTypedDictNames.has(name) || !directlyExposedNames.has(name),
    ),
  );

  for (const interfaceName of context.interfaces.keys()) {
    if (typedDictNames.has(interfaceName)) {
      continue;
    }

    const baseNames = getInterfaceBaseIdentifiers(getInterfaceDeclarations(context, interfaceName));
    for (const baseName of baseNames) {
      if (typedDictNames.has(baseName)) {
        typedDictNames.delete(baseName);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const name of Array.from(typedDictNames)) {
      const baseNames = getInterfaceBaseIdentifiers(getInterfaceDeclarations(context, name));
      if (baseNames.some((baseName) => !typedDictNames.has(baseName))) {
        typedDictNames.delete(name);
        changed = true;
      }
    }
  }

  return Array.from(typedDictNames).sort((left, right) => left.localeCompare(right));
}

function renderLiteralValue(node) {
  if (ts.isStringLiteral(node)) {
    return JSON.stringify(node.text);
  }

  if (ts.isNumericLiteral(node)) {
    return node.text;
  }

  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
      return "True";
    case ts.SyntaxKind.FalseKeyword:
      return "False";
    case ts.SyntaxKind.NullKeyword:
      return "None";
    default:
      return null;
  }
}

function normalizeUnionParts(parts) {
  const normalized = [];
  const seen = new Set();

  for (const part of parts) {
    const nextPart = String(part || PY_ANY).trim() || PY_ANY;
    if (seen.has(nextPart)) {
      continue;
    }
    seen.add(nextPart);
    normalized.push(nextPart);
  }

  return normalized;
}

function renderTupleTypeNode(node, options = {}) {
  const elementTypes = [];

  for (const element of node.elements) {
    if (ts.isNamedTupleMember(element)) {
      elementTypes.push(renderTypeNode(element.type, options));
      continue;
    }

    if (ts.isOptionalTypeNode(element)) {
      elementTypes.push(ensureOptionalType(renderTypeNode(element.type, options)));
      continue;
    }

    if (ts.isRestTypeNode(element)) {
      return renderAliasedGenericType(
        "ReadonlyArray",
        [renderRestElementType(element.type, options)],
        options,
      );
    }

    elementTypes.push(renderTypeNode(element, options));
  }

  const normalizedElementTypes = normalizeUnionParts(elementTypes);
  return renderAliasedGenericType(
    "ReadonlyArray",
    [normalizedElementTypes.join(" | ") || PY_ANY],
    options,
  );
}

function renderTypeParameterList(typeParameters) {
  const parameterNames = [];
  const seen = new Set();

  for (const entry of typeParameters ?? []) {
    const name = toPythonIdentifier(entry.name.text);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    parameterNames.push(name);
  }

  return parameterNames.length > 0 ? `[${parameterNames.join(", ")}]` : "";
}

const CLASS_TYPE_PARAMETER_VARIANCE = new Map();

function renderClassTypeParameterList(typeParameters, className) {
  const parameterNames = [];
  const seen = new Set();
  const varianceMap = CLASS_TYPE_PARAMETER_VARIANCE.get(className) ?? null;

  for (const entry of typeParameters ?? []) {
    const rawName = toPythonIdentifier(entry.name.text);
    if (!rawName || seen.has(rawName)) {
      continue;
    }
    seen.add(rawName);
    parameterNames.push(varianceMap?.get(rawName) ?? rawName);
  }

  return parameterNames.length > 0 ? `[${parameterNames.join(", ")}]` : "";
}

function renderExplicitGenericType(typeName, typeArguments) {
  return typeArguments.length > 0 ? `${typeName}[${typeArguments.join(", ")}]` : typeName;
}

function renderCurrentClassType(currentClassName, currentClassTypeParameterNames = []) {
  if (!currentClassName) {
    return PY_ANY;
  }

  return renderExplicitGenericType(currentClassName, currentClassTypeParameterNames);
}

function renderCallableType(node, options = {}) {
  if (!ts.isFunctionTypeNode(node) && !ts.isConstructorTypeNode(node)) {
    return PY_ANY;
  }

  const typeParameterNames = new Set(options.typeParameterNames ?? []);
  const erasedTypeParameterNames = new Set(options.erasedTypeParameterNames ?? []);
  for (const typeParameter of node.typeParameters ?? []) {
    erasedTypeParameterNames.add(typeParameter.name.text);
  }

  const callableParameters = [];
  for (const parameter of node.parameters) {
    if (parameter.dotDotDotToken) {
      return `${PY_CALLABLE}[..., ${renderTypeNode(node.type, {
        ...options,
        erasedTypeParameterNames,
        typeParameterNames,
      })}]`;
    }

    if (
      ts.isIdentifier(parameter.name) &&
      parameter.name.text === "this"
    ) {
      continue;
    }

    callableParameters.push(
      renderTypeNode(parameter.type, {
        ...options,
        erasedTypeParameterNames,
        position: "parameter",
        typeParameterNames,
      }),
    );
  }

  const renderedParameters =
    callableParameters.length > 0 ? `[${callableParameters.join(", ")}]` : "[]";

  return `${PY_CALLABLE}[${renderedParameters}, ${renderTypeNode(node.type, {
    ...options,
    erasedTypeParameterNames,
    typeParameterNames,
  })}]`;
}

function renderTypeNode(node, options = {}) {
  if (!node) {
    return PY_ANY;
  }

  const {
    currentClassName = null,
    currentClassTypeParameterNames = [],
    erasedTypeParameterNames = new Set(),
    position = "annotation",
    typeParameterNames = new Set(),
  } = options;

  if (ts.isParenthesizedTypeNode(node)) {
    return renderTypeNode(node.type, options);
  }

  if (ts.isLiteralTypeNode(node)) {
    const literalValue = renderLiteralValue(node.literal);
    if (literalValue == null) {
      return PY_ANY;
    }
    return literalValue === "None" ? "None" : `${PY_LITERAL}[${literalValue}]`;
  }

  if (ts.isUnionTypeNode(node)) {
    return normalizeUnionParts(node.types.map((entry) => renderTypeNode(entry, options))).join(
      " | ",
    );
  }

  if (ts.isArrayTypeNode(node)) {
    return renderAliasedGenericType(
      "Array",
      [renderTypeNode(node.elementType, options)],
      options,
    );
  }

  if (ts.isTupleTypeNode(node)) {
    return renderTupleTypeNode(node, options);
  }

  if (ts.isTypePredicateNode(node)) {
    return "bool";
  }

  if (ts.isTypeReferenceNode(node)) {
    const typeName = renderEntityName(node.typeName);
    const typeArguments = node.typeArguments ?? [];
    const renderedTypeArguments = typeArguments.map((entry) => renderTypeNode(entry, options));
    const firstTypeArgument = renderedTypeArguments[0] ?? PY_ANY;

    if (erasedTypeParameterNames.has(typeName)) {
      return PY_ANY;
    }

    if (typeParameterNames.has(typeName)) {
      return typeName;
    }

    switch (typeName) {
      case "string":
      case "DOMString":
      case "ByteString":
      case "USVString":
        return "str";
      case "number":
        return "float";
      case "boolean":
        return "bool";
      case "undefined":
      case "null":
      case "never":
      case "void":
        return "None";
      case "Array":
        return renderAliasedGenericType("Array", renderedTypeArguments, options);
      case "ReadonlyArray":
        return renderAliasedGenericType("ReadonlyArray", renderedTypeArguments, options);
      case "ArrayLike":
        return renderAliasedGenericType("ArrayLike", renderedTypeArguments, options);
      case "ConcatArray":
        return renderAliasedGenericType("ReadonlyArray", renderedTypeArguments, options);
      case "AsyncIterable":
      case "AsyncIterator":
      case "AsyncIterableIterator":
        return renderIteratorLikeType(typeName, renderedTypeArguments);
      case "Iterable":
        return renderIteratorLikeType("Iterable", renderedTypeArguments);
      case "Iterator":
      case "IterableIterator":
        return renderIteratorLikeType(typeName, renderedTypeArguments);
      case "NodeListOf":
      case "HTMLCollectionOf":
        return `${PY_SEQUENCE}[${firstTypeArgument}]`;
      case "ReadonlySet":
        return renderAliasedGenericType("ReadonlySet", renderedTypeArguments, options);
      case "Set":
        return renderAliasedGenericType("Set", renderedTypeArguments, options);
      case "Map":
        return renderAliasedGenericType("Map", renderedTypeArguments, options);
      case "ReadonlyMap":
        return renderAliasedGenericType("ReadonlyMap", renderedTypeArguments, options);
      case "Promise":
        return renderAliasedGenericType("Promise", renderedTypeArguments, options);
      case "PromiseLike":
        return `${PY_AWAITABLE}[${firstTypeArgument}]`;
      case "Awaited":
        return firstTypeArgument;
      case "Partial":
      case "Record":
        return `dict[${renderedTypeArguments[0] ?? PY_ANY}, ${renderedTypeArguments[1] ?? PY_ANY}]`;
      case "Pick":
      case "Omit":
      case "Exclude":
      case "Extract":
      case "Required":
      case "Readonly":
      case "Uppercase":
      case "Lowercase":
      case "Capitalize":
      case "Uncapitalize":
        return PY_ANY;
      default:
        return renderAliasedGenericType(typeName, renderedTypeArguments, options);
    }
  }

  if (ts.isThisTypeNode(node)) {
    return renderCurrentClassType(currentClassName, currentClassTypeParameterNames);
  }

  if (
    ts.isFunctionTypeNode(node) ||
    ts.isConstructorTypeNode(node)
  ) {
    return renderCallableType(node, options);
  }

  if (
    ts.isTypeLiteralNode(node) ||
    ts.isMappedTypeNode(node) ||
    ts.isConditionalTypeNode(node) ||
    ts.isIndexedAccessTypeNode(node) ||
    ts.isImportTypeNode(node) ||
    ts.isInferTypeNode(node) ||
    ts.isTypeQueryNode(node)
  ) {
    return PY_ANY;
  }

  if (ts.isIntersectionTypeNode(node)) {
    const parts = normalizeUnionParts(
      node.types
        .map((entry) => renderTypeNode(entry, options))
        .filter((entry) => entry !== PY_ANY),
    );
    return parts.length === 1 ? parts[0] : PY_ANY;
  }

  if (ts.isTypeOperatorNode(node)) {
    if (node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      if (ts.isArrayTypeNode(node.type)) {
        return renderExplicitGenericType("ReadonlyArray", [
          renderTypeNode(node.type.elementType, options),
        ]);
      }

      if (ts.isTupleTypeNode(node.type)) {
        return renderTupleTypeNode(node.type, options);
      }

      if (ts.isTypeReferenceNode(node.type)) {
        const typeName = renderEntityName(node.type.typeName);
        const renderedTypeArguments = (node.type.typeArguments ?? []).map((entry) =>
          renderTypeNode(entry, options),
        );

        switch (typeName) {
          case "Array":
            return renderAliasedGenericType("ReadonlyArray", renderedTypeArguments, options);
          case "Set":
            return renderAliasedGenericType("ReadonlySet", renderedTypeArguments, options);
          case "Map":
            return renderAliasedGenericType("ReadonlyMap", renderedTypeArguments, options);
          default:
            break;
        }
      }
    }

    return renderTypeNode(node.type, options);
  }

  switch (node.kind) {
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword:
      return PY_ANY;
    case ts.SyntaxKind.StringKeyword:
      return "str";
    case ts.SyntaxKind.NumberKeyword:
      return "float";
    case ts.SyntaxKind.BooleanKeyword:
      return "bool";
    case ts.SyntaxKind.VoidKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.NeverKeyword:
      return "None";
    case ts.SyntaxKind.ObjectKeyword:
      return "object";
    default:
      return PY_ANY;
  }
}

function renderRestElementType(node, options = {}) {
  if (!node) {
    return PY_ANY;
  }

  if (ts.isArrayTypeNode(node)) {
    return renderTypeNode(node.elementType, options);
  }

  if (ts.isTypeReferenceNode(node)) {
    const typeName = renderEntityName(node.typeName);
    if (
      [
        "Array",
        "ReadonlyArray",
        "ArrayLike",
        "Iterable",
        "Iterator",
        "IterableIterator",
        "ReadonlySet",
        "Set",
      ].includes(typeName)
    ) {
      return node.typeArguments?.[0]
        ? renderTypeNode(node.typeArguments[0], options)
        : PY_ANY;
    }
  }

  return PY_ANY;
}

function ensureOptionalType(typeText) {
  const parts = normalizeUnionParts(typeText.split("|").map((entry) => entry.trim()));
  if (!parts.includes("None")) {
    parts.push("None");
  }
  return parts.join(" | ");
}

function renderParameter(parameter, options = {}) {
  const name =
    ts.isIdentifier(parameter.name) && parameter.name.text
      ? parameter.name.text
      : "value";
  const pythonName = toPythonIdentifier(name) ?? "value";
  const typeParameterNames = new Set(options.typeParameterNames ?? []);
  if (parameter.typeParameters) {
    for (const typeParameter of parameter.typeParameters) {
      typeParameterNames.add(typeParameter.name.text);
    }
  }

  if (parameter.dotDotDotToken) {
    return `*${pythonName}: ${renderRestElementType(parameter.type, {
      ...options,
      typeParameterNames,
    })}`;
  }

  let typeText = renderTypeNode(parameter.type, {
    ...options,
    position: "parameter",
    typeParameterNames,
  });
  if (parameter.questionToken || parameter.initializer) {
    typeText = ensureOptionalType(typeText);
    return `${pythonName}: ${typeText} = None`;
  }

  return `${pythonName}: ${typeText}`;
}

function renderCallableTypeFromSignature(signature, options = {}) {
  const typeParameterNames = new Set(options.typeParameterNames ?? []);
  const erasedTypeParameterNames = new Set(
    (signature.typeParameters ?? []).map((typeParameter) => typeParameter.name.text),
  );

  const callableParameters = [];
  for (const parameter of signature.parameters ?? []) {
    if (parameter.dotDotDotToken) {
      return `${PY_CALLABLE}[..., ${renderTypeNode(signature.type, {
        ...options,
        erasedTypeParameterNames,
        position: "return",
        typeParameterNames,
      })}]`;
    }

    if (ts.isIdentifier(parameter.name) && parameter.name.text === "this") {
      continue;
    }

    let parameterTypeText = renderTypeNode(parameter.type, {
      ...options,
      erasedTypeParameterNames,
      position: "parameter",
      typeParameterNames,
    });
    if (parameter.questionToken || parameter.initializer) {
      parameterTypeText = ensureOptionalType(parameterTypeText);
    }
    callableParameters.push(parameterTypeText);
  }

  const renderedParameters =
    callableParameters.length > 0 ? `[${callableParameters.join(", ")}]` : "[]";
  const returnType = renderTypeNode(signature.type, {
    ...options,
    erasedTypeParameterNames,
    position: "return",
    typeParameterNames,
  });
  return `${PY_CALLABLE}[${renderedParameters}, ${returnType}]`;
}

function emitSignatureBlock(name, signatures, options = {}) {
  const pythonName = toPythonIdentifier(name);
  if (!pythonName || signatures.length === 0) {
    return [];
  }

  const orderedSignatures = [...signatures];
  if (
    pythonName === "resolve" &&
    (options.currentClassName === "Promise" || options.currentClassName === "PromiseConstructor")
  ) {
    orderedSignatures.sort((left, right) => {
      const leftParameters = left.parameters.filter(
        (parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"),
      );
      const rightParameters = right.parameters.filter(
        (parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"),
      );
      if (leftParameters.length !== rightParameters.length) {
        return rightParameters.length - leftParameters.length;
      }

      const leftFirstType = leftParameters[0]?.type
        ? renderTypeNode(leftParameters[0].type, options.renderTypeOptions ?? {})
        : "";
      const rightFirstType = rightParameters[0]?.type
        ? renderTypeNode(rightParameters[0].type, options.renderTypeOptions ?? {})
        : "";
      const leftAwaitable = leftFirstType.includes("Awaitable");
      const rightAwaitable = rightFirstType.includes("Awaitable");
      if (leftAwaitable !== rightAwaitable) {
        return Number(leftAwaitable) - Number(rightAwaitable);
      }
      return 0;
    });
  }

  const lines = [];
  const overloadCount = orderedSignatures.length;
  const indent = options.indent ?? "    ";

  for (const signature of orderedSignatures) {
    const enclosingTypeParameterNames = new Set(options.currentClassTypeParameterNames ?? []);
    const signatureTypeParameters = (signature.typeParameters ?? []).filter(
      (typeParameter) => !enclosingTypeParameterNames.has(typeParameter.name.text),
    );
    const typeParameterNames = new Set(options.typeParameterNames ?? []);
    for (const typeParameter of signatureTypeParameters) {
      typeParameterNames.add(typeParameter.name.text);
    }
    const typeParameterList = renderTypeParameterList(signatureTypeParameters);
    const parameters = signature.parameters.map((parameter) =>
      renderParameter(parameter, {
        ...(options.renderTypeOptions ?? {}),
        currentClassName: options.currentClassName ?? null,
        currentClassTypeParameterNames: options.currentClassTypeParameterNames ?? [],
        typeParameterNames,
      }),
    );
    const parameterList = parameters.length > 0 ? `, ${parameters.join(", ")}` : "";
    const returnType = renderTypeNode(signature.type, {
      ...(options.renderTypeOptions ?? {}),
      currentClassName: options.currentClassName ?? null,
      currentClassTypeParameterNames: options.currentClassTypeParameterNames ?? [],
      position: "return",
      typeParameterNames,
    });

    if (overloadCount > 1) {
      lines.push(`${indent}${PY_OVERLOAD_DECORATOR}`);
    }
    if (options.classMethod) {
      lines.push(`${indent}@classmethod`);
    }
    if (options.staticMethod) {
      lines.push(`${indent}@staticmethod`);
    }
    const selfParameter =
      options.includeSelf === false
        ? ""
        : options.classMethod
          ? "cls"
          : options.staticMethod
            ? ""
            : "self";
    let prefix =
      selfParameter && parameterList.length > 0
        ? `${selfParameter}${parameterList}`
        : selfParameter || parameterList.slice(2);
    if (
      options.positionalOnly &&
      parameters.length > 0 &&
      !signature.parameters.some((parameter) => parameter.dotDotDotToken) &&
      !parameters.some((parameter) => parameter.startsWith("*"))
    ) {
      prefix = prefix.length > 0 ? `${prefix}, /` : "/";
    }
    lines.push(
      `${indent}def ${pythonName}${typeParameterList}(${prefix}) -> ${returnType}: ...`,
    );
  }

  return lines;
}

function emitExpandedArrayConstructorOverloads() {
  const lines = [
    `    ${PY_OVERLOAD_DECORATOR}`,
    "    @staticmethod",
    `    def new(arrayLength: float | None = None, /) -> Array[${PY_ANY}]: ...`,
    `    ${PY_OVERLOAD_DECORATOR}`,
    "    @staticmethod",
    "    def new[U](arrayLength: float, /) -> Array[U]: ...",
    `    ${PY_OVERLOAD_DECORATOR}`,
    "    @staticmethod",
    "    def new[U](item1: U, /) -> Array[U]: ...",
  ];

  for (let arity = 2; arity <= 8; arity++) {
    const parameters = Array.from({ length: arity }, (_, index) => `item${index + 1}: U`)
      .join(", ");
    lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
    lines.push("    @staticmethod");
    lines.push(`    def new[U](${parameters}, /) -> Array[U]: ...`);
  }

  lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
  lines.push("    @staticmethod");
  lines.push("    def new[U](*items: U) -> Array[U]: ...");
  return lines;
}

function emitExpandedMapConstructorOverloads(className = "Map", renderTypeOptions = {}) {
  const mapType = renderAliasedGenericType(className, [PY_ANY, PY_ANY], renderTypeOptions);
  const mapGenericType = (left, right) =>
    renderAliasedGenericType(className, [left, right], renderTypeOptions);
  const readonlyArrayType = (itemType) =>
    renderAliasedGenericType("ReadonlyArray", [itemType], renderTypeOptions);
  const lines = [
    `    ${PY_OVERLOAD_DECORATOR}`,
    "    @staticmethod",
    `    def new() -> ${mapType}: ...`,
    `    ${PY_OVERLOAD_DECORATOR}`,
    "    @staticmethod",
    `    def new[TKey, TValue](entries: ${readonlyArrayType("tuple[TKey, TValue]")} | None = None, /) -> ${mapGenericType("TKey", "TValue")}: ...`,
    `    ${PY_OVERLOAD_DECORATOR}`,
    "    @staticmethod",
    `    def new[T](entries: ${readonlyArrayType(readonlyArrayType("T"))} | None = None, /) -> ${mapGenericType("T", "T")}: ...`,
    `    ${PY_OVERLOAD_DECORATOR}`,
    "    @staticmethod",
    `    def new[TKey, TValue](iterable: Iterable[tuple[TKey, TValue], ${PY_ANY}, ${PY_ANY}] | None = None, /) -> ${mapGenericType("TKey", "TValue")}: ...`,
    `    ${PY_OVERLOAD_DECORATOR}`,
    "    @staticmethod",
    `    def new[T](iterable: Iterable[${readonlyArrayType("T")}, ${PY_ANY}, ${PY_ANY}] | None = None, /) -> ${mapGenericType("T", "T")}: ...`,
  ];

  return lines;
}

function getSignatureCacheKey(signature) {
  const sourceFile =
    typeof signature.getSourceFile === "function" ? signature.getSourceFile() : null;
  if (sourceFile) {
    return signature.getText(sourceFile);
  }

  const parameters = (signature.parameters ?? []).map((parameter) => {
    const name = ts.isIdentifier(parameter.name) ? parameter.name.text : "value";
    const typeText = parameter.type ? renderTypeNode(parameter.type) : PY_ANY;
    const optional = parameter.questionToken || parameter.initializer ? "?" : "";
    const rest = parameter.dotDotDotToken ? "..." : "";
    return `${rest}${name}:${typeText}${optional}`;
  });
  const returnType = signature.type ? renderTypeNode(signature.type) : PY_ANY;
  return `${parameters.join(",")}=>${returnType}`;
}

function collectConstructSignaturesForClass(context, className, seen = new Set()) {
  if (seen.has(className)) {
    return [];
  }
  seen.add(className);

  const signatures = [];
  const seenTexts = new Set();

  for (const baseName of getInterfaceBaseIdentifiers(getInterfaceDeclarations(context, className))) {
    for (const signature of collectConstructSignaturesForClass(context, baseName, seen)) {
      const signatureText = getSignatureCacheKey(signature);
      if (seenTexts.has(signatureText)) {
        continue;
      }
      seenTexts.add(signatureText);
      signatures.push(signature);
    }
  }

  const constructorSource = getConstructorSourceForClass(context, className);
  if (constructorSource) {
    for (const member of getInterfaceMembers(constructorSource)) {
      if (!ts.isConstructSignatureDeclaration(member)) {
        continue;
      }
      const signatureText = getSignatureCacheKey(member);
      if (seenTexts.has(signatureText)) {
        continue;
      }
      seenTexts.add(signatureText);
      signatures.push(member);
    }
  }

  return signatures;
}

function emitClassConstructorMembers(context, className, options = {}) {
  const interfaceDeclaration = getConstructorSourceForClass(context, className);
  if (!interfaceDeclaration) {
    return [];
  }

  if (
    !["Array", "Map", "Set", "WeakMap", "WeakSet"].includes(className) &&
    (
      interfaceExtends(context, className, "Map") ||
      interfaceExtends(context, className, "Set") ||
      interfaceExtends(context, className, "WeakMap") ||
      interfaceExtends(context, className, "WeakSet")
    )
  ) {
    return [];
  }

  const members = getInterfaceMembers(interfaceDeclaration);
  if (members.length === 0) {
    return [];
  }

  const currentClassTypeParameterNames = collectTypeParameterNames(
    getInterfaceDeclarations(context, className),
  );

  const lines = [];
  if (className === "Array") {
    lines.push(...emitExpandedArrayConstructorOverloads());
  } else if (className === "Map" || className === "WeakMap") {
    lines.push(...emitExpandedMapConstructorOverloads(className, options.renderTypeOptions ?? {}));
  } else {
    lines.push(
      ...emitSignatureBlock("new", collectConstructSignaturesForClass(context, className), {
        staticMethod: true,
        positionalOnly: true,
        currentClassName: className,
        currentClassTypeParameterNames,
        renderTypeOptions: options.renderTypeOptions ?? {},
      }),
    );
  }

  const groupedMethods = new Map();
  const skippedMethodNames = options.skipMethodNames ?? new Set();
  for (const member of members) {
    if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name)) {
      continue;
    }
    if (skippedMethodNames.has(member.name.text)) {
      continue;
    }
    if (!groupedMethods.has(member.name.text)) {
      groupedMethods.set(member.name.text, []);
    }
    groupedMethods.get(member.name.text).push(member);
  }

  for (const [methodName, signatures] of groupedMethods) {
    lines.push(
      ...emitSignatureBlock(methodName, signatures, {
        staticMethod: true,
        currentClassName: className,
        currentClassTypeParameterNames,
        renderTypeOptions: options.renderTypeOptions ?? {},
      }),
    );
  }

  return lines;
}

function emitConstructorFacadeMembers(interfaceDeclaration, className, options = {}) {
  const members = getInterfaceMembers(interfaceDeclaration);
  if (members.length === 0) {
    return [];
  }

  const lines = [];
  const constructSignatures = members.filter((member) =>
    ts.isConstructSignatureDeclaration(member),
  );
  if (className === "Array") {
    lines.push(...emitExpandedArrayConstructorOverloads());
  } else if (className === "Map" || className === "WeakMap") {
    lines.push(...emitExpandedMapConstructorOverloads(className, options.renderTypeOptions ?? {}));
  } else {
    lines.push(
      ...emitSignatureBlock("new", constructSignatures, {
        staticMethod: true,
        positionalOnly: true,
        currentClassName: className,
        currentClassTypeParameterNames: [],
        renderTypeOptions: options.renderTypeOptions ?? {},
      }),
    );
  }

  const groupedMethods = new Map();
  for (const member of members) {
    if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name)) {
      continue;
    }
    if (!groupedMethods.has(member.name.text)) {
      groupedMethods.set(member.name.text, []);
    }
    groupedMethods.get(member.name.text).push(member);
  }

  for (const [methodName, signatures] of groupedMethods) {
    lines.push(
      ...emitSignatureBlock(methodName, signatures, {
        staticMethod: true,
        currentClassName: className,
        currentClassTypeParameterNames: [],
        renderTypeOptions: options.renderTypeOptions ?? {},
      }),
    );
  }

  return lines;
}

function emitInstanceMembers(interfaceDeclaration, className, options = {}) {
  const members = getInterfaceMembers(interfaceDeclaration);
  if (members.length === 0) {
    return [];
  }

  const lines = [];
  const skippedMemberNames = new Set(options.skipMemberNames ?? []);
  const propertyEntries = new Map();
  const interfaceTypeParameterNames = new Set();
  const interfaceDeclarations = Array.isArray(interfaceDeclaration)
    ? interfaceDeclaration
    : interfaceDeclaration
      ? [interfaceDeclaration]
      : [];
  for (const declaration of interfaceDeclarations) {
    for (const entry of declaration.typeParameters ?? []) {
      interfaceTypeParameterNames.add(entry.name.text);
    }
  }

  const recordPropertyEntry = (name, typeText, priority) => {
    if (!name || skippedMemberNames.has(name) || name === "prototype") {
      return;
    }
    const pythonName = toPythonIdentifier(name);
    if (!pythonName) {
      return;
    }

    const existingEntry = propertyEntries.get(pythonName);
    if (existingEntry && existingEntry.priority > priority) {
      return;
    }

    propertyEntries.set(pythonName, { priority, typeText });
  };

  for (const member of members) {
    if (!("name" in member) || !member.name || !ts.isIdentifier(member.name)) {
      continue;
    }

    if (ts.isPropertySignature(member)) {
      let typeText = renderTypeNode(member.type, {
        ...(options.renderTypeOptions ?? {}),
        currentClassName: className,
        currentClassTypeParameterNames: Array.from(interfaceTypeParameterNames),
        position: "annotation",
        typeParameterNames: interfaceTypeParameterNames,
      });
      if (member.questionToken) {
        typeText = ensureOptionalType(typeText);
      }
      recordPropertyEntry(member.name.text, typeText, 1);
      continue;
    }

    if (ts.isGetAccessorDeclaration(member)) {
      const typeText = renderTypeNode(member.type, {
        ...(options.renderTypeOptions ?? {}),
        currentClassName: className,
        currentClassTypeParameterNames: Array.from(interfaceTypeParameterNames),
        position: "annotation",
        typeParameterNames: interfaceTypeParameterNames,
      });
      recordPropertyEntry(member.name.text, typeText, 2);
      continue;
    }

    if (ts.isSetAccessorDeclaration(member)) {
      const setterParameter = member.parameters?.[0];
      const typeText = renderTypeNode(setterParameter?.type, {
        ...(options.renderTypeOptions ?? {}),
        currentClassName: className,
        currentClassTypeParameterNames: Array.from(interfaceTypeParameterNames),
        position: "annotation",
        typeParameterNames: interfaceTypeParameterNames,
      });
      recordPropertyEntry(member.name.text, typeText, 0);
    }
  }

  for (const [pythonName, { typeText }] of propertyEntries.entries()) {
    lines.push(`    ${pythonName}: ${typeText}`);
  }

  const groupedMethods = new Map();
  for (const member of members) {
    if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name)) {
      continue;
    }
    if (skippedMemberNames.has(member.name.text)) {
      continue;
    }
    if (!groupedMethods.has(member.name.text)) {
      groupedMethods.set(member.name.text, []);
    }
    groupedMethods.get(member.name.text).push(member);
  }

  if (className === "Promise") {
    lines.push(
      `    def __await__(self) -> ${PY_GENERATOR}[${PY_ANY}, None, T]: ...`,
      `    ${PY_OVERLOAD_DECORATOR}`,
      "    def then(self) -> Promise[T]: ...",
      `    ${PY_OVERLOAD_DECORATOR}`,
      `    def then[TResult1](self, onfulfilled: ${PY_CALLABLE}[[T], TResult1 | ${PY_AWAITABLE}[TResult1]]) -> Promise[TResult1]: ...`,
      `    ${PY_OVERLOAD_DECORATOR}`,
      `    def then[TResult2](self, onfulfilled: None = None, onrejected: ${PY_CALLABLE}[[${PY_ANY}], TResult2 | ${PY_AWAITABLE}[TResult2]] | None = None) -> Promise[T | TResult2]: ...`,
      `    ${PY_OVERLOAD_DECORATOR}`,
      `    def then[TResult1, TResult2](self, onfulfilled: ${PY_CALLABLE}[[T], TResult1 | ${PY_AWAITABLE}[TResult1]], onrejected: ${PY_CALLABLE}[[${PY_ANY}], TResult2 | ${PY_AWAITABLE}[TResult2]] | None = None) -> Promise[TResult1 | TResult2]: ...`,
      `    ${PY_OVERLOAD_DECORATOR}`,
      "    def catch(self) -> Promise[T]: ...",
      `    ${PY_OVERLOAD_DECORATOR}`,
      `    def catch[TResult](self, onrejected: ${PY_CALLABLE}[[${PY_ANY}], TResult | ${PY_AWAITABLE}[TResult]] | None = None) -> Promise[T | TResult]: ...`,
      `    def finally_(self, onfinally: ${PY_CALLABLE}[[], ${PY_ANY}] | None = None) -> Promise[T]: ...`,
    );
    groupedMethods.delete("then");
    groupedMethods.delete("catch");
    groupedMethods.delete("finally");
  }

  if (className === "Iterator") {
    lines.push(
      "    def __iter__(self) -> t.Self: ...",
      "    def __next__(self) -> T: ...",
    );
  }

  if (className === "AsyncIterator") {
    lines.push(
      "    def __aiter__(self) -> t.Self: ...",
      `    def __anext__(self) -> ${PY_AWAITABLE}[T]: ...`,
    );
  }

  if (className === "ReadonlyMap") {
    lines.push(
      "    def __iter__(self) -> MapIterator[tuple[K, V]]: ...",
      "    def entries(self) -> MapIterator[tuple[K, V]]: ...",
    );
    groupedMethods.delete("entries");
  }

  if (className === "Map") {
    lines.push(
      "    def __iter__(self) -> MapIterator[tuple[K, V]]: ...",
      "    def entries(self) -> MapIterator[tuple[K, V]]: ...",
    );
    groupedMethods.delete("entries");
  }

  if (className === "Document" && groupedMethods.has("open")) {
    lines.push(
      `    ${PY_OVERLOAD_DECORATOR}`,
      "    def open(self, unused1: str | None = None, unused2: str | None = None) -> Document: ...",
      `    ${PY_OVERLOAD_DECORATOR}`,
      "    def open(self, url: str | URLType, name: str, features: str) -> WindowProxy | None: ...",
    );
    groupedMethods.delete("open");
  }

  for (const [methodName, signatures] of groupedMethods) {
    lines.push(
      ...emitSignatureBlock(methodName, signatures, {
        classMethod: false,
        currentClassName: className,
        currentClassTypeParameterNames: Array.from(interfaceTypeParameterNames),
        renderTypeOptions: options.renderTypeOptions ?? {},
        typeParameterNames: interfaceTypeParameterNames,
      }),
    );
  }

  return lines;
}

function collectTagNameEntries(context, interfaceNames) {
  const entries = [];

  for (const interfaceName of interfaceNames) {
    for (const interfaceDeclaration of getInterfaceDeclarations(context, interfaceName)) {
      for (const member of interfaceDeclaration.members) {
        if (
          !ts.isPropertySignature(member) ||
          !member.type ||
          !member.name ||
          (!ts.isStringLiteral(member.name) && !ts.isIdentifier(member.name))
        ) {
          continue;
        }

        const tagName = ts.isStringLiteral(member.name) ? member.name.text : member.name.text;
        const returnType = renderTypeNode(member.type);
        entries.push({
          returnType,
          tagName,
        });
      }
    }
  }

  return entries
    .sort((left, right) => left.tagName.localeCompare(right.tagName))
    .filter(
      (entry, index, array) =>
        index === 0 ||
        entry.tagName !== array[index - 1].tagName ||
        entry.returnType !== array[index - 1].returnType,
    );
}

function shouldEmitInterfaceAsClass(interfaceName) {
  return !(
    interfaceName.endsWith("Constructor") ||
    interfaceName.endsWith("EventMap") ||
    interfaceName.endsWith("TagNameMap")
  );
}

function collectEventMapEntries(context, interfaceName, renderTypeOptions = {}) {
  const entries = [];

  for (const interfaceDeclaration of getInterfaceDeclarationsRecursive(context, interfaceName)) {
    for (const member of interfaceDeclaration.members) {
      if (
        !ts.isPropertySignature(member) ||
        !member.type ||
        !member.name ||
        (!ts.isStringLiteral(member.name) && !ts.isIdentifier(member.name))
      ) {
        continue;
      }

      const eventName = ts.isStringLiteral(member.name) ? member.name.text : member.name.text;
      const eventType = renderTypeNode(member.type, renderTypeOptions);
      entries.push({
        eventName,
        eventType,
      });
    }
  }

  return entries
    .sort((left, right) => left.eventName.localeCompare(right.eventName))
    .filter(
      (entry, index, array) =>
        index === 0 ||
        entry.eventName !== array[index - 1].eventName ||
        entry.eventType !== array[index - 1].eventType,
    );
}

function getEventMapInterfaceNameForClass(context, className) {
  if (className === GLOBAL_EVENT_HANDLERS_CLASS_NAME) {
    return GLOBAL_EVENT_HANDLERS_EVENT_MAP_NAME;
  }
  if (className === DOCUMENT_CLASS_NAME) {
    return DOCUMENT_EVENT_MAP_NAME;
  }
  if (className === HTML_ELEMENT_CLASS_NAME) {
    return HTML_ELEMENT_EVENT_MAP_NAME;
  }
  if (className === WINDOW_CLASS_NAME) {
    return WINDOW_EVENT_MAP_NAME;
  }

  const candidateName = `${className}EventMap`;
  return context.interfaces.has(candidateName) ? candidateName : null;
}

function buildEventListenerMethodLines(context, eventMapInterfaceName, renderTypeOptions = {}) {
  const eventMapEntries = collectEventMapEntries(context, eventMapInterfaceName, renderTypeOptions);
  if (eventMapEntries.length === 0) {
    return [];
  }

  const lines = [];

  for (const entry of eventMapEntries) {
    lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
    lines.push(
      `    def addEventListener(self, type: ${PY_LITERAL}[${JSON.stringify(entry.eventName)}], callback: ${PY_CALLABLE}[[${entry.eventType}], ${PY_ANY}] | None, options: AddEventListenerOptions | bool | None = None) -> None: ...`,
    );
  }
  lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
  lines.push(
    "    def addEventListener(self, type: str, callback: EventListenerOrEventListenerObject | None, options: AddEventListenerOptions | bool | None = None) -> None: ...",
  );

  for (const entry of eventMapEntries) {
    lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
    lines.push(
      `    def removeEventListener(self, type: ${PY_LITERAL}[${JSON.stringify(entry.eventName)}], callback: ${PY_CALLABLE}[[${entry.eventType}], ${PY_ANY}] | None, options: EventListenerOptions | bool | None = None) -> None: ...`,
    );
  }
  lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
  lines.push(
    "    def removeEventListener(self, type: str, callback: EventListenerOrEventListenerObject | None, options: EventListenerOptions | bool | None = None) -> None: ...",
  );

  return lines;
}

function getConstructorSourceForClass(context, className) {
  const matches = [];

  for (const [variableName, declaration] of context.variables.entries()) {
    if (!isConstructibleGlobalVariable(variableName, declaration)) {
      continue;
    }

    const targetClassName = getVariableDeclarationTargetClassName(
      variableName,
      declaration,
      new Set([className]),
    );
    if (targetClassName !== className) {
      continue;
    }

    const constructorTypeNode = declaration?.type;
    const constructorInterfaceDeclarations =
      constructorTypeNode &&
      ts.isTypeReferenceNode(constructorTypeNode) &&
      renderEntityName(constructorTypeNode.typeName).endsWith("Constructor")
        ? getInterfaceDeclarations(context, renderEntityName(constructorTypeNode.typeName))
        : null;
    const typeLiteralSource =
      declaration?.type && ts.isTypeLiteralNode(declaration.type) ? declaration.type : null;

    matches.push({
      priority: variableName === className ? 0 : 1,
      source: constructorInterfaceDeclarations && constructorInterfaceDeclarations.length > 0
        ? constructorInterfaceDeclarations
        : typeLiteralSource,
    });
  }

  matches.sort((left, right) => left.priority - right.priority);
  return matches[0]?.source ?? null;
}

function getVariableDeclarationTargetClassName(variableName, declaration, availableClassNames) {
  const candidateClassName = getVariableDeclarationCandidateClassName(variableName, declaration);
  if (!candidateClassName) {
    return null;
  }

  return availableClassNames.has(candidateClassName) ? candidateClassName : null;
}

function getVariableDeclarationValueTypeName(variableName, declaration) {
  if (variableName === "Document" || variableName === "HTMLDocument") {
    return HTML_DOCUMENT_CLASS_NAME;
  }

  const typeNode = declaration?.type;
  if (!typeNode || !ts.isTypeReferenceNode(typeNode)) {
    return null;
  }

  const referenceName = renderEntityName(typeNode.typeName);
  if (referenceName === "Document" || referenceName === "HTMLDocument") {
    return HTML_DOCUMENT_CLASS_NAME;
  }

  return referenceName;
}

function getVariableDeclarationExposedTypeName(variableName, declaration) {
  if (isConstructibleGlobalVariable(variableName, declaration)) {
    return getVariableDeclarationCandidateClassName(variableName, declaration);
  }

  return getVariableDeclarationValueTypeName(variableName, declaration);
}

function getVariableDeclarationCandidateClassName(variableName, declaration) {
  if (variableName === "Document" || variableName === "HTMLDocument") {
    return HTML_DOCUMENT_CLASS_NAME;
  }

  const typeNode = declaration?.type;
  if (
    variableName &&
    /^[A-Z][A-Za-z0-9_]*$/u.test(variableName) &&
    typeNode &&
    ts.isTypeLiteralNode(typeNode)
  ) {
    return variableName;
  }

  if (!typeNode) {
    return null;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    const referenceName = renderEntityName(typeNode.typeName);
    if (referenceName.endsWith("Constructor")) {
      const candidateName = referenceName.slice(0, -"Constructor".length);
      if (candidateName === "Document" || candidateName === "HTMLDocument") {
        return HTML_DOCUMENT_CLASS_NAME;
      }
      return candidateName;
    }
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    for (const member of typeNode.members) {
      if (
        ts.isPropertySignature(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === "prototype" &&
        member.type
      ) {
        const prototypeTypeName = renderTypeNode(member.type);
        if (
          prototypeTypeName === "Document" ||
          prototypeTypeName === "HTMLDocument"
        ) {
          return HTML_DOCUMENT_CLASS_NAME;
        }
        return prototypeTypeName;
      }
    }
  }

  return null;
}

function isConstructibleGlobalVariable(variableName, declaration) {
  if (!/^[A-Z][A-Za-z0-9_]*$/u.test(variableName)) {
    return false;
  }

  const typeNode = declaration?.type;
  if (!typeNode) {
    return false;
  }

  if (ts.isTypeReferenceNode(typeNode)) {
    return renderEntityName(typeNode.typeName).endsWith("Constructor");
  }

  if (ts.isTypeLiteralNode(typeNode)) {
    return typeNode.members.some(
      (member) =>
        ts.isConstructSignatureDeclaration(member) ||
        (ts.isPropertySignature(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === "prototype"),
    );
  }

  return false;
}

function collectWindowConstructorAliases(context, availableClassNames) {
  const aliases = [];

  for (const [variableName, declaration] of context.variables.entries()) {
    if (!isConstructibleGlobalVariable(variableName, declaration)) {
      continue;
    }

    const targetClassName = getVariableDeclarationTargetClassName(
      variableName,
      declaration,
      availableClassNames,
    );
    if (!targetClassName || targetClassName === "Window") {
      continue;
    }

    aliases.push({
      facadeClassName: getConstructorFacadeClassName(
        targetClassName,
        declaration?.type && ts.isTypeReferenceNode(declaration.type)
          ? renderEntityName(declaration.type.typeName)
          : null,
      ),
      propertyName: variableName,
      targetClassName,
      typeText: getConstructorFacadeClassName(
        targetClassName,
        declaration?.type && ts.isTypeReferenceNode(declaration.type)
          ? renderEntityName(declaration.type.typeName)
          : null,
      ),
    });
  }

  return aliases.sort((left, right) => left.propertyName.localeCompare(right.propertyName));
}

function collectGlobalVariableAliases(
  context,
  availableClassNames,
  existingNames = new Set(),
  renderTypeOptions = {},
) {
  const aliases = [];

  for (const [variableName, declaration] of context.variables.entries()) {
    const pythonName = toPythonIdentifier(variableName);
    if (!pythonName || !declaration?.type || existingNames.has(pythonName)) {
      continue;
    }

    const targetClassName = getVariableDeclarationTargetClassName(
      variableName,
      declaration,
      availableClassNames,
    );
    let typeText = null;
    let emitAtModuleLevel = true;

    if (targetClassName && targetClassName !== "Window") {
      typeText = `type[${renderErasedGenericClassReference(context, targetClassName)}]`;
      if (availableClassNames.has(targetClassName) && variableName === targetClassName) {
        emitAtModuleLevel = false;
      }
    } else {
      typeText = renderTypeNode(declaration.type, renderTypeOptions);
    }

    if (!typeText || typeText === PY_ANY) {
      continue;
    }

    aliases.push({
      emitAtModuleLevel,
      propertyName: variableName,
      pythonName,
      typeText,
    });
  }

  return aliases.sort((left, right) => left.propertyName.localeCompare(right.propertyName));
}

function collectConstructorFacadeSpecs(context, availableClassNames) {
  const specs = [];
  const seenClassNames = new Set();

  for (const [variableName, declaration] of context.variables.entries()) {
    if (!isConstructibleGlobalVariable(variableName, declaration)) {
      continue;
    }

    const targetClassName = getVariableDeclarationTargetClassName(
      variableName,
      declaration,
      availableClassNames,
    );
    if (!targetClassName || targetClassName === "Window") {
      continue;
    }

    const constructorTypeNode = declaration?.type;
    const constructorInterfaceName =
      constructorTypeNode && ts.isTypeReferenceNode(constructorTypeNode)
        ? renderEntityName(constructorTypeNode.typeName)
        : null;
    const facadeClassName = getConstructorFacadeClassName(
      targetClassName,
      constructorInterfaceName,
    );
    if (seenClassNames.has(facadeClassName)) {
      continue;
    }

    specs.push({
      constructorInterfaceName:
        constructorInterfaceName && constructorInterfaceName.endsWith("Constructor")
          ? constructorInterfaceName
          : null,
      constructorVariableName: variableName,
      facadeClassName,
      targetClassName,
    });
    seenClassNames.add(facadeClassName);
  }

  return specs.sort((left, right) => left.facadeClassName.localeCompare(right.facadeClassName));
}

function buildHtmlDocumentClass(context) {
  const interfaceDeclarations = getInterfaceDeclarations(context, HTML_DOCUMENT_CLASS_NAME);
  if (interfaceDeclarations.length === 0) {
    return [];
  }

  const baseNames = getInterfaceBaseNames(interfaceDeclarations);
  const lines = [
    `class ${HTML_DOCUMENT_CLASS_NAME}(${baseNames.length > 0 ? baseNames.join(", ") : "Document"}):`,
    "    @staticmethod",
    `    def new() -> ${HTML_DOCUMENT_CLASS_NAME}: ...`,
  ];

  for (const entry of collectTagNameEntries(context, [
    "HTMLElementTagNameMap",
    "HTMLElementDeprecatedTagNameMap",
  ])) {
    lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
    lines.push(
      `    def createElement(self, tagName: ${PY_LITERAL}[${JSON.stringify(entry.tagName)}], options: ElementCreationOptions | None = None) -> ${entry.returnType}: ...`,
    );
  }
  lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
  lines.push(
    "    def createElement(self, tagName: str, options: ElementCreationOptions | None = None) -> HTMLElement: ...",
  );
  lines.push(`    def getElementById(self, elementId: str) -> HTMLElement | None: ...`);

  for (const entry of collectTagNameEntries(context, QUERYABLE_TAG_NAME_MAP_INTERFACE_NAMES)) {
    lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
    lines.push(
      `    def querySelector(self, selectors: ${PY_LITERAL}[${JSON.stringify(entry.tagName)}]) -> ${entry.returnType} | None: ...`,
    );
  }
  lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
  lines.push("    def querySelector(self, selectors: str) -> Element | None: ...");

  for (const entry of collectTagNameEntries(context, QUERYABLE_TAG_NAME_MAP_INTERFACE_NAMES)) {
    lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
    lines.push(
      `    def querySelectorAll(self, selectors: ${PY_LITERAL}[${JSON.stringify(entry.tagName)}]) -> ${PY_SEQUENCE}[${entry.returnType}]: ...`,
    );
  }
  lines.push(`    ${PY_OVERLOAD_DECORATOR}`);
  lines.push(`    def querySelectorAll(self, selectors: str) -> ${PY_SEQUENCE}[Element]: ...`);

  return lines;
}

function buildGlobalEventHandlersClass(context) {
  const methodLines = buildEventListenerMethodLines(context, GLOBAL_EVENT_HANDLERS_EVENT_MAP_NAME);
  if (methodLines.length === 0) {
    return [];
  }

  return [
    `class ${GLOBAL_EVENT_HANDLERS_CLASS_NAME}(${GLOBAL_EVENT_HANDLERS_BASE_CLASS_NAME}):`,
    ...methodLines,
  ];
}

function buildGeneratedInterfaceClass(context, className) {
  const interfaceDeclarations = FLATTENED_MIXIN_CLASS_BASES.has(className)
    ? getInterfaceDeclarationsRecursive(context, className)
    : getInterfaceDeclarations(context, className);
  if (interfaceDeclarations.length === 0) {
    return null;
  }

  const classTypeParameterList = renderClassTypeParameterList(
    interfaceDeclarations.flatMap((declaration) => declaration.typeParameters ?? []),
    className,
  );
  const classTypeParameterNames = collectTypeParameterNames(interfaceDeclarations);
  const bases = Array.from(
    new Set([
      ...(FLATTENED_MIXIN_CLASS_BASES.get(className) ?? getInterfaceBaseNames(interfaceDeclarations)),
      ...getSyntheticClassAdditionalBases(className, classTypeParameterNames),
    ]),
  );
  const skipMemberNames = new Set(CLASS_INSTANCE_METHOD_SKIP_NAMES.get(className) ?? []);
  const skipStaticMethodNames = new Set(CLASS_STATIC_METHOD_SKIP_NAMES.get(className) ?? []);
  if (
    className !== "ReadonlyMap" &&
    className !== "ReadonlySet" &&
    (interfaceExtends(context, className, "ReadonlyMap") || interfaceExtends(context, className, "ReadonlySet"))
  ) {
    skipMemberNames.add("forEach");
  }
  if (className !== "ReadonlyMap" && interfaceExtends(context, className, "ReadonlyMap")) {
    skipMemberNames.add("entries");
  }
  if (
    className !== "EventTarget" &&
    interfaceExtends(context, className, "EventTarget")
  ) {
    skipMemberNames.add("addEventListener");
    skipMemberNames.add("removeEventListener");
  }
  const lines = [
    `class ${className}${classTypeParameterList}${bases.length > 0 ? `(${bases.join(", ")})` : ""}:`,
    ...emitClassConstructorMembers(context, className, { skipMethodNames: skipStaticMethodNames }),
    ...emitInstanceMembers(interfaceDeclarations, className, { skipMemberNames }),
  ];

  if (lines.length === 1) {
    lines.push("    ...");
  }

  return lines.join("\n");
}

function buildGeneratedEventListenerClass(context, className, eventMapInterfaceName, extraOptions = {}) {
  const interfaceDeclarations = FLATTENED_MIXIN_CLASS_BASES.has(className)
    ? getInterfaceDeclarationsRecursive(context, className)
    : getInterfaceDeclarations(context, className);
  if (interfaceDeclarations.length === 0) {
    return null;
  }

  const classTypeParameterList = renderClassTypeParameterList(
    interfaceDeclarations.flatMap((declaration) => declaration.typeParameters ?? []),
    className,
  );
  const classTypeParameterNames = collectTypeParameterNames(interfaceDeclarations);
  const bases = Array.from(
    new Set([
      ...(FLATTENED_MIXIN_CLASS_BASES.get(className) ?? getInterfaceBaseNames(interfaceDeclarations)),
      ...getSyntheticClassAdditionalBases(className, classTypeParameterNames),
    ]),
  );
  const skipMemberNames = new Set([
    "addEventListener",
    "removeEventListener",
    ...(extraOptions.skipMemberNames ?? []),
  ]);
  if (
    className !== "ReadonlyMap" &&
    className !== "ReadonlySet" &&
    (interfaceExtends(context, className, "ReadonlyMap") || interfaceExtends(context, className, "ReadonlySet"))
  ) {
    skipMemberNames.add("forEach");
  }
  if (className !== "ReadonlyMap" && interfaceExtends(context, className, "ReadonlyMap")) {
    skipMemberNames.add("entries");
  }
  const lines = [
    `class ${className}${classTypeParameterList}${bases.length > 0 ? `(${bases.join(", ")})` : ""}:`,
    ...emitClassConstructorMembers(context, className),
    ...emitInstanceMembers(interfaceDeclarations, className, { skipMemberNames }),
    ...buildEventListenerMethodLines(context, eventMapInterfaceName),
  ];

  if (lines.length === 1) {
    lines.push("    ...");
  }

  return lines.join("\n");
}

function buildGeneratedIterableCollectionClass(context, className, itemType) {
  const interfaceDeclarations = getInterfaceDeclarationsRecursive(context, className);
  if (interfaceDeclarations.length === 0) {
    return null;
  }

  const classTypeParameterList = renderClassTypeParameterList(
    interfaceDeclarations.flatMap((declaration) => declaration.typeParameters ?? []),
    className,
  );
  const classTypeParameterNames = collectTypeParameterNames(interfaceDeclarations);
  const bases = Array.from(
    new Set([
      ...getInterfaceBaseNames(interfaceDeclarations),
      `${PY_SEQUENCE}[${itemType}]`,
      ...getSyntheticClassAdditionalBases(className, classTypeParameterNames),
    ]),
  );
  const skipMemberNames = new Set(CLASS_INSTANCE_METHOD_SKIP_NAMES.get(className) ?? []);
  const lines = [
    `class ${className}${classTypeParameterList}${bases.length > 0 ? `(${bases.join(", ")})` : ""}:`,
    ...emitClassConstructorMembers(context, className),
    ...emitInstanceMembers(interfaceDeclarations, className, { skipMemberNames }),
  ];

  if (lines.length === 1) {
    lines.push("    ...");
  }

  return lines.join("\n");
}

function buildGeneratedTypedDictClass(context, className) {
  const interfaceDeclarations = getInterfaceDeclarations(context, className);
  if (interfaceDeclarations.length === 0) {
    return null;
  }

  const classTypeParameterList = renderClassTypeParameterList(
    interfaceDeclarations.flatMap((declaration) => declaration.typeParameters ?? []),
    className,
  );
  const baseNames = getInterfaceBaseNames(interfaceDeclarations);
  const interfaceTypeParameterNames = new Set();
  for (const declaration of interfaceDeclarations) {
    for (const typeParameter of declaration.typeParameters ?? []) {
      interfaceTypeParameterNames.add(typeParameter.name.text);
    }
  }

  const propertyEntries = new Map();
  const groupedMethodEntries = new Map();

  const recordPropertyEntry = (name, typeText, optional, priority) => {
    const pythonName = toPythonIdentifier(name);
    if (!pythonName) {
      return;
    }

    const existingEntry = propertyEntries.get(pythonName);
    if (existingEntry && existingEntry.priority > priority) {
      return;
    }

    propertyEntries.set(pythonName, { optional, priority, typeText });
  };

  const recordMethodEntry = (member) => {
    if (!member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
      return;
    }

    const pythonName = toPythonIdentifier(member.name.text);
    if (!pythonName) {
      return;
    }

    const existingGroup = groupedMethodEntries.get(pythonName) ?? {
      optional: Boolean(member.questionToken),
      signatures: [],
    };
    existingGroup.optional ||= Boolean(member.questionToken);
    existingGroup.signatures.push(member);
    groupedMethodEntries.set(pythonName, existingGroup);
  };

  for (const member of getInterfaceMembers(interfaceDeclarations)) {
    if (!("name" in member) || !member.name) {
      continue;
    }

    if (ts.isPropertySignature(member) && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
      let typeText = renderTypeNode(member.type, {
        currentClassName: className,
        currentClassTypeParameterNames: Array.from(interfaceTypeParameterNames),
        position: "annotation",
        typeParameterNames: interfaceTypeParameterNames,
      });
      if (member.questionToken) {
        typeText = ensureOptionalType(typeText);
      }
      recordPropertyEntry(member.name.text, typeText, Boolean(member.questionToken), 1);
      continue;
    }

    if (ts.isGetAccessorDeclaration(member) && ts.isIdentifier(member.name)) {
      const typeText = renderTypeNode(member.type, {
        currentClassName: className,
        currentClassTypeParameterNames: Array.from(interfaceTypeParameterNames),
        position: "annotation",
        typeParameterNames: interfaceTypeParameterNames,
      });
      recordPropertyEntry(member.name.text, typeText, false, 2);
      continue;
    }

    if (ts.isSetAccessorDeclaration(member) && ts.isIdentifier(member.name)) {
      const setterParameter = member.parameters?.[0];
      const typeText = renderTypeNode(setterParameter?.type, {
        currentClassName: className,
        currentClassTypeParameterNames: Array.from(interfaceTypeParameterNames),
        position: "annotation",
        typeParameterNames: interfaceTypeParameterNames,
      });
      recordPropertyEntry(member.name.text, typeText, false, 0);
      continue;
    }

    if (ts.isMethodSignature(member)) {
      recordMethodEntry(member);
    }
  }

  const hasOptionalMember =
    Array.from(propertyEntries.values()).some((entry) => entry.optional) ||
    Array.from(groupedMethodEntries.values()).some((entry) => entry.optional);
  const hasRequiredMember =
    Array.from(propertyEntries.values()).some((entry) => !entry.optional) ||
    Array.from(groupedMethodEntries.values()).some((entry) => !entry.optional);
  const headerBases = baseNames.length > 0 ? baseNames.join(", ") : PY_TYPED_DICT;
  const header =
    !hasRequiredMember && hasOptionalMember
      ? `class ${className}${classTypeParameterList}(${headerBases}, total=False):`
      : `class ${className}${classTypeParameterList}(${headerBases}):`;
  const lines = [header];

  for (const [pythonName, entry] of propertyEntries.entries()) {
    const typeText =
      entry.optional && hasRequiredMember ? `${PY_NOT_REQUIRED}[${entry.typeText}]` : entry.typeText;
    lines.push(`    ${pythonName}: ${typeText}`);
  }

  for (const [pythonName, entry] of groupedMethodEntries.entries()) {
    const callableTypes = normalizeUnionParts(
      entry.signatures.map((signature) =>
        renderCallableTypeFromSignature(signature, {
          currentClassName: className,
          currentClassTypeParameterNames: [],
          typeParameterNames: interfaceTypeParameterNames,
        }),
      ),
    );
    const typeText =
      entry.optional && hasRequiredMember
        ? `${PY_NOT_REQUIRED}[${callableTypes.join(" | ")}]`
        : callableTypes.join(" | ");
    lines.push(`    ${pythonName}: ${typeText}`);
  }

  if (lines.length === 1) {
    lines.push("    ...");
  }

  return lines.join("\n");
}

function buildGeneratedWindowClass(context, availableClassNames, typeReferenceAliases = new Map()) {
  const interfaceDeclarations = getInterfaceDeclarations(context, WINDOW_CLASS_NAME);
  if (interfaceDeclarations.length === 0) {
    return null;
  }

  const classTypeParameterList = renderClassTypeParameterList(
    interfaceDeclarations.flatMap((declaration) => declaration.typeParameters ?? []),
    WINDOW_CLASS_NAME,
  );
  const bases = getInterfaceBaseNames(interfaceDeclarations);
  const existingWindowMemberNames = collectInterfaceMemberNames(interfaceDeclarations);
  const constructorAliases = collectWindowConstructorAliases(context, availableClassNames);
  const constructorAliasPropertyNames = new Set(
    constructorAliases.map((entry) => entry.propertyName),
  );
  const renderTypeOptions = { typeReferenceAliases };
  const globalVariableAliases = collectGlobalVariableAliases(
    context,
    availableClassNames,
    new Set(["document", "window", "self", "globalThis"]),
    renderTypeOptions,
  );
  const injectedWindowMembers = [
    {
      pythonName: "document",
      typeText: typeReferenceAliases.get(HTML_DOCUMENT_CLASS_NAME) ?? HTML_DOCUMENT_CLASS_NAME,
    },
    {
      pythonName: "window",
      typeText: typeReferenceAliases.get(WINDOW_CLASS_NAME) ?? WINDOW_CLASS_NAME,
    },
    {
      pythonName: "self",
      typeText: typeReferenceAliases.get(WINDOW_CLASS_NAME) ?? WINDOW_CLASS_NAME,
    },
    {
      pythonName: "globalThis",
      typeText: typeReferenceAliases.get(WINDOW_CLASS_NAME) ?? WINDOW_CLASS_NAME,
    },
  ];

  for (const alias of constructorAliases) {
    if (existingWindowMemberNames.has(alias.facadeClassName)) {
      continue;
    }
    injectedWindowMembers.push({
      pythonName: alias.propertyName,
      typeText: alias.typeText,
    });
  }

  for (const alias of globalVariableAliases) {
    if (
      constructorAliasPropertyNames.has(alias.propertyName) ||
      existingWindowMemberNames.has(alias.propertyName) ||
      existingWindowMemberNames.has(alias.pythonName) ||
      new Set(["document", "window", "self", "globalThis"]).has(alias.propertyName)
    ) {
      continue;
    }
    injectedWindowMembers.push({
      pythonName: alias.pythonName,
      typeText: alias.typeText,
    });
  }

  const lines = [
    `class ${WINDOW_CLASS_NAME}${classTypeParameterList}${bases.length > 0 ? `(${bases.join(", ")})` : ""}:`,
    ...emitClassConstructorMembers(context, WINDOW_CLASS_NAME, { renderTypeOptions }),
    ...injectedWindowMembers.map((entry) => `    ${entry.pythonName}: ${entry.typeText}`),
    ...emitInstanceMembers(interfaceDeclarations, WINDOW_CLASS_NAME, {
      renderTypeOptions,
      skipMemberNames: new Set([
        "addEventListener",
        "removeEventListener",
        "document",
        "window",
        "self",
        "globalThis",
        ...constructorAliasPropertyNames,
      ]),
    }),
    ...buildEventListenerMethodLines(context, WINDOW_EVENT_MAP_NAME, renderTypeOptions),
  ];

  return lines.join("\n");
}

function collectInterfaceClassNames(context) {
  const names = new Set();

  for (const interfaceName of context.interfaces.keys()) {
    if (!shouldEmitInterfaceAsClass(interfaceName)) {
      continue;
    }
    names.add(interfaceName);
  }

  names.add(HTML_DOCUMENT_CLASS_NAME);
  return Array.from(names).sort((left, right) => {
    if (left === WINDOW_CLASS_NAME) {
      return -1;
    }
    if (right === WINDOW_CLASS_NAME) {
      return 1;
    }
    if (left === HTML_DOCUMENT_CLASS_NAME) {
      return -1;
    }
    if (right === HTML_DOCUMENT_CLASS_NAME) {
      return 1;
    }
    return left.localeCompare(right);
  });
}

function collectGeneratedTypeReferenceAliasSpecs(context) {
  return collectInterfaceClassNames(context)
    .filter((className) => !GENERATED_TYPE_REFERENCE_ALIAS_SKIP_NAMES.has(className))
    .map((className) => ({
      aliasName: getTypeReferenceAliasName(className),
      className,
      typeParameterNames: collectTypeParameterNames(getInterfaceDeclarations(context, className)),
    }));
}

function emitGeneratedTypeReferenceAliases(typeReferenceAliasSpecs) {
  return typeReferenceAliasSpecs.map((spec) =>
    spec.typeParameterNames.length > 0
      ? `type ${spec.aliasName}[${spec.typeParameterNames.join(", ")}] = ${spec.className}[${spec.typeParameterNames.join(", ")}]`
      : `type ${spec.aliasName} = ${spec.className}`,
  );
}

function buildEventListenerOverlayClass(context, className, baseClassName, eventMapInterfaceName) {
  const methodLines = buildEventListenerMethodLines(context, eventMapInterfaceName);
  if (methodLines.length === 0) {
    return [];
  }

  return [`class ${className}(${baseClassName}):`, ...methodLines];
}

function buildIterableCollectionOverlayClass(context, className, baseClassName, itemType) {
  const interfaceDeclarations = getInterfaceDeclarationsRecursive(context, className);
  if (interfaceDeclarations.length === 0) {
    return [];
  }

  return [
    `class ${className}(${baseClassName}, ${PY_SEQUENCE}[${itemType}]):`,
    ...emitInstanceMembers(interfaceDeclarations, className),
  ];
}

function collectSyntheticClassSpecs(baseStubContent, context) {
  const knownClassNames = collectStubClassNames(baseStubContent);
  const specs = [...EXPLICIT_SYNTHETIC_CLASS_SPECS];
  const seenClassNames = new Set(specs.map((entry) => entry.className));

  for (const [variableName, declaration] of context.variables.entries()) {
    const className = getVariableDeclarationExposedTypeName(variableName, declaration);
    if (!className || className === "Window" || knownClassNames.has(className)) {
      continue;
    }

    if (seenClassNames.has(className)) {
      continue;
    }

    if (className !== HTML_DOCUMENT_CLASS_NAME && !context.interfaces.has(className)) {
      continue;
    }

    const constructorTypeNode = declaration?.type;
    const constructorInterfaceName =
      constructorTypeNode && ts.isTypeReferenceNode(constructorTypeNode)
        ? renderEntityName(constructorTypeNode.typeName)
        : null;

    const instanceInterfaceDeclarations = getInterfaceDeclarations(context, className);
    const classTypeParameterNames = collectTypeParameterNames(instanceInterfaceDeclarations);

    specs.push({
      additionalBases: getSyntheticClassAdditionalBases(className, classTypeParameterNames),
      className,
      constructorInterfaceName:
        constructorInterfaceName && constructorInterfaceName.endsWith("Constructor")
          ? constructorInterfaceName
          : null,
      constructorVariableName: variableName,
      instanceInterfaceName: className,
      mode: className === HTML_DOCUMENT_CLASS_NAME ? "html-document" : "standard",
    });
    seenClassNames.add(className);
  }

  return specs.sort((left, right) => {
    if (left.className === HTML_DOCUMENT_CLASS_NAME) {
      return -1;
    }
    if (right.className === HTML_DOCUMENT_CLASS_NAME) {
      return 1;
    }
    return left.className.localeCompare(right.className);
  });
}

function buildSyntheticClass(context, knownClassNames, classSpec) {
  if (knownClassNames.has(classSpec.className)) {
    return null;
  }

  if (classSpec.mode === "html-document") {
    return buildHtmlDocumentClass(context).join("\n");
  }

  const instanceInterface = getInterfaceDeclarations(context, classSpec.instanceInterfaceName);
  const constructorMembersSource =
    classSpec.constructorInterfaceName
    ? getInterfaceDeclarations(context, classSpec.constructorInterfaceName)
    : (() => {
        const declaration = classSpec.constructorVariableName
          ? context.variables.get(classSpec.constructorVariableName)
          : null;
        return declaration?.type && ts.isTypeLiteralNode(declaration.type) ? declaration.type : null;
      })();
  const bases = [
    ...classSpec.additionalBases,
    ...(instanceInterface ? getInterfaceBaseNames(instanceInterface) : []),
  ].filter(Boolean);
  const classTypeParameters =
    instanceInterface?.flatMap((declaration) => declaration.typeParameters ?? []) ?? [];
  const classTypeParameterList = renderClassTypeParameterList(classTypeParameters, classSpec.className);
  const skipMemberNames = new Set(CLASS_INSTANCE_METHOD_SKIP_NAMES.get(classSpec.className) ?? []);
  if (
    classSpec.className !== "ReadonlyMap" &&
    classSpec.className !== "ReadonlySet" &&
    instanceInterface &&
    (
      interfaceExtends(context, classSpec.className, "ReadonlyMap") ||
      interfaceExtends(context, classSpec.className, "ReadonlySet")
    )
  ) {
    skipMemberNames.add("forEach");
  }
  if (
    classSpec.className !== "ReadonlyMap" &&
    instanceInterface &&
    interfaceExtends(context, classSpec.className, "ReadonlyMap")
  ) {
    skipMemberNames.add("entries");
  }
  const lines = [
    `class ${classSpec.className}${classTypeParameterList}${bases.length > 0 ? `(${bases.join(", ")})` : ""}:`,
    ...emitConstructorFacadeMembers(constructorMembersSource, classSpec.className),
    ...emitInstanceMembers(instanceInterface, classSpec.className, { skipMemberNames }),
  ];

  if (lines.length === 1) {
    lines.push("    ...");
  }

  return lines.join("\n");
}

function buildGeneratedTypeAlias(context, aliasName, renderTypeOptions = {}) {
  const declaration = getTypeAliasDeclaration(context, aliasName);
  if (!declaration) {
    return null;
  }

  if (aliasName.endsWith("TagNameMap")) {
    return null;
  }

  const pythonName = toPythonIdentifier(aliasName);
  if (!pythonName) {
    return null;
  }

  const typeParameterNames = collectTypeParameterNames([declaration]);
  const renderedType = renderTypeNode(declaration.type, {
    ...renderTypeOptions,
    position: "annotation",
    typeParameterNames: new Set(typeParameterNames),
  });
  if (typeParameterNames.length > 0) {
    return `type ${pythonName}[${typeParameterNames.join(", ")}] = ${renderedType}`;
  }

  return `type ${pythonName} = ${renderedType}`;
}

const ORDERING_IGNORED_TYPE_NAMES = new Set([
  "Any",
  "Awaitable",
  "Callable",
  "Iterable",
  "Literal",
  "None",
  "NotRequired",
  "Sequence",
  "TypedDict",
  "bool",
  "bytes",
  "dict",
  "float",
  "list",
  "object",
  "overload",
  "str",
  "tuple",
  "type",
]);
const GENERATED_TYPE_REFERENCE_ALIAS_SKIP_NAMES = new Set([
  "Iterable",
  "IterableIterator",
  "Iterator",
]);
const PY_TYPING_NAMESPACE = "t";
const PY_ANY = `${PY_TYPING_NAMESPACE}.Any`;
const PY_AWAITABLE = `${PY_TYPING_NAMESPACE}.Awaitable`;
const PY_CALLABLE = `${PY_TYPING_NAMESPACE}.Callable`;
const PY_GENERATOR = `${PY_TYPING_NAMESPACE}.Generator`;
const PY_LITERAL = `${PY_TYPING_NAMESPACE}.Literal`;
const PY_NOT_REQUIRED = `${PY_TYPING_NAMESPACE}.NotRequired`;
const PY_SEQUENCE = `${PY_TYPING_NAMESPACE}.Sequence`;
const PY_TYPED_DICT = `${PY_TYPING_NAMESPACE}.TypedDict`;
const PY_OVERLOAD_DECORATOR = `@${PY_TYPING_NAMESPACE}.overload`;

function collectReferencedTypeNamesInNode(node, names = new Set()) {
  if (!node) {
    return names;
  }

  const visit = (currentNode) => {
    if (ts.isTypeReferenceNode(currentNode)) {
      names.add(renderEntityName(currentNode.typeName));
      for (const typeArgument of currentNode.typeArguments ?? []) {
        visit(typeArgument);
      }
      return;
    }

    if (ts.isExpressionWithTypeArguments(currentNode)) {
      names.add(renderEntityName(currentNode.expression));
      for (const typeArgument of currentNode.typeArguments ?? []) {
        visit(typeArgument);
      }
      return;
    }

    ts.forEachChild(currentNode, visit);
  };

  visit(node);
  return names;
}

function collectTypeAliasDependencyNames(context, aliasName) {
  const declaration = getTypeAliasDeclaration(context, aliasName);
  if (!declaration) {
    return new Set();
  }

  const localTypeParameterNames = new Set(
    (declaration.typeParameters ?? [])
      .map((entry) => toPythonIdentifier(entry.name.text))
      .filter(Boolean),
  );
  const names = collectReferencedTypeNamesInNode(declaration.type);
  names.delete(aliasName);

  for (const ignoredName of ORDERING_IGNORED_TYPE_NAMES) {
    names.delete(ignoredName);
  }
  for (const localName of localTypeParameterNames) {
    names.delete(localName);
  }

  return names;
}

function emitResolvableTypeAliases(
  context,
  aliasNames,
  availableNames,
  generatedClassNames,
  emittedAliasNames,
  renderTypeOptions = {},
) {
  const pendingAliasNames = new Set(
    aliasNames.filter((aliasName) => !emittedAliasNames.has(aliasName)),
  );
  const emittedSections = [];
  let progressed = true;

  while (progressed) {
    progressed = false;

    for (const aliasName of aliasNames) {
      if (!pendingAliasNames.has(aliasName)) {
        continue;
      }

      const dependencies = collectTypeAliasDependencyNames(context, aliasName);
      const isBlocked = Array.from(dependencies).some((dependencyName) => {
        if (pendingAliasNames.has(dependencyName) && !availableNames.has(dependencyName)) {
          return true;
        }
        if (generatedClassNames.has(dependencyName) && !availableNames.has(dependencyName)) {
          return true;
        }
        return false;
      });
      if (isBlocked) {
        continue;
      }

      const section = buildGeneratedTypeAlias(context, aliasName, renderTypeOptions);
      if (section) {
        emittedSections.push(section);
      }
      emittedAliasNames.add(aliasName);
      availableNames.add(aliasName);
      pendingAliasNames.delete(aliasName);
      progressed = true;
    }
  }

  return emittedSections;
}

function buildConstructorFacade(context, spec) {
  const constructorMembersSource =
    spec.constructorInterfaceName
      ? getInterfaceDeclarations(context, spec.constructorInterfaceName)
      : (() => {
          const declaration = spec.constructorVariableName
            ? context.variables.get(spec.constructorVariableName)
            : null;
          return declaration?.type && ts.isTypeLiteralNode(declaration.type) ? declaration.type : null;
        })();
  const lines = [
    `class ${spec.facadeClassName}(object):`,
    ...emitConstructorFacadeMembers(constructorMembersSource, spec.targetClassName),
  ];

  if (lines.length === 1) {
    lines.push("    ...");
  }

  return lines.join("\n");
}

function collectStandaloneConstructorInterfaceNames(context, constructorFacadeSpecs) {
  const emittedFacadeNames = new Set(
    constructorFacadeSpecs.map((spec) => spec.facadeClassName),
  );

  return Array.from(context.interfaces.keys())
    .filter(
      (interfaceName) =>
        interfaceName.endsWith("Constructor") &&
        !emittedFacadeNames.has(interfaceName),
    )
    .sort((left, right) => left.localeCompare(right));
}

function buildStandaloneConstructorInterface(context, interfaceName) {
  const interfaceDeclarations = getInterfaceDeclarations(context, interfaceName);
  if (interfaceDeclarations.length === 0) {
    return null;
  }

  const lines = [
    `class ${interfaceName}(object):`,
    ...emitConstructorFacadeMembers(interfaceDeclarations, interfaceName),
  ];

  if (lines.length === 1) {
    lines.push("    ...");
  }

  return lines.join("\n");
}

function renameBaseClass(baseStubContent, className, replacementClassName) {
  const classBlock = collectStubClassBlocks(baseStubContent).find((entry) => entry.name === className);
  if (!classBlock) {
    return baseStubContent;
  }

  const nextBlockText = classBlock.body.replace(
    new RegExp(`^class\\s+${className}\\b`, "u"),
    `class ${replacementClassName}`,
  );

  return [
    baseStubContent.slice(0, classBlock.start),
    nextBlockText,
    baseStubContent.slice(classBlock.end),
  ].join("");
}

export function getTypeScriptJsStubVersion() {
  return ts.version;
}

export function buildTypeScriptJsStub() {
  const context = createTypeScriptContext();
  const knownClassNames = new Set(collectInterfaceClassNames(context));
  const availableClassNames = new Set(knownClassNames);
  const typeReferenceAliasSpecs = collectGeneratedTypeReferenceAliasSpecs(context);
  const typeReferenceAliases = new Map(
    typeReferenceAliasSpecs.map((spec) => [spec.className, spec.aliasName]),
  );
  const typedDictInterfaceNames = new Set(
    collectTypedDictInterfaceNames(context, availableClassNames),
  );
  const constructorFacadeSpecs = collectConstructorFacadeSpecs(context, availableClassNames);
  const standaloneConstructorInterfaceNames = collectStandaloneConstructorInterfaceNames(
    context,
    constructorFacadeSpecs,
  );
  const globalVariableAliases = collectGlobalVariableAliases(
    context,
    availableClassNames,
    knownClassNames,
  );
  const moduleLevelSpecialNames = new Set(["document", "globalThis", "self", "window"]);
  const sortedAliasNames = Array.from(context.typeAliases.keys()).sort((left, right) =>
    left.localeCompare(right),
  );
  const emittedAliasNames = new Set();
  const availableAliasNames = new Set(ORDERING_IGNORED_TYPE_NAMES);
  const generatedClassNames = new Set([
    ...collectInterfaceClassNames(context),
    ...constructorFacadeSpecs.map((spec) => spec.facadeClassName),
    ...standaloneConstructorInterfaceNames,
  ]);

  const headerSections = [
    "# TypeScript lib-driven js module stub.",
    "from __future__ import annotations",
    "import typing as t",
  ];
  const sections = [...headerSections];

  sections.push(
    ...emitResolvableTypeAliases(
      context,
      sortedAliasNames,
      availableAliasNames,
      generatedClassNames,
      emittedAliasNames,
    ),
  );

  for (const className of collectInterfaceClassNames(context)) {
    let section = null;
    const eventMapInterfaceName = getEventMapInterfaceNameForClass(context, className);

    if (typedDictInterfaceNames.has(className)) {
      section = buildGeneratedTypedDictClass(context, className);
    } else if (className === "EventListener") {
      section = "type EventListener = t.Callable[[Event], t.Any]";
    } else if (className === "ReadonlyArray") {
      section = "type ReadonlyArray[T] = t.Sequence[T]";
    } else if (className === HTML_DOCUMENT_CLASS_NAME) {
      section = buildHtmlDocumentClass(context).join("\n");
    } else if (className === WINDOW_CLASS_NAME) {
      section = buildGeneratedWindowClass(context, availableClassNames, typeReferenceAliases);
    } else if (eventMapInterfaceName) {
      section = buildGeneratedEventListenerClass(
        context,
        className,
        eventMapInterfaceName,
      );
    } else if (className === NODE_LIST_CLASS_NAME) {
      section = buildGeneratedIterableCollectionClass(context, NODE_LIST_CLASS_NAME, "Node");
    } else if (className === HTML_COLLECTION_CLASS_NAME) {
      section = buildGeneratedIterableCollectionClass(context, HTML_COLLECTION_CLASS_NAME, "Element");
    } else {
      section = buildGeneratedInterfaceClass(context, className);
    }

    if (section) {
      sections.push(section);
    }
  }

  for (const className of generatedClassNames) {
    availableAliasNames.add(className);
  }

  for (const spec of constructorFacadeSpecs) {
    const section = buildConstructorFacade(context, spec);
    if (section) {
      sections.push(section);
    }
  }

  for (const interfaceName of standaloneConstructorInterfaceNames) {
    const section = buildStandaloneConstructorInterface(context, interfaceName);
    if (section) {
      sections.push(section);
    }
  }

  sections.push(
    ...emitResolvableTypeAliases(
      context,
      sortedAliasNames,
      availableAliasNames,
      generatedClassNames,
      emittedAliasNames,
    ),
  );

  for (const aliasName of sortedAliasNames) {
    if (emittedAliasNames.has(aliasName)) {
      continue;
    }
    const section = buildGeneratedTypeAlias(context, aliasName);
    if (section) {
      sections.push(section);
    }
  }

  for (const alias of globalVariableAliases) {
    if (!alias.emitAtModuleLevel || moduleLevelSpecialNames.has(alias.pythonName)) {
      continue;
    }
    sections.push(`${alias.pythonName}: ${alias.typeText}`);
  }

  sections.push("URLType = URL");
  sections.push(`document: ${HTML_DOCUMENT_CLASS_NAME}`);
  sections.push("self: Window");
  sections.push("globalThis: Window");
  sections.push("window: Window");

  const bodySections = sections.slice(headerSections.length);
  const usedTypeReferenceAliasSpecs = typeReferenceAliasSpecs.filter((spec) =>
    bodySections.some((section) => section.includes(spec.aliasName)),
  );

  return `${[
    ...headerSections,
    ...emitGeneratedTypeReferenceAliases(usedTypeReferenceAliasSpecs),
    ...bodySections,
  ]
    .filter(Boolean)
    .join("\n\n")}\n`;
}
