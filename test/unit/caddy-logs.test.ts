import { expect, test } from "bun:test";
import { caddyLogs } from "../e2e/caddy-logs";

test("live Caddy cannot block failure reporting on an open stderr stream", async () => {
  const result = await Promise.race([
    caddyLogs({ exitCode: null }, new Promise<string>(() => {}), 20),
    Bun.sleep(500).then(() => "failure reporting hung"),
  ]);
  expect(result).toBe("Caddy still running; stderr unavailable");
});

test("exited Caddy preserves stderr and missing logs are empty", async () => {
  expect(
    await caddyLogs({ exitCode: 0 }, Promise.resolve("Caddy stderr")),
  ).toBe("Caddy stderr");
  expect(await caddyLogs(undefined, undefined)).toBe("");
});
