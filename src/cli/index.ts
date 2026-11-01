import { version } from "../../package.json";

export function run(args: string[]): number {
  if (args.length === 1 && args[0] === "version") {
    console.log(version);
    return 0;
  }
  console.error("Usage: hoist version");
  return 1;
}

if (import.meta.main) process.exitCode = run(Bun.argv.slice(2));
