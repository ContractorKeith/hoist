// Restart repair runs beside the supervisor, with bounded attempts and cancellable backoff.
export async function retryReconcile(
  run: (signal: AbortSignal) => Promise<string[]>,
  signal: AbortSignal,
  report: (message: string) => void,
  wait: (ms: number, signal: AbortSignal) => Promise<void>,
  timeoutMs = 30_000,
): Promise<void> {
  const delays = [5000, 15000, 45000];
  let attempt = 0;
  while (!signal.aborted) {
    let errors: string[];
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    try {
      errors = await run(bounded);
      if (bounded.aborted && !signal.aborted && !errors.length)
        errors = [String(bounded.reason)];
    } catch (error) {
      if (signal.aborted) return;
      errors = [String(error)];
    }
    if (signal.aborted || !errors.length) return;
    const delay = delays[Math.min(attempt++, delays.length - 1)] ?? 45000;
    report(
      `Caddy restart reconcile: ${errors.join("; ")}; retrying in ${delay / 1000} s`,
    );
    try {
      await wait(delay, signal);
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }
}
