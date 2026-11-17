import crypto from "node:crypto";

/** Session token derived from the password: the cookie never contains the password itself. */
export const authToken = (password: string) => crypto.createHmac("sha256", password).update("openmax-session-v1").digest("hex");

const safeEq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return undefined;
}

/** True when the request carries the right Bearer password or a valid session cookie. */
export function isAuthorized(password: string, headers: { authorization?: string; cookie?: string }): boolean {
  if (!password) return true;
  if (headers.authorization && safeEq(headers.authorization, `Bearer ${password}`)) return true;
  const c = cookieValue(headers.cookie, "om_auth");
  return !!c && safeEq(c, authToken(password));
}
export const checkPassword = (password: string, given: string) => !!password && safeEq(given, password);
export const sessionCookie = (password: string) => `om_auth=${authToken(password)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}`;
export const PUBLIC_API = new Set(["/api/health", "/api/login", "/api/auth/status"]);
