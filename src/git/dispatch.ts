import { appName } from "../core/validation";

// Tokenize quoting only. Shell expansion, operators and escapes never run.
export function commandArgs(command: string): string[] {
  if (
    !command ||
    command.length > 8192 ||
    [...command].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error("Invalid SSH command");
  const args: string[] = [];
  let token = "",
    quote = "",
    started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === " ") {
      if (started) {
        args.push(token);
        token = "";
        started = false;
      }
    } else {
      if (/[\\;$`|&<>()]/.test(char)) throw new Error("Invalid SSH command");
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed SSH quote");
  if (started) args.push(token);
  if (args.length > 64) throw new Error("Too many SSH arguments");
  return args;
}

export function parseDispatch(
  command: string,
): { kind: "receive"; app: string } | { kind: "cli"; args: string[] } {
  const args = commandArgs(command);
  if (args[0] === "git-upload-pack" || args[0] === "git-upload-archive")
    throw new Error(`hoist is push-only; ${args[0]} refused`);
  if (args[0] === "git-receive-pack") {
    if (args.length !== 2) throw new Error("Invalid git receive command");
    const remote = args[1] ?? "";
    // One optional leading slash is the ssh:// URL spelling, never an arbitrary path.
    const name = remote.replace(/^\//, "").replace(/\.git$/, "");
    appName(name);
    return { kind: "receive", app: name };
  }
  if (args[0] === "hoist") args.shift();
  return { kind: "cli", args };
}
