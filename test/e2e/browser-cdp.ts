// Minimal DevTools client for the optional Chromium acceptance check; no test dependency.
export async function connectPage(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Chromium DevTools connection failed")),
      { once: true },
    );
  });
  let nextId = 0;
  const pending = new Map<
    number,
    {
      resolve: (result: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  socket.addEventListener("message", (event) => {
    const response = JSON.parse(String(event.data)) as {
      id?: number;
      result?: Record<string, unknown>;
      error?: { message: string };
    };
    if (response.id === undefined) return;
    const call = pending.get(response.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(response.id);
    if (response.error) call.reject(new Error(response.error.message));
    else call.resolve(response.result ?? {});
  });
  const close = () => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Chromium page closed"));
    }
    pending.clear();
    socket.close();
  };
  socket.addEventListener("close", close, { once: true });
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Chromium ${method} timed out`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    command,
    close,
    async evaluate(expression: string): Promise<unknown> {
      const result = await command("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error("Chromium page evaluation failed");
      return (result.result as { value?: unknown })?.value;
    },
  };
}
