import { spawn } from "node:child_process";

export interface CmdResult { code: number | null; output: string; timedOut: boolean; aborted: boolean; ms: number }
const SECRET = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;
/** Environment for untrusted repo commands: inherit PATH/HOME-ish basics but strip anything that looks like a secret. */
export function sanitizedEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET.test(k) && !/^(SMTP_|OPENMAX_|MEMORYOS_|ANTHROPIC|OPENAI|NVIDIA|GEMINI|GROQ|OPENROUTER|XAI|DEEPSEEK|META_|FAL_)/i.test(k)) out[k] = v;
  return { ...out, CI: "1", GIT_TERMINAL_PROMPT: "0", ...extra };
}

/** Run a shell command with a hard timeout; kills the whole process group on timeout/abort. */
export function runCommand(cmd: string, o: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; maxOutput?: number }): Promise<CmdResult> {
  return new Promise((resolve) => {
    const t0 = Date.now(); const max = o.maxOutput ?? 200_000;
    const child = spawn("/bin/sh", ["-c", cmd], { cwd: o.cwd, env: o.env ?? sanitizedEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", timedOut = false, aborted = false, done = false;
    const add = (d: Buffer) => { out += d.toString("utf8"); if (out.length > max * 2) out = out.slice(-max); };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    const onAbort = () => { aborted = true; kill(); };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null) => { if (done) return; done = true; clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort); resolve({ code, output: out.length > max ? "…" + out.slice(-max) : out, timedOut, aborted, ms: Date.now() - t0 }); };
    child.on("error", (e) => { out += `\n${e.message}`; finish(null); });
    child.on("close", (code) => finish(code));
    if (o.signal?.aborted) onAbort();
  });
}
