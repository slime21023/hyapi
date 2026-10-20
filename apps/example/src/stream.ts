/** The timer belongs to the stream, not the returned handler's request scope. */
export function streamResponse(): Response {
  const encoder = new TextEncoder();
  let timer: NodeJS.Timeout | undefined;
  let sequence = 0;
  const dispose = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        controller.enqueue(encoder.encode(`${JSON.stringify({ sequence: ++sequence })}\n`));
        if (sequence === 3) {
          dispose();
          controller.close();
        }
      }, 25);
    },
    cancel: dispose,
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
}
