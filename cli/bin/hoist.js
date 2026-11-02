#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants } from "node:os";

const verbs = JSON.parse(
  readFileSync(new URL("../verbs.json", import.meta.url), "utf8"),
);
const args = process.argv.slice(2);
let host = process.env.HOIST_HOST;
if (args[0] === "--host") {
  args.shift();
  host = args.shift();
}
if (args.length === 1 && args[0] === "--help") {
  console.log(
    `Usage: hoist [--host <host>] <verb> (or HOIST_HOST)\n${verbs.map((verb) => `  ${verb}`).join("\n")}`,
  );
} else if (
  !host ||
  !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host) ||
  !args.length
) {
  console.error(
    "Set HOIST_HOST or use hoist --host <host> <verb>; see --help.",
  );
  process.exitCode = 1;
} else {
  const child = spawn("ssh", [`hoist@${host}`, "hoist", ...args], {
    stdio: "inherit",
    shell: false,
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
  });
}
