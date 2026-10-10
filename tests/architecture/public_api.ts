// Renders the public API of every package entry point as TypeScript-like signatures, so that a
// change to the public surface is always deliberate (ADR 0004 §4). Where a declaration lives and
// how it is documented are not part of its shape. `deno task api:update` rewrites the snapshot.
import { ROOT } from "./repository.ts";

/** Every public entry point, relative to the repository root. */
export const ENTRY_POINTS: readonly string[] = [
  "packages/core/contract.ts",
  "packages/core/openapi.ts",
  "packages/core/mod.ts",
  "packages/core/deno.ts",
  "packages/cli/mod.ts",
  "packages/openapi-diff/mod.ts",
  "packages/plugin-cors/mod.ts",
  "packages/plugin-csrf/mod.ts",
  "packages/plugin-jwt/mod.ts",
  "packages/plugin-oidc/mod.ts",
  "packages/plugin-rate-limit/mod.ts",
];

export const SNAPSHOT = "tests/architecture/public_api.snapshot.txt";

// deno-lint-ignore no-explicit-any
type Node = any;

const list = (items: readonly Node[] | undefined, render: (item: Node) => string, sep = ", ") =>
  (items ?? []).map(render).join(sep);

function typeParams(params: readonly Node[] | undefined): string {
  if (!params?.length) return "";
  return `<${
    list(params, (p) =>
      `${p.name}${p.constraint ? ` extends ${type(p.constraint)}` : ""}${
        p.default ? ` = ${type(p.default)}` : ""
      }`)
  }>`;
}

function param(p: Node): string {
  if (p.kind === "identifier") {
    return `${p.name}${p.optional ? "?" : ""}${p.tsType ? `: ${type(p.tsType)}` : ""}`;
  }
  if (p.kind === "assign") return `${param(p.left)} = …`;
  if (p.kind === "rest") return `...${param(p.arg)}`;
  return JSON.stringify(p);
}

function modifier(value: unknown, word: string): string {
  if (value === true || value === "+") return `${word} `;
  if (value === "-") return `-${word} `;
  return "";
}

function member(p: Node): string {
  const name = p.computed ? `[${p.name}]` : p.name;
  return `${p.readonly ? "readonly " : ""}${name}${p.optional ? "?" : ""}: ${type(p.tsType)}`;
}

function method(m: Node): string {
  return `${m.name}${m.optional ? "?" : ""}${typeParams(m.typeParams)}(${list(m.params, param)}): ${
    type(m.returnType)
  }`;
}

function indexSignature(s: Node): string {
  return `${s.readonly ? "readonly " : ""}[${list(s.params, param)}]: ${type(s.tsType)}`;
}

function typeLiteral(value: Node): string {
  const members = [
    ...(value.properties ?? []).map(member),
    ...(value.methods ?? []).map(method),
    ...(value.indexSignatures ?? []).map(indexSignature),
  ];
  return members.length === 0 ? "{}" : `{ ${members.join("; ")} }`;
}

function literal(value: Node): string {
  if (value.kind === "string") return JSON.stringify(value.string);
  if (value.kind === "number") return String(value.number);
  if (value.kind === "boolean") return String(value.boolean);
  return JSON.stringify(value);
}

/** Renders one type node; unknown node kinds keep their raw form, so nothing is dropped. */
function type(node: Node): string {
  if (node === undefined || node === null) return "void";
  const v = node.value;
  switch (node.kind) {
    case "keyword":
      return v;
    case "literal":
      return literal(v);
    case "typeRef":
      return `${v.typeName}${v.typeParams ? `<${list(v.typeParams, type)}>` : ""}`;
    case "union":
      return list(v, type, " | ");
    case "intersection":
      return list(v, type, " & ");
    case "array":
      return `${type(v)}[]`;
    case "tuple":
      return `[${list(v, type)}]`;
    case "parenthesized":
      return `(${type(v)})`;
    case "typeOperator":
      return `${v.operator} ${type(v.tsType)}`;
    case "typeQuery":
      return `typeof ${v}`;
    case "typeLiteral":
      return typeLiteral(v);
    case "indexedAccess":
      return `${type(v.objType)}[${type(v.indexType)}]`;
    case "infer":
      return `infer ${v.typeParam.name}`;
    case "conditional":
      return `${type(v.checkType)} extends ${type(v.extendsType)} ? ${type(v.trueType)} : ${
        type(v.falseType)
      }`;
    case "mapped":
      return `{ ${modifier(v.readonly, "readonly")}[${v.typeParam.name} in ${
        type(v.typeParam.constraint)
      }${v.nameType ? ` as ${type(v.nameType)}` : ""}]${
        v.optional === "-" ? "-?" : v.optional ? "?" : ""
      }: ${type(v.tsType)} }`;
    case "fnOrConstructor":
      return `${v.constructor ? "new " : ""}${typeParams(v.typeParams)}(${
        list(v.params, param)
      }) => ${type(v.tsType)}`;
    default:
      return node.repr ? node.repr : JSON.stringify(node);
  }
}

/** Renders one declaration of a public symbol. */
function declaration(name: string, kind: string, def: Node): string {
  switch (kind) {
    case "typeAlias":
      return `type ${name}${typeParams(def.typeParams)} = ${type(def.tsType)}`;
    case "function":
      return `${def.isAsync ? "async " : ""}function ${name}${typeParams(def.typeParams)}(${
        list(def.params, param)
      }): ${type(def.returnType)}`;
    case "variable":
      return `${def.kind} ${name}: ${type(def.tsType)}`;
    case "interface": {
      const extended = def.extends?.length ? ` extends ${list(def.extends, type)}` : "";
      const members = [
        ...(def.properties ?? []).map(member),
        ...(def.methods ?? []).map(method),
        ...(def.indexSignatures ?? []).map(indexSignature),
      ];
      return `interface ${name}${typeParams(def.typeParams)}${extended} {${
        members.map((m) => `\n  ${m};`).join("")
      }\n}`;
    }
    case "class": {
      const members = [
        ...(def.constructors ?? []).map((c: Node) => `constructor(${list(c.params, param)})`),
        ...(def.properties ?? []).map((p: Node) => `${p.isStatic ? "static " : ""}${member(p)}`),
        ...(def.methods ?? []).map((m: Node) =>
          `${m.isStatic ? "static " : ""}${m.name}${typeParams(m.functionDef?.typeParams)}(${
            list(m.functionDef?.params, param)
          }): ${type(m.functionDef?.returnType)}`
        ),
      ];
      const extended = def.extends ? ` extends ${def.extends}` : "";
      return `class ${name}${typeParams(def.typeParams)}${extended} {${
        members.map((m) => `\n  ${m};`).join("")
      }\n}`;
    }
    default:
      return `${kind} ${name} ${JSON.stringify(def)}`;
  }
}

interface DocSymbol {
  readonly name: string;
  readonly declarations: readonly { readonly kind: string; readonly def?: Node }[];
}

/** The rendered public symbols of one entry point, sorted by name. */
async function entryApi(root: string, entry: string): Promise<string[]> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["doc", "--json", entry],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  const doc = JSON.parse(new TextDecoder().decode(output.stdout)) as {
    readonly nodes: Readonly<Record<string, { readonly symbols: readonly DocSymbol[] }>>;
  };
  const rendered: [string, string][] = [];
  for (const module of Object.values(doc.nodes)) {
    for (const symbol of module.symbols) {
      for (const d of symbol.declarations) {
        rendered.push([symbol.name, declaration(symbol.name, d.kind, d.def ?? {})]);
      }
    }
  }
  rendered.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1));
  return rendered.map(([, text]) => text);
}

/** The public API of every entry point, as the snapshot stores it. */
export async function publicApi(root: string): Promise<string> {
  const sections: string[] = [];
  for (const entry of ENTRY_POINTS) {
    sections.push(`## ${entry}\n\n${(await entryApi(root, entry)).join("\n")}\n`);
  }
  return sections.join("\n");
}

if (import.meta.main) {
  await Deno.writeTextFile(`${ROOT}/${SNAPSHOT}`, await publicApi(ROOT));
  console.log(`wrote ${SNAPSHOT}`);
}
