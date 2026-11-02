import { expect, test } from "bun:test";
import {
  finishSupervisor,
  type SweepTimer,
  scheduleSweep,
} from "../../src/preview-timer";

function timerFixture() {
  const pending: { delay: number; action: () => void; cancelled: boolean }[] =
    [];
  const timer: SweepTimer = {
    set(delay, action) {
      const call = { delay, action, cancelled: false };
      pending.push(call);
      return () => {
        call.cancelled = true;
      };
    },
  };
  return { pending, timer };
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("sweeper waits 60 seconds then reschedules hourly and cancels shutdown timers", async () => {
  const h = timerFixture();
  let runs = 0;
  const sweeper = scheduleSweep(
    async () => {
      runs++;
    },
    undefined,
    h.timer,
  );
  expect(h.pending).toEqual([]);
  sweeper.start();
  expect(h.pending[0]?.delay).toBe(60000);
  h.pending[0]?.action();
  await flush();
  expect(runs).toBe(1);
  expect(h.pending[1]?.delay).toBe(3600000);
  await sweeper.cancel();
  expect(h.pending[1]?.cancelled).toBe(true);
  h.pending[1]?.action();
  await flush();
  expect(runs).toBe(1);
  expect(h.pending).toHaveLength(2);
});

test("override bounds and delays, rejected sweeps are observed and shutdown still reaps child", async () => {
  const h = timerFixture(),
    errors: unknown[] = [],
    order: string[] = [];
  for (const value of ["999", "1.5", "NaN", "2147483648"])
    expect(() => scheduleSweep(async () => {}, value, h.timer)).toThrow(
      "HOIST_SWEEP_INTERVAL_MS",
    );
  const error = new Error("sweep failed");
  const sweeper = scheduleSweep(
    async () => {
      throw error;
    },
    "1000",
    h.timer,
    (e) => errors.push(e),
  );
  sweeper.start();
  expect(h.pending[0]?.delay).toBe(1000);
  h.pending[0]?.action();
  await flush();
  expect(errors).toEqual([error]);
  expect(h.pending[1]?.delay).toBe(1000);
  await finishSupervisor(
    () => sweeper.cancel(),
    async () => {
      order.push("stop");
    },
    () => order.push("clear"),
  );
  expect(order).toEqual(["stop", "clear"]);
  expect(h.pending[1]?.cancelled).toBe(true);
  await finishSupervisor(
    async () => {
      throw error;
    },
    async () => {
      order.push("stop-again");
    },
    () => order.push("clear-again"),
    (e) => errors.push(e),
  );
  expect(order.slice(-2)).toEqual(["stop-again", "clear-again"]);
  expect(errors).toEqual([error, error]);
});

test("shutdown waits for an active sweep without rescheduling", async () => {
  const h = timerFixture();
  let finish!: () => void;
  const sweeper = scheduleSweep(
    () =>
      new Promise<void>((r) => {
        finish = r;
      }),
    "1000",
    h.timer,
  );
  sweeper.start();
  h.pending[0]?.action();
  await flush();
  let cancelled = false;
  const stopping = sweeper.cancel().then(() => {
    cancelled = true;
  });
  await flush();
  expect(cancelled).toBe(false);
  finish();
  await stopping;
  expect(cancelled).toBe(true);
  expect(h.pending).toHaveLength(1);
});
