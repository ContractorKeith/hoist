import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DashboardStore } from "../store/dashboard";

export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const randomToken = () => randomBytes(32).toString("hex");
export const csrfToken = (token: string) => hashToken(`csrf:${token}`);
export function validCSRF(token: string, input: unknown): boolean {
  const expected = csrfToken(token);
  return (
    typeof input === "string" &&
    /^[a-f0-9]{64}$/.test(input) &&
    timingSafeEqual(Buffer.from(input), Buffer.from(expected))
  );
}
export const hashPassword = (password: string) =>
  Bun.password.hash(password, { algorithm: "argon2id" });
export const verifyPassword = (password: string, hash: string) =>
  Bun.password.verify(password, hash);
export const cookie = (name: string, token: string, age: number) =>
  `${name}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;
export function readCookie(request: Request, name = "hoist_session"): string {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim().split("="));
  const token = values.find(([key]) => key === name)?.[1] ?? "";
  return /^[a-f0-9]{64}$/.test(token) ? token : "";
}
export function createSession(store: DashboardStore, now = Date.now()) {
  const token = randomToken();
  const expires = new Date(now + 7 * 86400000).toISOString();
  store.createSession(hashToken(token), expires);
  return token;
}
export function session(
  store: DashboardStore,
  request: Request,
  now = Date.now(),
) {
  const token = readCookie(request);
  return token && store.session(hashToken(token), new Date(now).toISOString())
    ? token
    : null;
}

export class LoginLimit {
  private failures = new Map<string, { count: number; until: number }>();
  blocked(ip: string, now = Date.now()): boolean {
    return (
      (this.failures.get(ip)?.until ?? 0) > now &&
      (this.failures.get(ip)?.count ?? 0) >= 5
    );
  }
  fail(ip: string, now = Date.now()): void {
    for (const [key, value] of this.failures)
      if (value.until <= now) this.failures.delete(key);
    const value = this.failures.get(ip) ?? {
      count: 0,
      until: now + 15 * 60000,
    };
    value.count++;
    this.failures.set(ip, value);
  }
  clear(ip: string): void {
    this.failures.delete(ip);
  }
}
