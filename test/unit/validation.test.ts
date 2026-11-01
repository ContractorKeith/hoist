import { expect, test } from "bun:test";
import * as validate from "../../src/adapters/validation";

test("host names require valid lowercase DNS labels and a nonnumeric final label", () => {
  for (const host of ["hello.test", `${"a".repeat(63)}.test`])
    expect(() => validate.hostName(host)).not.toThrow();
  for (const host of [
    "127.0.0.1",
    `${"a".repeat(64)}.test`,
    "hello.test.",
    "Hello.test",
  ])
    expect(() => validate.hostName(host)).toThrow("Invalid host name");
});

test("ports must be integers in range", () => {
  for (const port of [1, 65535])
    expect(() => validate.port(port)).not.toThrow();
  for (const port of [0, 65536, 1.5])
    expect(() => validate.port(port)).toThrow("Invalid port");
});

test("labels accept simple keys and reject control characters", () => {
  expect(() => validate.labels({ "hoist.test": "fixture" })).not.toThrow();
  expect(() => validate.labels({ "hoist.test": "bad\nvalue" })).toThrow(
    "Invalid label",
  );
});

test("absolute paths allow dots within a segment but reject traversal segments", () => {
  expect(() => validate.absolutePath("/tmp/a..b/fixture")).not.toThrow();
  for (const path of ["/tmp/../fixture", "relative/fixture"])
    expect(() => validate.absolutePath(path)).toThrow("Invalid absolute path");
});

test("image names allow release tags but reject invalid characters", () => {
  expect(() => validate.imageName("hoist/hello:abc123")).not.toThrow();
  expect(() => validate.imageName("hello bad")).toThrow("Invalid image name");
});

test("container IDs require at least twelve hexadecimal characters", () => {
  expect(() => validate.containerId("abcdef012345")).not.toThrow();
  expect(() => validate.containerId("abcdef01234")).toThrow(
    "Invalid container ID",
  );
});

test("upstreams require loopback and a valid port", () => {
  for (const address of ["localhost:8080", "127.0.0.1:8080"])
    expect(() => validate.upstreamAddress(address)).not.toThrow();
  expect(() => validate.upstreamAddress("localhost:0")).toThrow("Invalid port");
  expect(() => validate.upstreamAddress("remote.test:8080")).toThrow(
    "Invalid loopback upstream",
  );
});
