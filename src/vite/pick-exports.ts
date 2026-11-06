// All credit for this work goes to the amazing Next.js team.
// https://github.com/vercel/next.js/blob/canary/packages/next/build/babel/plugins/next-ssg-transform.ts

import MagicString, { type SourceMap } from "magic-string";
import { parseSync } from "oxc-parser";

type Node = any;

interface Binding {
  kind: "param" | "local" | "declared";
  declaration: Node;
  references: Node[];
  violations: Node[];
}

interface Scope {
  parent?: Scope;
  bindings: Map<string, Binding>;
  hoists?: boolean;
  isParams?: boolean;
  ownsArguments?: boolean;
}

interface Tree {
  parents: Map<Node, Node>;
  removed: Set<Node>;
  // Export wrappers that no longer export their declaration.
  unexported: Set<Node>;
  // Declarators split out of a mixed `export const a = 1, b = 2`.
  localDeclarators: Set<Node>;
}

const TYPE_ONLY_ANCESTORS = new Set([
  "TSArrayType",
  "TSClassImplements",
  "TSConditionalType",
  "TSConstructorType",
  "TSFunctionType",
  "TSImportType",
  "TSIndexedAccessType",
  "TSInferType",
  "TSInterfaceHeritage",
  "TSIntersectionType",
  "TSLiteralType",
  "TSMappedType",
  "TSOptionalType",
  "TSParenthesizedType",
  "TSRestType",
  "TSTemplateLiteralType",
  "TSThisType",
  "TSTupleType",
  "TSTypeLiteral",
  "TSTypeOperator",
  "TSTypePredicate",
  "TSTypeQuery",
  "TSTypeReference",
  "TSUnionType"
]);

function forEachChild(node: Node, visit: (child: Node) => void) {
  for (const key in node) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === "string") visit(item);
    } else if (value && typeof value.type === "string") {
      visit(value);
    }
  }
}

function unwrapParentheses(node: Node) {
  for (const key in node) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        while (item?.type === "ParenthesizedExpression") value[index] = item = item.expression;
      });
    } else {
      let inner = value;
      while (inner?.type === "ParenthesizedExpression") node[key] = inner = inner.expression;
    }
  }
}

function isFunctionLike(node: Node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function isClassLike(node: Node) {
  return node.type === "ClassDeclaration" || node.type === "ClassExpression";
}

function isNamedDeclaration(node: Node) {
  return node.type === "FunctionDeclaration" || node.type === "ClassDeclaration";
}

function isExportWrapper(node: Node) {
  return node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration";
}

function isReference(node: Node, parent: Node, grandparent: Node | undefined): boolean {
  if (
    node.type === "JSXIdentifier" &&
    parent.type !== "JSXMemberExpression" &&
    /^[a-z]/.test(node.name)
  ) {
    return false;
  }
  switch (parent.type) {
    case "MemberExpression":
      return parent.property === node ? parent.computed : true;
    case "JSXMemberExpression":
      return parent.object === node;
    case "VariableDeclarator":
      return parent.init === node;
    case "ArrowFunctionExpression":
      return parent.body === node;
    case "Property":
      if (parent.key === node) return parent.computed;
      return grandparent?.type !== "ObjectPattern";
    case "MethodDefinition":
    case "TSAbstractMethodDefinition":
      return parent.key === node ? parent.computed : false;
    case "PropertyDefinition":
    case "AccessorProperty":
    case "TSAbstractPropertyDefinition":
    case "TSAbstractAccessorProperty":
    case "TSPropertySignature":
      return parent.key === node ? parent.computed : true;
    case "ClassDeclaration":
    case "ClassExpression":
      return parent.superClass === node;
    case "AssignmentExpression":
    case "AssignmentPattern":
      return parent.right === node;
    case "ExportSpecifier":
      return parent.local === node && !grandparent?.source;
    case "TSEnumMember":
      return parent.id !== node;
    case "TSQualifiedName":
      return parent.right !== node;
    case "TSTypeParameter":
      return parent.name !== node;
    case "TSMappedType":
      return parent.key !== node;
    case "LabeledStatement":
    case "CatchClause":
    case "RestElement":
    case "BreakStatement":
    case "ContinueStatement":
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ExportAllDeclaration":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ImportSpecifier":
    case "ImportAttribute":
    case "JSXAttribute":
    case "ObjectPattern":
    case "ArrayPattern":
    case "MetaProperty":
      return false;
    default:
      return true;
  }
}

function patternIdentifiers(pattern: Node | null, out: Node[] = []): Node[] {
  switch (pattern?.type) {
    case "Identifier":
      out.push(pattern);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        patternIdentifiers(property.type === "Property" ? property.value : property, out);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternIdentifiers(element, out);
      break;
    case "AssignmentPattern":
      patternIdentifiers(pattern.left, out);
      break;
    case "RestElement":
      patternIdentifiers(pattern.argument, out);
      break;
    case "TSParameterProperty":
      patternIdentifiers(pattern.parameter, out);
      break;
  }
  return out;
}

function lookup(start: Scope | undefined, name: string): Binding | undefined {
  let previous: Scope | undefined;
  for (let scope = start; scope; previous = scope, scope = scope.parent) {
    const binding = scope.bindings.get(name);
    if (binding) {
      // A parameter default cannot see `var`s declared in the function body.
      if (!previous?.isParams || binding.kind !== "declared") return binding;
    } else if (name === "arguments" && scope.ownsArguments) {
      return;
    }
  }
}

function crawl(program: Node, tree: Tree) {
  const { parents, removed, unexported, localDeclarators } = tree;
  const scopes = new Map<Node, Scope>();
  const references: [name: string, scope: Scope, node: Node][] = [];
  const violations: [name: string, scope: Scope, node: Node][] = [];

  const childScope = (parent: Scope, options?: Partial<Scope>): Scope => ({
    parent,
    bindings: new Map(),
    ...options
  });

  const declare = (scope: Scope, name: string, declaration: Node, kind: Binding["kind"]) => {
    const existing = scope.bindings.get(name);
    if (existing) existing.violations.push(declaration);
    else scope.bindings.set(name, { kind, declaration, references: [], violations: [] });
  };

  const declareExportReferences = (node: Node, scope: Scope) => {
    const declaration = node.declaration;
    if (!declaration || unexported.has(node)) return;
    if (isNamedDeclaration(declaration)) {
      if (declaration.id) references.push([declaration.id.name, scope, node]);
    } else if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (removed.has(declarator) || localDeclarators.has(declarator)) continue;
        for (const id of patternIdentifiers(declarator.id)) references.push([id.name, scope, node]);
      }
    }
  };

  const visitChildren = (node: Node, scope: Scope) =>
    forEachChild(node, child => visit(child, scope));

  const visit = (node: Node, scope: Scope): void => {
    if (removed.has(node)) return;
    switch (node.type) {
      case "TSTypeAnnotation":
      case "TSImportEqualsDeclaration":
        return;
      case "Identifier":
      case "JSXIdentifier":
        if (isReference(node, parents.get(node), parents.get(parents.get(node)))) {
          references.push([node.name, scope, node]);
        }
        break;
      case "ImportDeclaration":
        for (const specifier of node.specifiers) {
          if (!removed.has(specifier)) declare(scope, specifier.local.name, specifier, "declared");
        }
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        declareExportReferences(node, scope);
        break;
      case "VariableDeclaration": {
        let target = scope;
        if (node.kind === "var") while (!target.hoists && target.parent) target = target.parent;
        for (const declarator of node.declarations) {
          if (removed.has(declarator)) continue;
          for (const id of patternIdentifiers(declarator.id)) {
            declare(target, id.name, declarator, "declared");
          }
        }
        break;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        if (node.type === "FunctionDeclaration" && node.id) {
          declare(scope, node.id.name, node, "declared");
        }
        const inner = childScope(scope, {
          hoists: true,
          ownsArguments: node.type !== "ArrowFunctionExpression"
        });
        scopes.set(node, inner);
        if (node.type === "FunctionExpression" && node.id) {
          declare(inner, node.id.name, node, "local");
        }
        const params = childScope(inner, { isParams: true });
        for (const param of node.params) {
          for (const id of patternIdentifiers(param)) declare(inner, id.name, param, "param");
          visit(param, params);
        }
        forEachChild(node, child => {
          if (node.params.includes(child)) return;
          if (child === node.body && child.type === "BlockStatement") {
            scopes.set(child, inner);
            visitChildren(child, inner);
          } else {
            visit(child, inner);
          }
        });
        return;
      }
      case "ClassDeclaration":
      case "ClassExpression": {
        if (node.type === "ClassDeclaration" && node.id && !node.declare) {
          declare(scope, node.id.name, node, "declared");
        }
        const inner = childScope(scope);
        scopes.set(node, inner);
        if (node.type === "ClassExpression" && node.id) {
          declare(inner, node.id.name, node, "local");
        }
        visitChildren(node, inner);
        return;
      }
      case "CatchClause": {
        const inner = childScope(scope);
        scopes.set(node, inner);
        for (const id of patternIdentifiers(node.param)) declare(inner, id.name, node, "declared");
        if (node.param) visit(node.param, inner);
        scopes.set(node.body, inner);
        visitChildren(node.body, inner);
        return;
      }
      case "StaticBlock":
      case "TSModuleBlock": {
        const inner = childScope(scope, { hoists: true });
        scopes.set(node, inner);
        visitChildren(node, inner);
        return;
      }
      case "SwitchStatement": {
        visit(node.discriminant, scope);
        const inner = childScope(scope);
        scopes.set(node, inner);
        for (const switchCase of node.cases) visit(switchCase, inner);
        return;
      }
      case "ForInStatement":
      case "ForOfStatement":
      case "ForStatement":
      case "BlockStatement":
      case "WhileStatement":
      case "DoWhileStatement": {
        const inner = childScope(scope);
        scopes.set(node, inner);
        if (node.left && node.left.type !== "VariableDeclaration") {
          for (const id of patternIdentifiers(node.left)) violations.push([id.name, inner, node]);
        }
        visitChildren(node, inner);
        return;
      }
      case "AssignmentExpression":
        for (const id of patternIdentifiers(node.left)) violations.push([id.name, scope, node]);
        break;
      case "UpdateExpression":
        if (node.argument.type === "Identifier") {
          violations.push([node.argument.name, scope, node]);
        }
        break;
      case "UnaryExpression":
        if (node.operator === "delete" && node.argument.type === "Identifier") {
          violations.push([node.argument.name, scope, node]);
        }
        break;
    }
    visitChildren(node, scope);
  };

  const root: Scope = { bindings: new Map(), hoists: true };
  scopes.set(program, root);
  visitChildren(program, root);

  for (const [name, scope, node] of references) lookup(scope, name)?.references.push(node);
  for (const [name, scope, node] of violations) lookup(scope, name)?.violations.push(node);

  const bindingOf = (identifier: Node): Binding | undefined => {
    let node = parents.get(identifier);
    if (isNamedDeclaration(node)) node = parents.get(node);
    while (node && !scopes.has(node)) node = parents.get(node);
    return node && lookup(scopes.get(node), identifier.name);
  };

  return { bindingOf };
}

function isTypeOnly(reference: Node, tree: Tree) {
  const { parents, localDeclarators } = tree;
  for (let node = reference; node; node = parents.get(node)) {
    if (TYPE_ONLY_ANCESTORS.has(node.type)) return true;
    if (node.type === "ExportSpecifier" && node.exportKind === "type") return true;
    if (node.type === "ExportNamedDeclaration" && node.exportKind === "type") {
      // The picked half of a split `export declare` is emitted as a plain export.
      if (!node.declaration?.declarations?.some((d: Node) => localDeclarators.has(d))) return true;
    }
  }
  return false;
}

function isInside(node: Node, ancestor: Node, parents: Map<Node, Node>) {
  for (let parent = parents.get(node); parent; parent = parents.get(parent)) {
    if (parent === ancestor) return true;
  }
  return false;
}

function isBindingReferenced(binding: Binding | undefined, tree: Tree, includeTypes: boolean) {
  if (!binding) return false;
  const references = binding.violations.concat(
    includeTypes
      ? binding.references
      : binding.references.filter(reference => !isTypeOnly(reference, tree))
  );
  if (!references.length) return false;
  if (binding.declaration.type === "FunctionDeclaration") {
    return !references.every(ref => isInside(ref, binding.declaration, tree.parents));
  }
  return true;
}

function boundIdentifier(node: Node, parents: Map<Node, Node>): Node | null {
  const parent = parents.get(node);
  if (parent.type === "VariableDeclarator")
    return parent.id.type === "Identifier" ? parent.id : null;
  if (parent.type === "AssignmentExpression") {
    return parent.left.type === "Identifier" ? parent.left : null;
  }
  if (node.type === "ArrowFunctionExpression") return null;
  return node.id?.type === "Identifier" ? node.id : null;
}

// A function or class expression's own name cannot leave it, so it never decides liveness.
function isOwnExpressionName(identifier: Node, parents: Map<Node, Node>) {
  const parent = parents.get(identifier);
  return (
    (parent.type === "FunctionExpression" || parent.type === "ClassExpression") &&
    parent.id === identifier
  );
}

// Only an assignment that is its own statement can be removed with its target.
function isInlineAssignment(identifier: Node, parents: Map<Node, Node>) {
  const parent = parents.get(identifier);
  return (
    parent.type === "AssignmentExpression" && parents.get(parent).type !== "ExpressionStatement"
  );
}

function patternLocals(pattern: Node): [slot: Node, local: Node][] {
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property: Node) => {
      const local = property.type === "Property" ? property.value : property.argument;
      return local.type === "Identifier" ? [[property, local]] : [];
    });
  }
  return pattern.elements.flatMap((element: Node | null) => {
    if (element?.type === "Identifier") return [[element, element]];
    if (element?.type === "RestElement" && element.argument.type === "Identifier") {
      return [[element, element.argument]];
    }
    return [];
  });
}

function exportedName(specifier: Node): string {
  return specifier.exported.name ?? specifier.exported.value;
}

function removeStatement(node: Node, tree: Tree) {
  tree.removed.add(node);
  const parent = tree.parents.get(node);
  if (isExportWrapper(parent)) tree.removed.add(parent);
}

function removeDeclarator(declarator: Node, tree: Tree) {
  const { parents, removed } = tree;
  const declaration = parents.get(declarator);
  const owner = parents.get(declaration);
  // `for (const x of y)` has no valid form without its declaration.
  if (
    (owner.type === "ForInStatement" || owner.type === "ForOfStatement") &&
    owner.left === declaration
  ) {
    return false;
  }
  removed.add(declarator);
  if (declaration.declarations.every((d: Node) => removed.has(d)))
    removeStatement(declaration, tree);
  return true;
}

export function pickExports(
  code: string,
  id: string,
  pick: string[]
): { code: string; map: SourceMap } | undefined {
  const { program, errors } = parseSync(id, code, {
    lang: "tsx",
    astType: "ts",
    sourceType: "module"
  });
  const error = errors[0];
  if (error) throw new SyntaxError(`Failed to parse ${id}:\n${error.codeframe || error.message}`);

  const parents = new Map<Node, Node>();
  const link = (node: Node) => {
    unwrapParentheses(node);
    forEachChild(node, child => {
      parents.set(child, node);
      link(child);
    });
  };
  link(program);

  const tree: Tree = {
    parents,
    removed: new Set(),
    unexported: new Set(),
    localDeclarators: new Set()
  };
  const { removed, unexported, localDeclarators } = tree;
  const before = crawl(program, tree);

  const candidates = new Set<Node>();
  for (const node of program.body as Node[]) {
    switch (node.type) {
      case "ImportDeclaration":
        if (node.source.value.endsWith(".css") && !pick.includes("$css")) removed.add(node);
        break;
      case "ExportAllDeclaration":
        if (node.exported && !pick.includes(exportedName(node))) removed.add(node);
        break;
      case "ExportDefaultDeclaration": {
        if (pick.includes("default")) break;
        const declaration = node.declaration;
        // A named declaration creates a binding that picked exports may reference.
        if (isNamedDeclaration(declaration) && declaration.id) {
          unexported.add(node);
          candidates.add(declaration.id);
        } else {
          removed.add(node);
        }
        break;
      }
      case "ExportNamedDeclaration": {
        if (node.specifiers.length) {
          for (const specifier of node.specifiers) {
            if (!pick.includes(exportedName(specifier))) removed.add(specifier);
          }
          if (node.specifiers.every((specifier: Node) => removed.has(specifier))) removed.add(node);
          break;
        }
        const declaration = node.declaration;
        if (declaration && isNamedDeclaration(declaration)) {
          if (declaration.id && !pick.includes(declaration.id.name)) {
            unexported.add(node);
            candidates.add(declaration.id);
          }
        } else if (declaration?.type === "VariableDeclaration") {
          for (const declarator of declaration.declarations) {
            if (declarator.id.type === "Identifier" && !pick.includes(declarator.id.name)) {
              localDeclarators.add(declarator);
              candidates.add(declarator.id);
            }
          }
        }
        break;
      }
    }
  }

  // Code that was already unused may run for its side effects, so it stays.
  const sweepable = new Set<Node>(candidates);
  const markIfReferenced = (identifier: Node) => {
    if (isBindingReferenced(before.bindingOf(identifier), tree, true)) sweepable.add(identifier);
  };
  const collect = (node: Node) => {
    if (removed.has(node)) return;
    if (node.type === "VariableDeclarator") {
      if (node.id.type === "Identifier") markIfReferenced(node.id);
      else if (node.id.type === "ObjectPattern" || node.id.type === "ArrayPattern") {
        for (const [, local] of patternLocals(node.id)) markIfReferenced(local);
      }
    } else if (isFunctionLike(node) || isClassLike(node)) {
      const identifier = boundIdentifier(node, parents);
      if (identifier) markIfReferenced(identifier);
    } else if (node.type.startsWith("Import") && node.local) {
      markIfReferenced(node.local);
    }
    forEachChild(node, collect);
  };
  collect(program);

  removeUnreachable(program, tree, sweepable, candidates);

  let changed: boolean;
  do {
    changed = false;
    const { bindingOf } = crawl(program, tree);
    const isDead = (identifier: Node) =>
      sweepable.has(identifier) && !isBindingReferenced(bindingOf(identifier), tree, false);
    const sweep = (node: Node) => {
      if (removed.has(node)) return;
      if (node.type === "VariableDeclarator") {
        if (node.id.type === "Identifier") {
          if (isDead(node.id) && removeDeclarator(node, tree)) changed = true;
        } else if (node.id.type === "ObjectPattern") {
          changed = sweepObjectPattern(node, isDead, tree) || changed;
        } else if (node.id.type === "ArrayPattern") {
          changed = sweepArrayPattern(node, isDead, tree) || changed;
        }
      } else if (isFunctionLike(node) || isClassLike(node)) {
        const identifier = boundIdentifier(node, parents);
        if (identifier && !isOwnExpressionName(identifier, parents) && isDead(identifier)) {
          const parent = parents.get(node);
          if (parent.type === "VariableDeclarator") {
            changed = removeDeclarator(parent, tree) || changed;
          } else if (parent.type === "AssignmentExpression") {
            const statement = parents.get(parent);
            if (statement.type === "ExpressionStatement") {
              removeStatement(statement, tree);
              changed = true;
            }
          } else {
            removeStatement(node, tree);
            changed = true;
          }
        }
      } else if (node.type === "ImportDeclaration") {
        for (const specifier of node.specifiers) {
          if (!removed.has(specifier) && isDead(specifier.local)) {
            removed.add(specifier);
            changed = true;
          }
        }
        if (node.specifiers.length && node.specifiers.every((s: Node) => removed.has(s))) {
          removed.add(node);
        }
        return;
      }
      if (!removed.has(node)) forEachChild(node, sweep);
    };
    sweep(program);
  } while (changed);

  if ((program.body as Node[]).every(node => removed.has(node))) return;

  const output = new MagicString(code);
  render(program, code, output, tree);
  return {
    code: output.toString(),
    map: output.generateMap({ source: id, includeContent: true, hires: "boundary" })
  };
}

// References alone cannot tell live bindings from dead cycles, so this walks a graph of them.
function removeUnreachable(program: Node, tree: Tree, sweepable: Set<Node>, candidates: Set<Node>) {
  const { parents, removed, unexported, localDeclarators } = tree;
  const { bindingOf } = crawl(program, tree);
  const tracked = new Map<Binding, Set<Node>>();
  const candidateOwners = new Map<Binding, Set<Node>>();
  const addOwner = (owners: Map<Binding, Set<Node>>, binding: Binding, owner: Node) => {
    const nodes = owners.get(binding) ?? new Set();
    nodes.add(owner);
    owners.set(binding, nodes);
  };

  for (const identifier of sweepable) {
    if (isOwnExpressionName(identifier, parents) || isInlineAssignment(identifier, parents)) {
      continue;
    }
    const binding = bindingOf(identifier);
    if (!binding) continue;
    addOwner(tracked, binding, parents.get(identifier));
    if (candidates.has(identifier)) addOwner(candidateOwners, binding, parents.get(identifier));
  }

  const isInsideExport = (owner: Node) => {
    if (localDeclarators.has(owner)) return false;
    for (let node = parents.get(owner); node; node = parents.get(node)) {
      if (localDeclarators.has(node)) return false;
      if (isExportWrapper(node) && !unexported.has(node)) return true;
    }
    return false;
  };

  const ownerBindings = new Map<Node, Binding>();
  const dependencies = new Map<Binding, Set<Binding>>();
  const live = new Set<Binding>();
  for (const [binding, owners] of tracked) {
    dependencies.set(binding, new Set());
    for (const owner of owners) {
      ownerBindings.set(owner, binding);
      if (isInsideExport(owner)) live.add(binding);
    }
  }

  for (const target of tracked.keys()) {
    const references = target.violations.concat(
      target.references.filter(reference => !isTypeOnly(reference, tree))
    );
    for (const reference of references) {
      let node = reference;
      while (node && !ownerBindings.has(node)) node = parents.get(node);
      if (node) dependencies.get(ownerBindings.get(node)!)!.add(target);
      else live.add(target);
    }
  }

  const pending = [...live];
  while (pending.length) {
    for (const dependency of dependencies.get(pending.pop()!) ?? []) {
      if (live.has(dependency)) continue;
      live.add(dependency);
      pending.push(dependency);
    }
  }

  const dead = new Set([...candidateOwners.keys()].filter(binding => !live.has(binding)));
  if (!dead.size) return;

  const removeDeadDeclarators = (node: Node) => {
    if (removed.has(node)) return;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      const binding = bindingOf(node.id);
      if (binding && dead.has(binding)) removeDeclarator(node, tree);
    }
    forEachChild(node, removeDeadDeclarators);
  };
  removeDeadDeclarators(program);

  for (const binding of dead) {
    for (const owner of candidateOwners.get(binding)!) {
      if (owner.type !== "VariableDeclarator" && !removed.has(owner)) removeStatement(owner, tree);
    }
  }
}

function sweepObjectPattern(declarator: Node, isDead: (identifier: Node) => boolean, tree: Tree) {
  const { removed } = tree;
  const { properties } = declarator.id;
  const rest = properties.at(-1);
  let changed = false;
  for (const [slot, local] of patternLocals(declarator.id)) {
    if (removed.has(slot) || !isDead(local)) continue;
    // Dropping a sibling of a kept `...rest` would change what `rest` collects.
    if (rest?.type === "RestElement" && rest !== slot && !removed.has(rest)) continue;
    removed.add(slot);
    changed = true;
  }
  if (changed && properties.every((property: Node) => removed.has(property))) {
    removeDeclarator(declarator, tree);
  }
  return changed;
}

function sweepArrayPattern(declarator: Node, isDead: (identifier: Node) => boolean, tree: Tree) {
  const { removed } = tree;
  let changed = false;
  for (const [slot, local] of patternLocals(declarator.id)) {
    if (!removed.has(slot) && isDead(local)) {
      removed.add(slot);
      changed = true;
    }
  }
  if (changed && declarator.id.elements.every((e: Node | null) => e && removed.has(e))) {
    removeDeclarator(declarator, tree);
  }
  return changed;
}

function nextToken(code: string, position: number) {
  for (;;) {
    while (/\s/.test(code[position] ?? "")) position++;
    if (code.startsWith("//", position)) {
      const end = code.indexOf("\n", position);
      position = end < 0 ? code.length : end;
    } else if (code.startsWith("/*", position)) {
      position = code.indexOf("*/", position) + 2;
    } else {
      return position;
    }
  }
}

function removeFromList(output: MagicString, items: Node[], removed: Set<Node>) {
  let previousKept: Node | undefined;
  let runStart: Node | undefined;
  for (const item of items) {
    if (removed.has(item)) {
      runStart ??= item;
      continue;
    }
    if (runStart) output.remove(runStart.start, item.start);
    runStart = undefined;
    previousKept = item;
  }
  if (runStart && previousKept) output.remove(previousKept.end, items.at(-1).end);
}

function renderImport(node: Node, code: string, output: MagicString, removed: Set<Node>) {
  const [first, ...rest] = node.specifiers as Node[];
  if (first?.type !== "ImportDefaultSpecifier" || !rest.length) {
    removeFromList(output, node.specifiers, removed);
    return;
  }
  if (removed.has(first)) {
    output.remove(first.start, nextToken(code, nextToken(code, first.end) + 1));
    removeFromList(output, rest, removed);
  } else if (rest.every(specifier => removed.has(specifier))) {
    let end = rest.at(-1)!.end;
    if (rest[0]!.type === "ImportSpecifier") {
      end = nextToken(code, end);
      if (code[end] === ",") end = nextToken(code, end + 1);
      end++;
    }
    output.remove(first.end, end);
  } else {
    removeFromList(output, rest, removed);
  }
}

function renderSplitExport(node: Node, output: MagicString, tree: Tree) {
  const { removed, localDeclarators } = tree;
  const declaration = node.declaration;
  const prefix = (declarator: Node) =>
    `${localDeclarators.has(declarator) ? "" : "export "}${declaration.declare ? "declare " : ""}${declaration.kind} `;
  const kept = (declaration.declarations as Node[]).filter(d => !removed.has(d));
  output.overwrite(node.start, kept[0].start, prefix(kept[0]));
  kept.slice(1).forEach((declarator, index) => {
    output.overwrite(kept[index].end, declarator.start, `;\n${prefix(declarator)}`);
  });
  const lastKept = kept.at(-1)!;
  const last = declaration.declarations.at(-1);
  if (lastKept !== last) output.remove(lastKept.end, last.end);
}

function statementStart(node: Node) {
  const decorator = (node.declaration ?? node).decorators?.[0];
  return decorator ? Math.min(node.start, decorator.start) : node.start;
}

function renderRemovedStatement(
  node: Node,
  parent: Node,
  code: string,
  output: MagicString,
  removed: Set<Node>
) {
  const siblings: Node[] | undefined = Array.isArray(parent.body)
    ? parent.body
    : parent.type === "SwitchCase"
      ? parent.consequent
      : undefined;
  if (!siblings) {
    if (parent.type === "ForStatement" && parent.init === node) output.remove(node.start, node.end);
    else output.overwrite(statementStart(node), node.end, "{}");
    return;
  }
  const next = siblings.slice(siblings.indexOf(node) + 1).find(sibling => !removed.has(sibling));
  let end = node.end;
  while (code[end] === " " || code[end] === "\t") end++;
  if (code[end] === "\r") end++;
  end = code[end] === "\n" ? end + 1 : node.end;
  // Keeps the previous statement from continuing into `(`, `[` and friends.
  if (next && /[([`+\-/*<]/.test(code[next.start]!))
    output.overwrite(statementStart(node), end, ";");
  else output.remove(statementStart(node), end);
}

function render(node: Node, code: string, output: MagicString, tree: Tree) {
  const { removed, unexported, localDeclarators } = tree;
  let ownsRemovedChildren = false;
  switch (node.type) {
    case "ImportDeclaration":
      if (node.specifiers.some((specifier: Node) => removed.has(specifier))) {
        renderImport(node, code, output, removed);
      }
      return;
    case "ExportNamedDeclaration":
      ownsRemovedChildren = true;
      removeFromList(output, node.specifiers, removed);
      if (unexported.has(node)) {
        output.remove(node.start, node.declaration.start);
      } else if (node.declaration?.declarations?.some((d: Node) => localDeclarators.has(d))) {
        renderSplitExport(node, output, tree);
        for (const declarator of node.declaration.declarations) {
          if (!removed.has(declarator)) render(declarator, code, output, tree);
        }
        return;
      }
      break;
    case "ExportDefaultDeclaration":
      if (unexported.has(node)) output.remove(node.start, node.declaration.start);
      break;
    case "VariableDeclaration":
      ownsRemovedChildren = true;
      removeFromList(output, node.declarations, removed);
      break;
    case "ObjectPattern":
      ownsRemovedChildren = true;
      removeFromList(output, node.properties, removed);
      break;
    case "ArrayPattern":
      ownsRemovedChildren = true;
      // Holes keep the remaining elements at their original positions.
      for (const element of node.elements) {
        if (element && removed.has(element)) output.remove(element.start, element.end);
      }
      break;
  }
  forEachChild(node, child => {
    if (!removed.has(child)) render(child, code, output, tree);
    else if (!ownsRemovedChildren) renderRemovedStatement(child, node, code, output, removed);
  });
}
