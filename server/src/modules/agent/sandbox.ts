import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { cfg, dataPath, ROOT } from "../../config.js";
import { runCommand, sanitizedEnv, type CmdResult } from "../codeagent/exec.js";

/**
 * Contained code execution for the agent.
 *
 * macOS: `sandbox-exec` with a generated profile that (1) denies ALL file writes except the run's workspace and its private tmp/home,
 * (2) denies the network unless the call asked for it (that needs a human approval), and (3) denies reads of credential stores and of
 * OpenMax's own .env / database / browser profile. On platforms without a working sandbox, commands are NOT contained and the executor
 * requires approval for every command instead (see gates.ts).
 */
let available: boolean | undefined;
export function sandboxAvailable(): boolean {
  if (available !== undefined) return available;
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) return (available = false);
  try {
    const p = path.join(os.tmpdir(), `om-sbtest-${process.pid}.sb`);
    fs.writeFileSync(p, "(version 1)\n(allow default)\n(deny network*)\n");
    execFileSync("/usr/bin/sandbox-exec", ["-f", p, "/usr/bin/true"], { stdio: "ignore", timeout: 5000 });
    fs.rmSync(p, { force: true }); available = true;
  } catch { available = false; }
  return available;
}
export const resetSandboxCache = () => { available = undefined; };

const sbEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Seatbelt profile text for a workspace. Exported for tests. */
export function buildProfile(workspace: string, opts: { network: boolean; extraWritable?: string[] }): string {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const home = os.homedir();
  const writable = [real(workspace), ...(opts.extraWritable ?? []).map(real)];
  const secrets = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "Library/Keychains", "Library/Cookies", "Library/Messages", "Library/Mail", "Library/Safari"].map((p) => path.join(home, p));
  const own = [path.join(ROOT, ".env"), path.join(cfg.DATA_DIR, "openmax.db"), path.join(cfg.DATA_DIR, "openmax.db-wal"), path.join(cfg.DATA_DIR, "openmax.db-shm"), dataPath("browser-profile")].map(real);
  const lines = [
    "(version 1)", "(allow default)",
    ...(opts.network ? [] : ["(deny network*)"]),
    "(deny file-write*)",
    `(allow file-write* ${["/dev/null", "/dev/zero", "/dev/dtracehelper"].map((p) => `(literal "${p}")`).join(" ")} (regex #"^/dev/(tty|ttys[0-9]+|fd/[0-9]+)$") ${writable.map((p) => `(subpath "${sbEsc(p)}")`).join(" ")})`,
    ...[...secrets, ...own].map((p) => `(deny file-read* (subpath "${sbEsc(p)}"))`),
    '(deny file-read* (regex #"/\\.env$" #"/\\.env\\.[^/]*$"))', // .env and .env.* anywhere (single backslash reaches the regex engine)
  ];
  return lines.join("\n") + "\n";
}

export interface SandboxResult extends CmdResult { contained: boolean }
export async function runSandboxed(command: string, o: { workspace: string; timeoutMs?: number; network?: boolean; signal?: AbortSignal; maxOutput?: number }): Promise<SandboxResult> {
  fs.mkdirSync(o.workspace, { recursive: true });
  const ws = fs.realpathSync(o.workspace);
  const tmp = path.join(ws, ".tmp"), home = path.join(ws, ".home");
  fs.mkdirSync(tmp, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  // Secrets are stripped from the environment (see sanitizedEnv); HOME/TMPDIR point inside the workspace.
  const env = sanitizedEnv({ HOME: home, TMPDIR: tmp, PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", NO_COLOR: "1", npm_config_cache: path.join(home, ".npm"), PIP_CACHE_DIR: path.join(home, ".pip") });
  const timeoutMs = Math.min(Math.max(o.timeoutMs ?? 60_000, 1000), 600_000);
  if (!sandboxAvailable()) {
    const r = await runCommand(command, { cwd: ws, timeoutMs, signal: o.signal, env, maxOutput: o.maxOutput ?? 60_000 });
    return { ...r, contained: false };
  }
  const profile = path.join(tmp, `profile-${process.pid}-${Date.now()}.sb`);
  fs.writeFileSync(profile, buildProfile(ws, { network: !!o.network }));
  try {
    const r = await runCommand(`/usr/bin/sandbox-exec -f ${shq(profile)} /bin/sh -c ${shq(command)}`, { cwd: ws, timeoutMs, signal: o.signal, env, maxOutput: o.maxOutput ?? 60_000 });
    return { ...r, contained: true };
  } finally { fs.rmSync(profile, { force: true }); }
}
