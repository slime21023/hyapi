// The opt-in document endpoints of `createApp({ documents })`: checked at startup so that none
// shadows a declared route, then answered without running the request flow.
import { problemResponse } from "./problem.ts";
import type { Router } from "./routing.ts";
import type { StartupReport } from "./diagnostics.ts";

/** One document served by {@link createApp}. */
export interface DocumentOption {
  /** The path the document is served at, such as `/openapi.json`. */
  readonly path: string;
  /** The emitted document: text, or a value that is served as JSON. */
  readonly content: unknown;
  /** Overrides the content type that the path implies. */
  readonly contentType?: string;
}

/** A document ready to serve. */
export interface ServedDocument {
  readonly text: string;
  readonly type: string;
}

/** Checks one document option; undefined when it cannot be served. */
function servedDocument(
  document: DocumentOption,
  router: Router,
  error: StartupReport,
): ServedDocument | undefined {
  const { path, content, contentType } = document ?? {};
  if (typeof path !== "string" || !path.startsWith("/")) {
    error("invalid-option", "every document path must start with '/'");
    return undefined;
  }
  if (router.match("GET", path).kind !== "not-found") {
    error("document-route-conflict", `document path '${path}' is a declared route`);
    return undefined;
  }
  const type = contentType ?? (/\.ya?ml$/i.test(path) ? "application/yaml" : "application/json");
  if (typeof content !== "string" && type !== "application/json") {
    error("invalid-option", `document '${path}' is ${type}, so its content must be text`);
    return undefined;
  }
  return { text: typeof content === "string" ? content : JSON.stringify(content), type };
}

/** The opt-in document endpoints by path; none may shadow a declared route. */
export function documentEndpoints(
  documents: readonly DocumentOption[] | undefined,
  router: Router,
  error: StartupReport,
): ReadonlyMap<string, ServedDocument> {
  const served = new Map<string, ServedDocument>();
  if (documents === undefined) return served;
  if (!Array.isArray(documents)) {
    error("invalid-option", "documents must be a list of { path, content }");
    return served;
  }
  for (const document of documents) {
    const endpoint = servedDocument(document, router, error);
    if (endpoint === undefined) continue;
    if (served.has(document.path)) {
      error("invalid-option", `document path '${document.path}' is listed twice`);
      continue;
    }
    served.set(document.path, endpoint);
  }
  return served;
}

/** A document endpoint answers GET and HEAD. */
export function serveDocument(document: ServedDocument, method: string): Response {
  if (method !== "GET" && method !== "HEAD") {
    return problemResponse(405, "METHOD_NOT_ALLOWED", { headers: { allow: "GET, HEAD" } });
  }
  return new Response(method === "HEAD" ? null : document.text, {
    headers: { "content-type": document.type },
  });
}
