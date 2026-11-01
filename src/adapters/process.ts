export interface ChildProcess {
  exitCode: number | null;
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}
export async function stopChild(
  child: ChildProcess,
  graceMs = 5000,
): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    }),
  ]);
  clearTimeout(timer);
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
  await child.exited;
}
