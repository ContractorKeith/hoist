import { expect, test } from "bun:test";
import { allowRequest, startDashboard } from "../../src/web/server";
import { setup } from "./dashboard-support";

test("startDashboard binds only loopback, requires Caddy HTTPS and serves health", async () => {
  const h = await setup();
  const web = startDashboard(h.root, h.store, h.docker, { port: 0 });
  try {
    expect(web.server.hostname).toBe("127.0.0.1");
    const url = `http://127.0.0.1:${web.server.port}/healthz`;
    const refused = await fetch(url);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("Caddy HTTPS required");
    expect(refused.headers.get("X-Frame-Options")).toBe("DENY");
    const response = await fetch(url, {
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok\n");
  } finally {
    await web.stop();
    await h.close();
  }
});

test("the ingress guard refuses a non-loopback peer even with the HTTPS header", () => {
  const fakeServer = { requestIP: () => ({ address: "10.0.0.5" }) };
  const headers = new Headers({ "X-Forwarded-Proto": "https" });
  expect(allowRequest(fakeServer.requestIP().address, headers)).toBe(false);
  expect(allowRequest(undefined, headers)).toBe(false);
  expect(allowRequest("127.0.0.1", headers)).toBe(true);
  expect(allowRequest("::1", headers)).toBe(true);
  expect(allowRequest("127.0.0.1", new Headers())).toBe(false);
});
