export function healthyStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

// The probe owns HTTP; core owns the health deadline and polling policy.
export async function pollHealth(
  path: string,
  probe: (signal: AbortSignal) => Promise<number>,
  clock = { now: () => Date.now(), sleep: (ms: number) => Bun.sleep(ms) },
): Promise<void> {
  const deadline = clock.now() + 30000;
  let output = "no response";
  while (clock.now() < deadline) {
    try {
      const status = await probe(
        AbortSignal.timeout(
          Math.max(1, Math.min(2000, deadline - clock.now())),
        ),
      );
      output = `HTTP ${status}`;
      if (healthyStatus(status)) return;
    } catch (error) {
      output = error instanceof Error ? error.message : String(error);
    }
    await clock.sleep(Math.min(500, Math.max(0, deadline - clock.now())));
  }
  throw new Error(`Health check GET ${path} failed after 30 s: ${output}`);
}
