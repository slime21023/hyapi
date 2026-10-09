import type { ParameterLocation, ParameterModel } from "../contract/model.ts";

type Kind = "array" | "object" | "primitive";

function kindOf(schema: unknown): Kind {
  const type = (schema as { type?: unknown }).type;
  if (type === "array") return "array";
  if (type === "object") return "object";
  return "primitive";
}

/** Splits `k,v,k,v` (explode false) or `k=v,k=v` (explode true) into an object. */
function objectFromList(text: string, explode: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  if (explode) {
    for (const pair of text.split(",")) {
      const index = pair.indexOf("=");
      if (index > 0) result[pair.slice(0, index)] = pair.slice(index + 1);
    }
  } else {
    const parts = text.split(",");
    for (let i = 0; i + 1 < parts.length; i += 2) result[parts[i]!] = parts[i + 1]!;
  }
  return result;
}

function fromText(text: string, parameter: ParameterModel): unknown {
  const kind = kindOf(parameter.schema);
  if (kind === "array") return text === "" ? [] : text.split(",");
  if (kind === "object") return objectFromList(text, parameter.explode);
  return text;
}

/** Parses a Cookie header; the first occurrence of a name wins. */
export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      cookies.set(name, part.slice(index + 1).trim());
    }
  }
  return cookies;
}

/**
 * Reads the raw (string-valued) parameters of one location. Coercion to schema types and
 * validation happen afterwards; absent parameters are left out.
 */
export function readParameters(
  location: ParameterLocation,
  parameters: readonly ParameterModel[],
  source: {
    readonly params: Readonly<Record<string, string>>;
    readonly url: URL;
    readonly headers: Headers;
  },
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const cookies = location === "cookie" ? parseCookies(source.headers.get("cookie")) : undefined;
  const query = source.url.searchParams;
  for (const parameter of parameters) {
    if (parameter.in !== location) continue;
    const { name } = parameter;
    let value: unknown;
    switch (location) {
      case "path":
        value = source.params[name] === undefined
          ? undefined
          : fromText(source.params[name]!, parameter);
        break;
      case "header": {
        const text = source.headers.get(name);
        value = text === null ? undefined : fromText(text, parameter);
        break;
      }
      case "cookie": {
        const text = cookies!.get(name);
        value = text === undefined ? undefined : fromText(text, parameter);
        break;
      }
      case "query":
        value = readQuery(query, parameter);
        break;
    }
    if (value !== undefined) values[name] = value;
  }
  return values;
}

function readQuery(query: URLSearchParams, parameter: ParameterModel): unknown {
  const { name } = parameter;
  const kind = kindOf(parameter.schema);
  if (parameter.style === "deepObject") {
    const result: Record<string, string> = {};
    const prefix = `${name}[`;
    for (const [key, value] of query) {
      if (key.startsWith(prefix) && key.endsWith("]")) result[key.slice(prefix.length, -1)] = value;
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }
  if (kind === "array") {
    const all = query.getAll(name);
    if (all.length === 0) return undefined;
    return parameter.explode ? all : all.flatMap((value) => value === "" ? [] : value.split(","));
  }
  if (kind === "object" && parameter.explode) {
    // form + explode spreads the object's properties as separate query parameters.
    const properties = (parameter.schema as { properties?: Record<string, unknown> }).properties ??
      {};
    const result: Record<string, string> = {};
    for (const key of Object.keys(properties)) {
      const value = query.get(key);
      if (value !== null) result[key] = value;
    }
    return Object.keys(result).length === 0 ? undefined : result;
  }
  const value = query.get(name);
  return value === null ? undefined : fromText(value, parameter);
}
