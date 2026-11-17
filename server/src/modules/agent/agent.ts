import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { cfg, dataPath } from "../../config.js";
import { getDb, now, uid } from "../../db.js";
import { extractJSON } from "../../providers/llm.js";
import { ProviderError, type Message, type ToolCall } from "../../providers/types.js";
import { routedComplete } from "../../router/router.js";
import { redactCards } from "../../util/redact.js";
import { addInbox } from "../inbox.js";
import { cancelRunApprovals, setDeferredExecutor } from "./approvals.js";
import { PlaywrightDriver, type BrowserDriver } from "./browser.js";
import { executeTool, redactArgs, runDeferred, toolDefs, type ToolContext, type ToolOutcome } from "./tools.js";

export const MAX_STEPS = 25;
export const sandboxDir = () => { fs.mkdirSync(cfg.AGENT_SANDBOX, { recursive: true }); return fs.realpathSync(cfg.AGENT_SANDBOX); };
setDeferredExecutor((a) => runDeferred(a, sandboxDir()));

export type BrowserFactory = () => BrowserDriver;
let browserFactory: BrowserFactory = () => new PlaywrightDriver();
export const setBrowserFactory = (f: BrowserFactory | undefined) => { browserFactory = f ?? (() => new PlaywrightDriver()); };
let browserOwner: string | undefined;

export interface RunEvent { type: "thought" | "step" | "approval" | "status" | "done" | "error"; data: any }
interface Handle { id: string; abort: AbortController; emitter: EventEmitter; finished: Promise<void> }
const handles = new Map<string, Handle>();

const SYSTEM = (json: boolean) => `You are OpenMax Agent, an autonomous assistant that completes the user's goal by calling tools, one at a time.
Rules:
- Work step by step; after each tool result decide the next action. Be efficient: you have at most ${MAX_STEPS} steps.
- Some actions (sending email, deleting files, buying, submitting forms, typing personal data) pause for the user's approval. Never try to get around this. If an action is rejected or blocked, do NOT retry it; pick another approach or finish and explain.
- Never enter passwords, payment card numbers or ID numbers. Never invent facts; read pages with the browser or fetch_page.
- Prefer fetch_page / web_search for reading; use the browser only for pages that need interaction.
- When done (or if the goal cannot be completed), call the finish tool with a clear summary for the user.
Today is ${new Date().toDateString()}.${json ? `

TOOL PROTOCOL: reply with ONLY one JSON object per turn: {"thought":"brief reasoning","tool":"<tool name>","args":{...}}.
Tools:
${toolDefs().map((t) => `- ${t.name}: ${t.description} args schema: ${JSON.stringify(t.parameters)}`).join("\n")}` : ""}`;

export function parseAction(text: string): { thought?: string; name: string; args: Record<string, unknown> } | undefined {
  const j = extractJSON<any>(text); if (!j || typeof j !== "object") return undefined;
  const name = j.tool ?? j.name ?? j.action ?? j.function?.name; if (typeof name !== "string") return undefined;
  const args = j.args ?? j.arguments ?? j.parameters ?? j.input ?? j.function?.arguments ?? {};
  return { thought: typeof j.thought === "string" ? j.thought : undefined, name, args: typeof args === "string" ? (extractJSON<any>(args) ?? {}) : args };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export function getRun(id: string) { return getDb().prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as any; }
export const listRuns = () => getDb().prepare("SELECT id,goal,status,result,schedule_id,created_at,finished_at,unattended FROM agent_runs ORDER BY created_at DESC LIMIT 100").all();
export const runSteps = (id: string) => (getDb().prepare("SELECT * FROM agent_steps WHERE run_id=? ORDER BY n, id").all(id) as any[]).map((s) => ({ ...s, args: JSON.parse(s.args ?? "{}") }));
export const runApprovals = (id: string) => (getDb().prepare("SELECT * FROM approvals WHERE run_id=? ORDER BY created_at").all(id) as any[]).map((a) => ({ ...a, payload: JSON.parse(a.payload) }));
export const shotPath = (runId: string, file: string) => { if (!/^[\w-]+$/.test(runId) || file !== path.basename(file)) return undefined; const p = path.join(dataPath("agent", "runs"), runId, file); return fs.existsSync(p) ? p : undefined; };

export function startRun(o: { goal: string; scheduleId?: string; unattended?: boolean; maxSteps?: number }): string {
  const id = uid("ar_");
  getDb().prepare("INSERT INTO agent_runs(id,goal,status,schedule_id,created_at,unattended) VALUES(?,?,'running',?,?,?)").run(id, redactCards(o.goal), o.scheduleId ?? null, now(), o.unattended ? 1 : 0);
  const h: Handle = { id, abort: new AbortController(), emitter: new EventEmitter(), finished: Promise.resolve() };
  h.emitter.setMaxListeners(50);
  handles.set(id, h);
  h.finished = loop(h, o.goal, !!o.unattended, o.maxSteps ?? MAX_STEPS).finally(() => { handles.delete(id); });
  return id;
}
export const runFinished = (id: string) => handles.get(id)?.finished ?? Promise.resolve();
export function stopRun(id: string): boolean { const h = handles.get(id); if (!h) return false; h.abort.abort(); return true; }
export function subscribe(id: string, cb: (e: RunEvent) => void): (() => void) | undefined {
  const h = handles.get(id); if (!h) return undefined;
  const f = (e: RunEvent) => cb(e); h.emitter.on("e", f); return () => h.emitter.off("e", f);
}
export function markInterruptedRuns() {
  getDb().prepare("UPDATE agent_runs SET status='error', result='Interrupted by a server restart.', finished_at=? WHERE status='running'").run(now());
  getDb().prepare("UPDATE approvals SET status='expired', decided_at=? WHERE status='pending' AND json_extract(payload,'$.deferred') IS NOT 1").run(now());
}

async function nextAction(messages: Message[], jsonMode: boolean, signal: AbortSignal): Promise<{ thought?: string; calls: ToolCall[]; text: string; switchedToJson?: boolean }> {
  try {
    const r = await routedComplete({ task: "agentic", messages, tools: jsonMode ? undefined : toolDefs(), signal, purpose: "agent", temperature: 0.2, maxTokens: 2000 });
    if (r.toolCalls.length) return { calls: r.toolCalls, text: r.text, thought: r.text || undefined };
    const a = parseAction(r.text);
    if (a) return { calls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, name: a.name, args: a.args }], text: r.text, thought: a.thought };
    return { calls: [], text: r.text };
  } catch (e: any) {
    if (!jsonMode && e instanceof ProviderError && /tool|function[ -]?call/i.test(e.message)) return { ...(await nextAction(messages, true, signal)), switchedToJson: true };
    throw e;
  }
}

async function loop(h: Handle, goal: string, unattended: boolean, maxSteps: number) {
  const db = getDb(); const { id, abort } = h;
  const emit = (type: RunEvent["type"], data: any) => h.emitter.emit("e", { type, data } satisfies RunEvent);
  const finish = (status: "done" | "error" | "stopped", result: string) => {
    db.prepare("UPDATE agent_runs SET status=?, result=?, finished_at=? WHERE id=?").run(status, redactCards(result).slice(0, 20000), now(), id);
    const run = getRun(id);
    addInbox({ kind: "agent_result", title: `${status === "done" ? "✓" : status === "stopped" ? "■" : "✗"} ${clip(goal, 90)}`, body: redactCards(result), ref: id });
    emit(status === "error" ? "error" : "done", { status, result, run });
  };
  let browser: BrowserDriver | undefined;
  const getBrowser = (): BrowserDriver => {
    if (browser) return browser;
    if (browserOwner && browserOwner !== id) throw Object.assign(new Error("Another agent run is using the browser right now."), { fix: "Wait for it to finish, or stop it." });
    browserOwner = id; browser = browserFactory(); return browser;
  };
  let n = 0;
  const ctx: ToolContext = {
    runId: id, sandbox: sandboxDir(), signal: abort.signal, unattended, browser: getBrowser,
    onApproval: (a) => emit("approval", { ...a, payload: JSON.parse(JSON.stringify(a.payload)) }),
    saveShot: (png) => { const dir = path.join(dataPath("agent", "runs"), id); fs.mkdirSync(dir, { recursive: true }); const f = `step-${n}.png`; fs.writeFileSync(path.join(dir, f), png); return f; },
  };
  let jsonMode = false; let nudged = false; const recent: string[] = [];
  const messages: Message[] = [{ role: "system", content: SYSTEM(false) }, { role: "user", content: goal }];
  try {
    for (n = 1; n <= maxSteps; n++) {
      if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
      emit("status", { text: `Step ${n}: thinking…`, n });
      const act = await nextAction(messages, jsonMode, abort.signal);
      if (act.switchedToJson && !jsonMode) { jsonMode = true; messages[0] = { role: "system", content: SYSTEM(true) }; emit("status", { text: "This model has no native tool calling; using the JSON action protocol.", n }); }
      if (!act.calls.length) {
        if (!nudged) { nudged = true; messages.push({ role: "assistant", content: act.text }, { role: "user", content: jsonMode ? 'Reply with ONLY a JSON action, e.g. {"tool":"finish","args":{"summary":"..."}}.' : "Continue by calling a tool, or call finish with your final summary." }); n--; continue; }
        finish("done", act.text || "The agent stopped without a summary."); return;
      }
      const call = act.calls[0]!;
      if (act.thought) emit("thought", { n, text: clip(act.thought, 600) });
      const sig = `${call.name}:${JSON.stringify(call.args)}`; recent.push(sig);
      const repeated = recent.slice(-3).length === 3 && recent.slice(-3).every((x) => x === sig);
      const t0 = Date.now();
      let out: ToolOutcome;
      try { out = repeated ? { status: "error", message: "You have repeated this exact call 3 times. Try something different or call finish." } : await executeTool(call.name, call.args, ctx); }
      catch (e: any) { if (e?.name === "AbortError") throw e; out = { status: "error", message: e.message }; }
      const safeArgs = redactArgs(call.args as Record<string, any>);
      const stepRow = { n, tool: call.name, args: safeArgs, result: clip(redactCards(out.message), 4000), screenshot: out.screenshot ?? null, status: out.status === "finished" ? "ok" : out.status, ts: now() };
      db.prepare("INSERT INTO agent_steps(run_id,n,tool,args,result,screenshot,status,ts) VALUES(?,?,?,?,?,?,?,?)").run(id, n, stepRow.tool, JSON.stringify(safeArgs), stepRow.result, stepRow.screenshot, stepRow.status, stepRow.ts);
      emit("step", { ...stepRow, ms: Date.now() - t0, approvalId: out.approvalId });
      if (out.status === "finished") { finish("done", out.message); return; }
      const resultText = clip(redactCards(`${out.status === "ok" ? "" : `[${out.status}] `}${out.message}`), 6000);
      if (jsonMode) messages.push({ role: "assistant", content: JSON.stringify({ tool: call.name, args: safeArgs }) }, { role: "user", content: `Tool result:\n${resultText}` });
      else messages.push({ role: "assistant", content: act.text || "", toolCalls: [{ ...call, args: safeArgs }] }, { role: "tool", toolCallId: call.id, name: call.name, content: resultText });
      if (messages.length > 44) messages.splice(2, messages.length - 40);
    }
    finish("stopped", `Stopped after ${maxSteps} steps without finishing. Last results are in the step log.`);
  } catch (e: any) {
    if (e?.name === "AbortError" || abort.signal.aborted) { cancelRunApprovals(id); finish("stopped", "Stopped by the user."); }
    else finish("error", `${e.message}${e.fix ? ` — ${e.fix}` : ""}`);
  } finally {
    if (browser) { await browser.close().catch(() => {}); if (browserOwner === id) browserOwner = undefined; }
  }
}
