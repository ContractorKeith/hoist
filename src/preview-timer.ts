export interface SweepTimer {
  set(delay: number, action: () => void): () => void;
}
const systemTimer: SweepTimer = {
  set(delay, action) {
    const id = setTimeout(action, delay);
    return () => clearTimeout(id);
  },
};

export function scheduleSweep(
  run: () => Promise<void>,
  value = process.env.HOIST_SWEEP_INTERVAL_MS,
  timer: SweepTimer = systemTimer,
  report: (error: unknown) => void = console.error,
) {
  const interval = Number(value ?? 3600000);
  if (!Number.isInteger(interval) || interval < 1000 || interval > 2147483647)
    throw new Error(
      "HOIST_SWEEP_INTERVAL_MS must be an integer from 1000 to 2147483647.",
    );
  let active = false;
  let cancelTimer: (() => void) | undefined;
  let sweeping: Promise<void> | undefined;
  const schedule = (delay: number) => {
    cancelTimer = timer.set(delay, () => {
      if (!active) return;
      sweeping = Promise.resolve()
        .then(run)
        .catch(report)
        .finally(() => {
          if (active) schedule(interval);
        });
    });
  };
  return {
    start() {
      if (active) return;
      active = true;
      schedule(value === undefined ? 60000 : interval);
    },
    async cancel() {
      active = false;
      cancelTimer?.();
      await sweeping?.catch(report);
    },
  };
}

// Sweep failures must never skip supervised-child cleanup.
export async function finishSupervisor(
  cancelSweep: () => Promise<void> | undefined,
  stop: () => Promise<void>,
  clearChild: () => void,
  report: (error: unknown) => void = console.error,
): Promise<void> {
  await Promise.resolve().then(cancelSweep).catch(report);
  try {
    await stop();
  } finally {
    clearChild();
  }
}
