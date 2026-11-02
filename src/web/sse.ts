import type { DockerClient } from "../adapters/interfaces";
import { liveLogs } from "../core/logs";
import type { Store } from "../store/interface";

export function logStream(
  store: Store,
  docker: DockerClient,
  app: string,
  branch: string,
  request: Request,
  valid: () => boolean,
): Response {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  let pending = "",
    truncated = false;
  const event = async (value: string, type = "message") => {
    await writer.write(
      encoder.encode(
        `event: ${type}\ndata: ${value.replace(/\n/g, "\ndata: ")}\n\n`,
      ),
    );
  };
  // Readable cancellation rejects writes; abort Docker immediately even while it is idle.
  void writer.closed.catch(abort);
  const timer = setInterval(() => {
    if (!valid()) abort();
  }, 1000);
  void (async () => {
    try {
      await liveLogs(
        store,
        docker,
        { app, branch, lines: 100, follow: true },
        controller.signal,
        async (chunk) => {
          const parts = decoder.decode(chunk, { stream: true }).split("\n");
          for (const [index, part] of parts.entries()) {
            const room = 65536 - pending.length;
            pending += part.slice(0, room);
            if (part.length > room) truncated = true;
            if (index < parts.length - 1) {
              await event(pending + (truncated ? " … [line truncated]" : ""));
              pending = "";
              truncated = false;
            }
          }
        },
      );
      if (pending)
        await event(pending + (truncated ? " … [line truncated]" : ""));
      if (!controller.signal.aborted)
        await event("Log stream ended. Reload to reconnect.", "end");
    } catch {
      if (!controller.signal.aborted)
        await event(
          "Unable to tail logs. Check the live release.",
          "end",
        ).catch(() => {});
    } finally {
      clearInterval(timer);
      request.signal.removeEventListener("abort", abort);
      await writer.close().catch(() => {});
    }
  })();
  controller.signal.addEventListener(
    "abort",
    () => {
      void writer.abort().catch(() => {});
    },
    { once: true },
  );
  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
