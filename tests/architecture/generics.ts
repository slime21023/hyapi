// Enforces the naming rule for generics in AGENTS.md: every type parameter, including `infer`
// variables and mapped-type keys, is named for what it holds, never a one- or two-letter name.
import ts from "typescript";
import { readSources } from "./repository.ts";

export interface NamingViolation {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

const MIN_LENGTH = 3;

/** Finds the type parameters of one source file whose names are too short to say anything. */
export function checkTypeParameters(file: string, source: string): NamingViolation[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: NamingViolation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeParameterDeclaration(node) && node.name.text.length < MIN_LENGTH) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      violations.push({ file, line, name: node.name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

/** Checks every module under `packages/`, relative to the repository root. */
export async function checkRepositoryTypeParameters(root: string): Promise<NamingViolation[]> {
  const sources = await readSources(root, "packages");
  return [...sources].flatMap(([path, source]) => checkTypeParameters(path, source));
}
