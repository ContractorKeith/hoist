import { expect, spyOn, test } from "bun:test";
import { startDashboard } from "../../src/web/server";
import { setup } from "./dashboard-support";

test("fixed-length and chunked oversized forms return secured HTML 413 without stderr", async () => {
  const h = await setup(),
    web = startDashboard(h.root, h.store, h.docker, { port: 0 });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const chunked of [false, true]) {
      const data = `password=${"x".repeat(20000)}`;
      const body = chunked
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(data.slice(0, 10000)),
              );
              controller.enqueue(new TextEncoder().encode(data.slice(10000)));
              controller.close();
            },
          })
        : data;
      const response = await fetch(
        `http://127.0.0.1:${web.server.port}/login`,
        {
          method: "POST",
          headers: {
            "X-Forwarded-Proto": "https",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        },
      );
      expect(response.status).toBe(413);
      expect(response.headers.get("Content-Type")).toStartWith("text/html");
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const page = await response.text();
      expect(page).toContain("<!doctype html>");
      expect(page).toContain("Back");
    }
    expect(errors).not.toHaveBeenCalled();
  } finally {
    errors.mockRestore();
    await web.stop();
    await h.close();
  }
});
