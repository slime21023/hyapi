import type { HyApplication } from "./types.ts";

export async function requestJson(
  app: Pick<HyApplication, "request">,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const response = await app.request(input, init);
  const body = response.status === 204 ? undefined : await response.json();
  return { response, body };
}

export function expectStatus(response: Response, expected: number): void {
  if (response.status !== expected) {
    throw new Error(`Expected HTTP status ${expected}, received ${response.status}.`);
  }
}
