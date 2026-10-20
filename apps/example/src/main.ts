import type { Listener } from "hyapi";
import { buildExampleApp } from "./app.ts";

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error("JWT_SECRET must be set.");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must be set.");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "8000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

const app = await buildExampleApp({ jwtSecret: secret, databaseUrl });
const traceparentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const tracedFetch = async (request: Request): Promise<Response> => {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  const traceparent = request.headers.get("traceparent");
  const traceId =
    traceparent && traceparentPattern.test(traceparent)
      ? traceparent.slice(3, 35)
      : requestId.replaceAll("-", "");
  const path = new URL(request.url).pathname;
  try {
    const response = await app.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    console.log(
      JSON.stringify({
        event: "http.response",
        requestId,
        traceId,
        method: request.method,
        path,
        status: response.status,
        durationMs: Math.round(performance.now() - started),
      }),
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.error(
      JSON.stringify({ event: "http.error", requestId, traceId, method: request.method, path }),
    );
    throw error;
  }
};
let bound: Listener | undefined;
try {
  bound = await app.listen({ hostname: host, port, fetch: tracedFetch });
  console.log(`HyAPI listening on ${bound.url}`);
} catch (error) {
  await app.close();
  throw error;
}

const signals: NodeJS.Signals[] =
  process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
await new Promise<void>((resolve, reject) => {
  const shutdown = () => {
    for (const signal of signals) process.removeListener(signal, shutdown);
    void (async () => {
      const errors: unknown[] = [];
      try {
        await bound?.stop();
      } catch (error) {
        errors.push(error);
      }
      try {
        await app.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Application shutdown failed.");
    })().then(resolve, reject);
  };
  for (const signal of signals) process.once(signal, shutdown);
});
