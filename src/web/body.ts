export const maxBodyBytes = 16384;
export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds 16384 bytes");
  }
}

// Read at most the limit before invoking form parsers, including for chunked requests.
export async function boundedRequest(request: Request): Promise<Request> {
  if (!request.body) return request;
  if (Number(request.headers.get("content-length")) > maxBodyBytes) {
    void request.body.cancel().catch(() => {});
    throw new BodyTooLargeError();
  }
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBodyBytes) throw new BodyTooLargeError();
      if (value.length) chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    body: Buffer.concat(chunks),
  });
}
