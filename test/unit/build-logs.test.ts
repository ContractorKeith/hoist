import { expect, test } from "bun:test";
import { FakeDocker } from "../../src/adapters/fakes/docker";
import { buildLogDecoder } from "../../src/core/build-logs";

test("fake Docker build chunks become plain text, preserving incomplete and non-JSON lines", async () => {
  const docker = new FakeDocker();
  const chunks: Uint8Array[] = [];
  const decoder = buildLogDecoder(async (chunk) => {
    chunks.push(chunk);
  });
  const raw = new TextEncoder().encode(
    '{"stream":"Step 1/2\\n"}\n{"stream":"\\u001b[31mcafé\\r\\n"}\n' +
      '{"errorDetail":{"message":"broken"},"error":"fallback"}\n' +
      '{"status":"Downloading","progress":"1/10"}\n{"status":"Downloading","progress":"2/10"}\n' +
      '{"status":"Done"}\n{"aux":{"ID":"sha256:abc"}}\n{"error":"failed"}\nnot JSON\nlast partial',
  );
  const split = raw.indexOf(0xc3) + 1;
  docker.buildImage = async () =>
    new ReadableStream({
      start(c) {
        c.enqueue(raw.slice(0, split));
        c.enqueue(raw.slice(split, split + 7));
        c.enqueue(raw.slice(split + 7));
        c.close();
      },
    });
  const stream = await docker.buildImage(
    { contextDir: "/unused", tag: "unused", labels: {} },
    new AbortController().signal,
  );
  for await (const chunk of stream) await decoder.write(chunk);
  await decoder.flush();
  expect(Buffer.concat(chunks).toString()).toBe(
    "Step 1/2\n\u001b[31mcafé\r\nerror: broken\nstatus: Downloading 1/10\nstatus: Done\nerror: failed\nnot JSON\nlast partial",
  );
});

test("unparseable build bytes pass through verbatim, including non-UTF-8", async () => {
  const chunks: Uint8Array[] = [];
  const decoder = buildLogDecoder(async (c) => {
    chunks.push(c);
  });
  await decoder.write(new Uint8Array([255, 13, 10]));
  await decoder.flush();
  expect([...Buffer.concat(chunks)]).toEqual([255, 13, 10]);
});

test("decoder enforces the 1 MiB line cap across chunk boundaries", async () => {
  const chunks: Uint8Array[] = [];
  const decoder = buildLogDecoder(async (c) => {
    chunks.push(c);
  });
  await decoder.write(new Uint8Array(1024 * 1024).fill(65));
  await expect(decoder.write(new Uint8Array([65, 10]))).rejects.toThrow(
    "line too large",
  );
  await decoder.flush();
  expect(chunks).toEqual([]);
});
