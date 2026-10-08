import type { OperationModel } from "../contract/model.ts";

/** The result of matching a request against the declared routes. */
export type RouteMatch =
  | {
    readonly kind: "found";
    readonly operation: OperationModel;
    /** Decoded path parameter values. */
    readonly params: Readonly<Record<string, string>>;
    /** True when a HEAD request is served by a GET operation. */
    readonly head: boolean;
  }
  | { readonly kind: "not-found" }
  | { readonly kind: "method-not-allowed"; readonly allow: readonly string[] }
  | { readonly kind: "malformed-path" };

interface PathPattern {
  readonly template: string;
  readonly regex: RegExp;
  readonly names: readonly string[];
  /** Per segment: 2 for literal, 1 for mixed, 0 for a whole-segment parameter. */
  readonly specificity: readonly number[];
  readonly operations: Map<string, OperationModel>;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(template: string): Omit<PathPattern, "operations"> {
  const names: string[] = [];
  const specificity: number[] = [];
  const source = template.split("/").map((segment) => {
    const params = [...segment.matchAll(/\{([^{}]+)\}/g)];
    specificity.push(params.length === 0 ? 2 : segment === `{${params[0]![1]}}` ? 0 : 1);
    let pattern = "";
    let last = 0;
    for (const param of params) {
      pattern += escapeRegex(segment.slice(last, param.index)) + "([^/]+?)";
      names.push(param[1]!);
      last = param.index! + param[0].length;
    }
    return pattern + escapeRegex(segment.slice(last));
  }).join("/");
  return { template, regex: new RegExp(`^${source}$`), names, specificity };
}

function compareSpecificity(a: PathPattern, b: PathPattern): number {
  for (let i = 0; i < Math.max(a.specificity.length, b.specificity.length); i++) {
    const difference = (b.specificity[i] ?? 0) - (a.specificity[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Compiles the declared operations into a route table. Paths match exactly: no trailing-slash
 * folding and no catch-all parameters. When several templates match, the more literal one wins,
 * as OpenAPI requires; the method is then looked up across every matching template.
 */
export function compileRoutes(operations: readonly OperationModel[]) {
  const patterns = new Map<string, PathPattern>();
  for (const operation of operations) {
    let pattern = patterns.get(operation.path);
    if (pattern === undefined) {
      pattern = { ...compilePattern(operation.path), operations: new Map() };
      patterns.set(operation.path, pattern);
    }
    pattern.operations.set(operation.method, operation);
  }
  // Bucket by segment count; a parameter never spans segments.
  const buckets = new Map<number, PathPattern[]>();
  for (const pattern of patterns.values()) {
    const count = pattern.specificity.length;
    buckets.set(count, [...(buckets.get(count) ?? []), pattern]);
  }
  for (const bucket of buckets.values()) bucket.sort(compareSpecificity);

  return {
    match(method: string, pathname: string): RouteMatch {
      const bucket = buckets.get(pathname.split("/").length) ?? [];
      const allowed = new Set<string>();
      for (const pattern of bucket) {
        const match = pattern.regex.exec(pathname);
        if (match === null) continue;
        const operation = pattern.operations.get(method) ??
          (method === "HEAD" ? pattern.operations.get("GET") : undefined);
        for (const declared of pattern.operations.keys()) allowed.add(declared);
        if (operation === undefined) continue;
        const params: Record<string, string> = {};
        try {
          pattern.names.forEach((name, i) => params[name] = decodeURIComponent(match[i + 1]!));
        } catch {
          return { kind: "malformed-path" };
        }
        return {
          kind: "found",
          operation,
          params,
          head: method === "HEAD" && operation.method === "GET",
        };
      }
      if (allowed.size === 0) return { kind: "not-found" };
      if (allowed.has("GET")) allowed.add("HEAD");
      return { kind: "method-not-allowed", allow: [...allowed].sort() };
    },
  };
}

export type Router = ReturnType<typeof compileRoutes>;
