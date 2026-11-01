// An open stderr pipe must not hide a teardown failure from a surviving child.
export async function caddyLogs(
  child: { exitCode: number | null } | undefined,
  logsPromise: Promise<string> | undefined,
  timeoutMs = 2000,
): Promise<string> {
  if (!logsPromise) return "";
  if (child?.exitCode !== null) return await logsPromise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      logsPromise,
      new Promise<string>((resolve) => {
        timer = setTimeout(
          () => resolve("Caddy still running; stderr unavailable"),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
