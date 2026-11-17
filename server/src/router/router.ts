import { getDb, now } from "../db.js";
import { complete, completeJSON, stream } from "../providers/llm.js";
import { ProviderError, splitRef, type ImagePart, type Message, type StreamEvent, type ToolDef } from "../providers/types.js";
import { cooldownRemaining, tryAcquire } from "../providers/limits.js";
import { classifyHeuristic, estimateTokens, type AttachmentKind } from "./classify.js";
import { TASKS, getRouterConfig, type Task } from "./config.js";
import { selectCandidates } from "./lanes.js";
import { isLocalOnly, privacyReason } from "./privacy.js";
import { recordUsage } from "./usage.js";
import { getProvider, providerEnabled } from "../providers/registry.js";

export interface RouteOptions {
  messages: Message[];
  task?: Task;
  mode?: string;
  private?: boolean;
  allowCloud?: boolean;
  attachments?: ImagePart[];
  attachmentKinds?: AttachmentKind[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  json?: boolean;
  forceRef?: string;
  exclude?: string[];
  purpose?: string;
  messageId?: string;
  log?: boolean;
}
export interface Fallback { ref: string; error: string; status?: number }
export interface RouteInfo {
  task: Task; model: string; reason: string; confidence: number; source: "heuristic" | "classifier" | "forced" | "manual";
  fallbacksTried: Fallback[]; mode: string; localOnly: boolean; needsSearch: boolean; logId?: number;
}
export interface RouteMeta { logId: number; latencyMs: number; tokensIn: number; tokensOut: number; tps: number }
export type RouteEvent = StreamEvent | { type: "route"; info: RouteInfo } | { type: "meta"; meta: RouteMeta };

const lastUserText = (m: Message[]) => [...m].reverse().find((x) => x.role === "user")?.content ?? "";

const CLASSIFIER_SYSTEM = `You route a user request to the best model lane. Tasks: ${TASKS.join(", ")}.
- code: programming. reasoning: math/logic/analysis. research: needs sources/comparison. realtime: needs current facts.
- creative: writing/ideas. vision: about an image. multimodal: audio/pdf/video. long-context: very long input.
- agentic: do something in the world (email, schedule, browse, buy). quick: trivial or short.
Reply with ONLY JSON {"task":"<one of the tasks>","reason":"<short>"}.`;

export async function classify(opts: Pick<RouteOptions, "messages" | "attachmentKinds" | "private" | "allowCloud" | "signal">) {
  const text = lastUserText(opts.messages);
  const tokens = estimateTokens(opts.messages.map((m) => m.content).join("\n"));
  const h = classifyHeuristic({ text, attachments: opts.attachmentKinds, tokenEstimate: tokens });
  if (h.confidence >= 0.6) return { task: h.task, confidence: h.confidence, source: "heuristic" as const, reason: h.signals.slice(0, 3).join(", ") || "heuristic" };
  const localOnly = isLocalOnly({ private: opts.private, allowCloud: opts.allowCloud, hasAttachments: (opts.attachmentKinds ?? []).length > 0 });
  const refs = getRouterConfig().classifier.filter((r) => {
    const p = getProvider(splitRef(r).provider);
    return p && providerEnabled(p) && (!localOnly || p.local) && cooldownRemaining(p.id) === 0;
  });
  for (const ref of refs) {
    try {
      const { value } = await completeJSON<{ task?: string; reason?: string }>({
        model: ref, temperature: 0, maxTokens: 120, signal: opts.signal,
        messages: [{ role: "system", content: CLASSIFIER_SYSTEM }, { role: "user", content: text.slice(0, 1500) }],
      });
      if (value.task && (TASKS as readonly string[]).includes(value.task))
        return { task: value.task as Task, confidence: 0.7, source: "classifier" as const, reason: `classifier ${ref}: ${value.reason ?? ""}`.trim() };
    } catch (e: any) { if (e?.name === "AbortError") throw e; }
  }
  return { task: h.task, confidence: h.confidence, source: "heuristic" as const, reason: `low confidence ${h.confidence}; classifier unavailable` };
}

export function noCandidatesError(task: Task, skipped: { ref: string; reason: string }[], localOnly: boolean): ProviderError {
  const why = skipped.slice(0, 4).map((s) => `${s.ref} (${s.reason})`).join(", ");
  const fix = localOnly
    ? "This content is private/attachment-based, so only local models are allowed. Run `ollama serve` and `ollama pull` a model (see Settings → hardware), or allow cloud for this message."
    : "Add an API key in Settings or start Ollama (`ollama serve`). Open /router to see which models are skipped and why.";
  return new ProviderError(`No model is available for "${task}" right now${why ? `: ${why}` : ""}.`, "router", 503, undefined, fix);
}

export async function* runRouted(opts: RouteOptions): AsyncGenerator<RouteEvent> {
  const t0 = Date.now();
  const mode = opts.mode || "auto";
  const hasAtt = (opts.attachmentKinds?.length ?? 0) > 0 || (opts.attachments?.length ?? 0) > 0;
  const localOnly = isLocalOnly({ private: opts.private, allowCloud: opts.allowCloud, hasAttachments: hasAtt });

  let cls: { task: Task; confidence: number; source: RouteInfo["source"]; reason: string };
  if (opts.task) cls = { task: opts.task, confidence: 1, source: "forced", reason: `task ${opts.task}${opts.purpose ? ` (${opts.purpose})` : ""}` };
  else cls = await classify({ ...opts, attachmentKinds: opts.attachmentKinds ?? (opts.attachments?.length ? ["image"] : []) });
  if (mode.startsWith("manual:")) cls = { ...cls, source: "manual" };

  const sel = selectCandidates({ task: cls.task, mode, localOnly, exclude: opts.exclude, forceRef: opts.forceRef, preferTools: !!opts.tools?.length || cls.task === "agentic" });
  const fallbacks: Fallback[] = sel.skipped.filter((s) => s.reason.startsWith("privacy")).length ? [] : [];
  const tried: Fallback[] = [...fallbacks];
  if (!sel.candidates.length) throw noCandidatesError(cls.task, sel.skipped, localOnly);

  let lastErr: unknown;
  for (const cand of sel.candidates) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const cd = cooldownRemaining(cand.provider);
    if (cd > 0) { tried.push({ ref: cand.ref, error: `${cand.provider} cooling down ${cd}s`, status: 429 }); continue; }
    if (cand.tier !== "local" && !tryAcquire(cand.provider)) { tried.push({ ref: cand.ref, error: `${cand.provider} rate window full` }); continue; }

    const ts = Date.now();
    let started = false, firstTokenAt = 0, tin = 0, tout = 0, textLen = 0, calls = 0;
    try {
      for await (const ev of stream({
        model: cand.ref, messages: opts.messages, temperature: opts.temperature, maxTokens: opts.maxTokens,
        tools: opts.tools, attachments: opts.attachments, signal: opts.signal, json: opts.json,
      })) {
        if (ev.type === "usage") { tin = ev.tokensIn; tout = ev.tokensOut; continue; }
        if (ev.type === "done") break;
        if (!started) {
          started = true; firstTokenAt = Date.now();
          const why = [`${cls.source} ${cls.confidence}`, cls.reason, privacyReason({ private: opts.private, hasAttachments: hasAtt, allowCloud: opts.allowCloud })].filter(Boolean).join(" · ");
          yield { type: "route", info: { task: cls.task, model: cand.ref, reason: why, confidence: cls.confidence, source: cls.source, fallbacksTried: tried, mode, localOnly, needsSearch: cls.task === "realtime" } };
        }
        if (ev.type === "text") textLen += ev.text.length;
        if (ev.type === "tool_call") calls++;
        yield ev;
      }
      if (!started || (textLen === 0 && calls === 0)) {
        if (!started) { tried.push({ ref: cand.ref, error: "empty response" }); continue; }
      }
      const ms = Date.now() - t0;
      if (!tout) tout = Math.ceil(textLen / 4);
      if (!tin) tin = Math.ceil(opts.messages.reduce((n, m) => n + m.content.length, 0) / 4);
      const genSec = Math.max((Date.now() - firstTokenAt) / 1000, 0.05);
      const tps = Math.round((tout / genSec) * 10) / 10;
      recordUsage({ ref: cand.ref, tokensIn: tin, tokensOut: tout, ms: Date.now() - ts, kind: opts.purpose ?? "chat" });
      let logId = 0;
      if (opts.log !== false) logId = logDecision({ cls, ref: cand.ref, mode, ms, tin, tout, tps, fallbacks: tried, messageId: opts.messageId });
      yield { type: "meta", meta: { logId, latencyMs: ms, tokensIn: tin, tokensOut: tout, tps } };
      return;
    } catch (e: any) {
      if (e?.name === "AbortError" || opts.signal?.aborted) throw e;
      lastErr = e;
      const status = e instanceof ProviderError ? e.status : undefined;
      if (status === 429) recordUsage({ ref: cand.ref, tokensIn: 0, tokensOut: 0, ms: Date.now() - ts, status: 429, kind: "429" });
      if (started) {
        // failed mid-stream: cannot fall through without duplicating output
        if (opts.log !== false) logDecision({ cls, ref: cand.ref, mode, ms: Date.now() - t0, tin, tout, tps: 0, fallbacks: tried, error: e.message, messageId: opts.messageId });
        throw e;
      }
      tried.push({ ref: cand.ref, error: e.message, status });
    }
  }
  const msg = tried.length ? tried.map((t) => `${t.ref}: ${t.error}`).join(" | ") : "no candidate could run";
  if (opts.log !== false) logDecision({ cls, ref: "", mode, ms: Date.now() - t0, tin: 0, tout: 0, tps: 0, fallbacks: tried, error: msg, messageId: opts.messageId });
  const allCool = tried.length > 0 && tried.every((t) => t.status === 429 || /cooling|window/.test(t.error));
  throw new ProviderError(allCool ? `Every provider for "${cls.task}" is rate limited. ${msg}` : `All models failed for "${cls.task}". ${msg}`, "router", allCool ? 429 : 502, undefined,
    allCool ? "Wait for the cooldown shown in the header, or add another provider key." : (lastErr instanceof ProviderError ? lastErr.fix : "Open /router → Test providers to find dead models."));
}

function logDecision(d: { cls: { task: Task; confidence: number; source: string }; ref: string; mode: string; ms: number; tin: number; tout: number; tps: number; fallbacks: Fallback[]; error?: string; messageId?: string }): number {
  const { provider } = d.ref ? splitRef(d.ref) : { provider: "" };
  const r = getDb().prepare("INSERT INTO route_log(ts,task,model,provider,mode,confidence,source,latency_ms,tokens_in,tokens_out,tps,error,fallbacks,message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(now(), d.cls.task, d.ref, provider, d.mode, d.cls.confidence, d.cls.source, d.ms, d.tin, d.tout, d.tps, d.error ?? null, JSON.stringify(d.fallbacks), d.messageId ?? null);
  return Number(r.lastInsertRowid);
}

export interface RoutedResult { text: string; reasoning: string; toolCalls: import("../providers/types.js").ToolCall[]; info?: RouteInfo; meta?: RouteMeta }
export async function routedComplete(opts: RouteOptions): Promise<RoutedResult> {
  const out: RoutedResult = { text: "", reasoning: "", toolCalls: [] };
  for await (const ev of runRouted(opts)) {
    if (ev.type === "text") out.text += ev.text;
    else if (ev.type === "reasoning") out.reasoning += ev.text;
    else if (ev.type === "tool_call") out.toolCalls.push(ev.call);
    else if (ev.type === "route") out.info = ev.info;
    else if (ev.type === "meta") out.meta = ev.meta;
  }
  out.text = out.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return out;
}
export async function routedJSON<T = unknown>(opts: RouteOptions): Promise<{ value: T; info?: RouteInfo }> {
  const { extractJSON } = await import("../providers/llm.js");
  const r = await routedComplete({ ...opts, json: true });
  const v = extractJSON<T>(r.text);
  if (v === undefined) throw new ProviderError(`The model did not return valid JSON (${r.text.slice(0, 80)}).`, "router", 502);
  return { value: v, info: r.info };
}
void complete;
