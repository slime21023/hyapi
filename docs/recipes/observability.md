# Observability

HyAPI emits read-only events instead of offering middleware. Build logging, metrics, and tracing on
`onEvent`.

## Structured logs

```ts
const app = await createApp({
  api,
  implementations,
  onEvent: (event) => {
    if (event.type === "operation.start") return;
    console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
  },
});
```

`operation.end` carries `operationId`, `method`, the declared `path` template, `status`,
`durationMs`, the problem `code` of framework errors, and the error a handler threw for 500s.

## Metrics

Use the `path` template or `operationId` as a label: unlike the actual URL, it has bounded
cardinality.

```ts
const durations = new Map<string, number[]>();

function recordDuration(event: AppEvent): void {
  if (event.type !== "operation.end") return;
  const key = `${event.operationId} ${event.status}`;
  durations.set(key, [...(durations.get(key) ?? []), event.durationMs]);
}

const app = await createApp({ api, implementations, onEvent: recordDuration });
```

Export them with your metrics library. Count `operation.end` events with `deprecated: true` to see
who still calls operations you plan to remove.

## Tracing

Events are not middleware, so start spans in an outer `fetch` wrapper, which sees the whole request,
and annotate them from events:

```ts
const traced = async (request: Request) => {
  return await tracer.startActiveSpan(
    `${request.method} ${new URL(request.url).pathname}`,
    async (span) => {
      try {
        const response = await app.fetch(request);
        span.setAttribute("http.status_code", response.status);
        return response;
      } finally {
        span.end();
      }
    },
  );
};
serve(app, { fetch: traced });
```

## Response contract violations

With `responseValidation: "log"` (the production default), responses that break the contract are
sent but reported as `response.violation` events. Alert on them: they mean the service and its
published document disagree.
