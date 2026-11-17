import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizedEnv } from "./exec.js";

const pexec = promisify(execFile);
export async function git(cwd: string, args: string[], o: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const r = await pexec("git", ["-c", "user.name=OpenMax", "-c", "user.email=openmax@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: sanitizedEnv(), timeout: o.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024 });
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e: any) {
    if (o.allowFail) return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, code: typeof e.code === "number" ? e.code : 1 };
    const msg = String(e.stderr || e.message).trim().split("\n").slice(-3).join(" ");
    throw new Error(`git ${args[0]} failed: ${msg}`);
  }
}
/** Only plain https/ssh remotes. Rejects ext::, file://, and option-looking strings. */
export function validateRemote(u: string): boolean { return /^(https:\/\/[\w.-]+(:\d+)?\/[\w./~%+-]+|git@[\w.-]+:[\w./~+-]+|ssh:\/\/[\w.@-]+(:\d+)?\/[\w./~+-]+)$/.test(u) && !u.startsWith("-"); }
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "task";
