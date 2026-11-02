import { expect } from "bun:test";
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

export async function dashboardAssetsAndStream(
  client: Awaited<ReturnType<typeof dashboardClient>>,
  cookie: string,
  logsPath: string,
): Promise<string> {
  for (const [path, type] of [
    ["style.css", "text/css"],
    ["htmx.min.js", "text/javascript"],
    ["dashboard.js", "text/javascript"],
  ]) {
    const asset = await client(`/static/${path}`, cookie);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toStartWith(type ?? "");
    expect(asset.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    await asset.body?.cancel();
  }
  const logsHTML = await (await client(logsPath, cookie)).text();
  const streamPath = /data-log-stream="([^"]+)"/
    .exec(logsHTML)?.[1]
    ?.replaceAll("&amp;", "&");
  if (!streamPath) throw new Error("Logs page is missing its stream URL");

  return streamPath;
}
