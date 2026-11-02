import { expect, test } from "bun:test";
import { parseLogs } from "../../src/cli/logs";
import { releaseLogPath } from "../../src/core/logs";

const options = { app: "hello", branch: "main", follow: false, lines: 100 };

test("logs parses defaults and all flags", () => {
  expect(parseLogs(["hello"])).toEqual({ ...options, release: undefined });
  expect(
    parseLogs(["hello", "-f", "-n", "1", "--branch", "feature/x"]),
  ).toEqual({
    ...options,
    follow: true,
    lines: 1,
    branch: "feature/x",
    release: undefined,
  });
  expect(parseLogs(["hello", "-n", "10000"]).lines).toBe(10000);
  for (const args of [
    [],
    ["../hello"],
    ["hello", "--json"],
    ["hello", "-f", "-f"],
    ["hello", "--branch"],
    ["hello", "--release", "../v1"],
    ["hello", "--release", "v1", "-f"],
    ["hello", "--release", "v1", "-n", "1"],
  ])
    expect(() => parseLogs(args)).toThrow();
  for (const n of ["0", "-1", "10001", "1.5", "1e2", "", "NaN"])
    expect(() => parseLogs(["hello", "-n", n])).toThrow();
});

test("release log names validate every path piece", () => {
  expect(releaseLogPath("/private", "hello", "Feature/x", "v12")).toBe(
    "/private/releases/hello/feature-x/v12/build.log",
  );
  for (const [app, branch, release] of [
    ["../hello", "main", "v1"],
    ["hello", "../../main", "v1"],
    ["hello", "main", "v1234567890"],
    ["hello", "main", "v1/.."],
    ["hello", "main", "1"],
  ])
    expect(() =>
      releaseLogPath("/private", app ?? "", branch ?? "", release ?? ""),
    ).toThrow();
});
