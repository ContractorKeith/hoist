import { expect, test } from "bun:test";
import { Caddy } from "../../src/adapters/caddy";

test("route edits reject an admin response missing its concurrency ETag", async () => {
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.method);
      return Response.json([]);
    },
  });
  try {
    const caddy = new Caddy(server.port);
    await expect(
      caddy.upsertRoute("hello.test", "127.0.0.1:8080"),
    ).rejects.toThrow("Caddy response missing Etag");
    expect(requests).toEqual(["GET"]);
  } finally {
    await server.stop(true);
  }
});
