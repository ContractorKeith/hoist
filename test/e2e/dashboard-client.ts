import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { withSSH } from "./ssh";

export const csrf = (html: string) =>
  /name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1] ?? "";
export async function dashboardClient(
  h: Parameters<Parameters<typeof withSSH>[0]>[0],
) {
  const ca = await readFile(
    join(h.data, "caddy/pki/authorities/local/root.crt"),
    "utf8",
  );
  return (
    path: string,
    cookie = "",
    form?: Record<string, string>,
    signal?: AbortSignal,
    extra: Record<string, string> = {},
  ) =>
    fetch(`https://127.0.0.1:${h.https}${path}`, {
      method: form ? "POST" : "GET",
      redirect: "manual",
      headers: { Host: "hoist.example.test", cookie, ...extra },
      body: form ? new URLSearchParams(form) : undefined,
      tls: { ca, serverName: "hoist.example.test" },
      signal: signal ?? AbortSignal.timeout(10000),
    });
}
