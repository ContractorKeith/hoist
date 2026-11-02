// Docker's build API emits newline-delimited records; cutover and build failures use text.
export function buildLogDecoder(write: (chunk: Uint8Array) => Promise<void>) {
  let pending = Buffer.alloc(0);
  const statuses = new Set<string>();
  const encode = new TextEncoder();
  const line = async (bytes: Uint8Array, newline: boolean) => {
    let record: unknown;
    try {
      record = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      await write(newline ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes);
      return;
    }
    if (!record || typeof record !== "object") {
      await write(newline ? Buffer.concat([bytes, Buffer.from("\n")]) : bytes);
      return;
    }
    const row = record as {
      stream?: unknown;
      errorDetail?: { message?: unknown };
      error?: unknown;
      status?: unknown;
      progress?: unknown;
    };
    const error =
      typeof row.errorDetail?.message === "string"
        ? row.errorDetail.message
        : row.error;
    const status =
      typeof row.status === "string"
        ? row.status
        : typeof row.progress === "string"
          ? row.progress
          : undefined;
    if (typeof row.stream === "string") await write(encode.encode(row.stream));
    else if (typeof error === "string")
      await write(encode.encode(`error: ${error}\n`));
    else if (status !== undefined) {
      if (statuses.has(status)) return;
      statuses.add(status);
      await write(
        encode.encode(
          `status: ${status}${typeof row.status === "string" && typeof row.progress === "string" && row.progress ? ` ${row.progress}` : ""}\n`,
        ),
      );
    }
    // Auxiliary Docker metadata contains no log text.
  };
  return {
    async write(chunk: Uint8Array) {
      pending = Buffer.concat([pending, chunk]);
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        if (i - start > 1024 * 1024) {
          pending = Buffer.alloc(0);
          throw new Error("Docker build log line too large");
        }
        if (pending[i] !== 10) continue;
        await line(pending.subarray(start, i), true);
        start = i + 1;
      }
      pending = Buffer.from(pending.subarray(start));
      if (pending.length > 1024 * 1024) {
        pending = Buffer.alloc(0);
        throw new Error("Docker build log line too large");
      }
    },
    async flush() {
      if (pending.length) await line(pending, false);
      pending = Buffer.alloc(0);
    },
  };
}
