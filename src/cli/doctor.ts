import { dataRoot } from "../data";
import { SqliteStore } from "../store/sqlite";
import { type Check, doctorChecks, ServiceUnavailable } from "./doctor-checks";

export { doctorChecks } from "./doctor-checks";

export interface DoctorResult {
  check: string;
  status: "ok" | "warning" | "error";
  message: string;
}
export async function runChecks(
  checks: Record<string, Check>,
  noService = false,
): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  let databaseFailed = false;
  const needsStore = new Set([
    "Secret key",
    "Serve lease",
    "Orphan containers",
    "Orphan images",
    "Orphan routes",
    "Dashboard password",
  ]);
  for (const [check, run] of Object.entries(checks)) {
    if (databaseFailed && needsStore.has(check)) {
      results.push({
        check,
        status: "warning",
        message: "Skipped until the database check passes.",
      });
      continue;
    }
    let status: DoctorResult["status"] = "ok",
      message = `${check} is ready.`;
    try {
      const detail = await run();
      if (typeof detail === "string" && detail) message = detail;
    } catch (error) {
      const service =
        ["Serve lease", "Caddy admin"].includes(check) ||
        error instanceof ServiceUnavailable;
      status = noService && service ? "warning" : "error";
      message = String(error instanceof Error ? error.message : error).replace(
        /\s+/g,
        " ",
      );
      if (error && typeof error === "object" && "code" in error)
        message += ` Fix ${check.toLowerCase()} and rerun doctor.`;
    }
    if (check === "Database" && status === "error") databaseFailed = true;
    results.push({ check, status, message });
  }
  return results;
}

export async function doctor(
  args: string[],
  createChecks = doctorChecks,
): Promise<number> {
  if (args.length > 2 || args.slice(1).some((arg) => arg !== "--json"))
    throw new Error("Usage: hoist doctor [--json]");
  let store: SqliteStore | undefined;
  const root = process.env.HOIST_DIR ?? "/var/lib/hoist";
  let results: DoctorResult[];
  try {
    const checks = createChecks(
      root,
      () => (store ??= new SqliteStore(dataRoot())),
    );
    results = await runChecks(
      checks,
      process.env.HOIST_DOCTOR_NO_SERVICE === "1",
    );
  } finally {
    store?.close();
  }
  console.log(
    args.includes("--json")
      ? JSON.stringify(results)
      : results.map((r) => `${r.status} ${r.check}: ${r.message}`).join("\n"),
  );
  return results.some((r) => r.status === "error") ? 1 : 0;
}
