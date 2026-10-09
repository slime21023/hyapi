// Enforces the nesting rule of AGENTS.md: control blocks and closures nest at most two levels
// inside a top-level declaration. `else if` continues its chain at the same level, and an arrow
// function whose body is a single expression, or empty, does not count as a level.
import ts from "typescript";

export interface NestingViolation {
  readonly file: string;
  readonly line: number;
  /** The enclosing top-level declaration. */
  readonly within: string;
  /** The nested constructs, outermost first, such as `loop > if > if`. */
  readonly chain: string;
}

const MAX_DEPTH = 2;

function isControl(node: ts.Node): boolean {
  return ts.isIfStatement(node) || ts.isForStatement(node) || ts.isForOfStatement(node) ||
    ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) ||
    ts.isTryStatement(node) || ts.isSwitchStatement(node);
}

function isClosure(node: ts.Node): boolean {
  // `(x) => x.name` and `() => {}` read as values, not as nested code.
  if (ts.isArrowFunction(node)) return ts.isBlock(node.body) && node.body.statements.length > 0;
  return ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) ||
    ts.isFunctionDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
}

function kindOf(node: ts.Node): string {
  if (ts.isIfStatement(node)) return "if";
  if (ts.isSwitchStatement(node)) return "switch";
  if (ts.isTryStatement(node)) return "try";
  return isControl(node) ? "loop" : "closure";
}

/** The name of a top-level declaration, or an empty string for other statements. */
function declarationName(node: ts.Node): string {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
    return node.name.text;
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((d) => d.name.getText()).join(", ");
  }
  return "";
}

/**
 * True for the function of a top-level declaration, such as `function f() {}`,
 * `const f = () => {}`, or a method of a top-level class. Its body is level zero.
 */
function isTopLevelFunction(node: ts.Node): boolean {
  let parent = node.parent;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return ts.isClassDeclaration(parent) && ts.isSourceFile(parent.parent);
  }
  while (
    ts.isVariableDeclaration(parent) || ts.isVariableDeclarationList(parent) ||
    ts.isVariableStatement(parent)
  ) parent = parent.parent;
  return ts.isSourceFile(parent);
}

/** Finds every place in one source file that nests deeper than the rule allows. */
export function checkNesting(file: string, source: string): NestingViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: NestingViolation[] = [];

  // `chain` holds the levels around `node`. An `else if` gets the chain of its first `if`, so it
  // sits at the same level; it is not reported again.
  const visit = (node: ts.Node, chain: readonly string[], within: string, elseIf: boolean) => {
    let inner = chain;
    if (isControl(node) || (isClosure(node) && !isTopLevelFunction(node))) {
      inner = [...chain, kindOf(node)];
      if (inner.length === MAX_DEPTH + 1 && !elseIf) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        violations.push({ file, line, within, chain: inner.join(" > ") });
      }
    }
    ts.forEachChild(node, (child) => {
      const isElseIf = ts.isIfStatement(node) && child === node.elseStatement &&
        ts.isIfStatement(child);
      visit(child, isElseIf ? chain : inner, within, isElseIf);
    });
  };

  for (const statement of sourceFile.statements) {
    visit(statement, [], declarationName(statement) || "(module)", false);
  }
  return violations;
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* sourceFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** Checks every module under `packages/`, relative to the repository root. */
export async function checkRepositoryNesting(root: string): Promise<NestingViolation[]> {
  const violations: NestingViolation[] = [];
  for await (const file of sourceFiles(`${root}/packages`)) {
    const path = file.slice(root.length + 1);
    violations.push(...checkNesting(path, await Deno.readTextFile(file)));
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
