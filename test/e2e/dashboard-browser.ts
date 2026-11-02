import { expect } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stopChild } from "../../src/adapters/process";
import { connectPage } from "./browser-cdp";
import { eventually } from "./harness";
import type { withSSH } from "./ssh";

type Harness = Parameters<Parameters<typeof withSSH>[0]>[0];
export async function checkBrowserLogs(
  h: Harness,
  path: string,
  cookie: string,
): Promise<boolean> {
  const executable = [
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ]
    .map((name) => Bun.which(name))
    .find(Boolean);
  if (!executable) {
    console.log("Chromium unavailable; browser log check skipped.");
    return false;
  }
  const profile = join(h.root, "chromium");
  // A short alias avoids Linux's Unix-socket path limit on deeply nested worktrees.
  const root = resolve(import.meta.dir, "../..");
  await mkdir(join(root, ".tmp"), { recursive: true });
  const child = Bun.spawn(
    [
      executable,
      "--headless",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--ignore-certificate-errors",
      "--no-proxy-server",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--host-resolver-rules=MAP hoist.example.test 127.0.0.1",
      "about:blank",
    ],
    {
      cwd: root,
      env: { ...h.env, TMPDIR: "/proc/self/cwd/.tmp" },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  let page: Awaited<ReturnType<typeof connectPage>> | undefined;
  try {
    let port = "";
    await eventually(async () => {
      if (child.exitCode !== null)
        throw new Error(`Chromium exited: ${child.exitCode}`);
      port =
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0] ?? "";
      expect(port).toMatch(/^[0-9]+$/);
    }, 30000);
    const targets = (await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((item) => item.type === "page");
    if (!target) throw new Error("Missing Chromium page");
    page = await connectPage(target.webSocketDebuggerUrl);
    const origin = `https://hoist.example.test:${h.https}`;
    const [name, value] = cookie.split("=");
    expect(
      await page.command("Network.setCookie", {
        name,
        value,
        url: origin,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      }),
    ).toEqual({ success: true });
    await page.command("Page.navigate", { url: origin + path });
    const output =
      "document.querySelector('pre[data-log-stream]')?.textContent ?? ''";
    await eventually(
      async () => expect(await page?.evaluate(output)).toContain("ready"),
      15000,
    );
    const marker = `browser-${crypto.randomUUID()}`;
    const started = Date.now();
    await (await h.request(undefined, `/cgi-bin/log?${marker}`)).text();
    await eventually(
      async () => expect(await page?.evaluate(output)).toContain(marker),
      2000,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(
      await page.evaluate(
        "document.querySelector('pre[data-log-stream]').childElementCount",
      ),
    ).toBe(0);
    console.log(
      "Chromium: live log <pre> gained the HTTP-triggered line within 2 s.",
    );
    return true;
  } finally {
    page?.close();
    await stopChild(child);
  }
}
