import { getDb, now } from "../db.js";
import { cfg } from "../config.js";
import { extractJSON } from "../providers/llm.js";
import { cooldownRemaining } from "../providers/limits.js";
import { getProvider, providerEnabled, refAllowed } from "../providers/registry.js";
import { splitRef, type Message } from "../providers/types.js";
import { classify, routedComplete, type RouteEvent, type RouteInfo, type RouteOptions } from "../router/router.js";
import { getRouterConfig } from "../router/config.js";
import { isLocalOnly } from "../router/privacy.js";
import { completeWithRefs } from "../router/refs.js";
import { paidAllowed } from "../router/usage.js";
import { getRefStatuses } from "../providers/discovery.js";

export interface ThinkCandidate { ref: string; text: string; error?: string; ms: number; temperature?: number }
export interface ThinkData { candidates: ThinkCandidate[]; judge?: { ref: string; verdict: string; action: "pick" | "merge" | "fallback" }; chosen: string; estimateSec?: number; phase: "drafting" | "judging" | "done" }

const letters = "ABCDEFGH";
/** Which refs draft the answer: nvidia + google + openrouter (+ groq for short tasks, + paid flagships when allowed). Private content only uses local models. */
export function thinkCandidates(o: { short?: boolean; localOnly?: boolean; paid?: boolean }): string[] {
  const rc = getRouterConfig(); const statuses = (() => { try { return getRefStatuses(); } catch { return {}; } })();
  let refs = [...rc.think.candidates, ...(o.short ? rc.think.shortExtra : []), ...(o.paid ? rc.think.paidExtra : [])];
  if (o.localOnly) refs = [...(rc.localDefault ? [rc.localDefault] : []), ...Object.keys(statuses).filter((r) => splitRef(r).provider === "ollama")];
  const ok: string[] = [];
  for (const r of [...new Set(refs)]) {
    const p = getProvider(splitRef(r).provider);
    if (!p || !providerEnabled(p) || !refAllowed(p.id, splitRef(r).model) || cooldownRemaining(p.id) > 0 || statuses[r]?.ok === false) continue;
    ok.push(r);
  }
  return ok;
}

export function judgePrompt(question: string, drafts: { label: string; text: string }[]): Message[] {
  return [
    { role: "system", content: `You are an impartial judge combining several draft answers to one question. Check each draft for correctness, completeness and clarity; note disagreements and decide who is right. Then EITHER pick the single best draft OR write a merged answer that keeps the best parts of each and fixes errors. Reply with ONLY JSON: {"verdict":"2-3 sentences on how the drafts compare","action":"pick"|"merge","pick":"A","merged":"the full merged answer (only when action is merge)"}.` },
    { role: "user", content: `QUESTION:\n${question}\n\n${drafts.map((d) => `DRAFT ${d.label}:\n${d.text}`).join("\n\n---\n\n")}` },
  ];
}
export function parseVerdict(raw: string, n: number): { action: "pick" | "merge"; pick: number; merged?: string; verdict: string } | undefined {
  const j = extractJSON<any>(raw); if (!j || typeof j !== "object") return undefined;
  const verdict = String(j.verdict ?? "").slice(0, 600);
  if (j.action === "merge" && typeof j.merged === "string" && j.merged.trim().length > 10) return { action: "merge", pick: 0, merged: j.merged.trim(), verdict };
  const pickRaw = String(j.pick ?? "").trim().toUpperCase().slice(0, 1);
  const idx = pickRaw ? letters.indexOf(pickRaw) : -1;
  if (idx >= 0 && idx < n) return { action: "pick", pick: idx, verdict };
  return undefined;
}

export function estimateThink(o: { candidates: string[]; judge?: string }): { seconds: number; drafts: number } {
  const avg = (ref: string) => { const { provider, model } = splitRef(ref); const r = getDb().prepare("SELECT AVG(ms) m FROM usage WHERE provider=? AND model=? AND status=200 AND ms>0 AND kind IN ('chat','think')").get(provider, model) as { m: number | null }; return r.m ?? (provider === "ollama" ? 25000 : 12000); };
  const draft = Math.max(0, ...o.candidates.map(avg)); const judge = o.judge ? Math.min(avg(o.judge), 30000) : 8000;
  return { seconds: Math.round(((draft + judge) / 1000) * 1.15), drafts: o.candidates.length };
}

export async function* runThink(opts: RouteOptions): AsyncGenerator<RouteEvent & { type: string }> {
  const t0 = Date.now();
  const question = [...opts.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const hasAtt = (opts.attachmentKinds?.length ?? 0) > 0 || (opts.attachments?.length ?? 0) > 0;
  const localOnly = isLocalOnly({ private: opts.private, hasAttachments: hasAtt, allowCloud: opts.allowCloud });
  const cls = opts.pre ?? (await classify({ messages: opts.messages, attachmentKinds: opts.attachmentKinds, private: opts.private, allowCloud: opts.allowCloud, signal: opts.signal }));
  const short = question.length < 600 && cls.task !== "code";
  let refs = thinkCandidates({ short, localOnly, paid: paidAllowed() });
  if (!refs.length && !localOnly) refs = thinkCandidates({ short, localOnly: true, paid: false }); // no cloud provider is available: draft with the local model instead
  const temps: (number | undefined)[] = refs.map(() => undefined);
  if (refs.length === 1) { refs = [refs[0]!, refs[0]!]; temps.splice(0, 2, 0.3, 0.9); } // one model available: sample it twice
  if (!refs.length) { yield* (await import("../router/router.js")).runRouted({ ...opts, pre: cls }) as AsyncGenerator<RouteEvent & { type: string }>; return; }
  const est = estimateThink({ candidates: refs, judge: getRouterConfig().judge[0] });
  const data: ThinkData = { candidates: refs.map((ref, i) => ({ ref, text: "", ms: 0, temperature: temps[i] })), chosen: "", phase: "drafting", estimateSec: est.seconds };
  yield { type: "think", data: structuredClone(data) } as any;

  const timeout = AbortSignal.timeout(120_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  await Promise.all(refs.map(async (ref, i) => {
    const s = Date.now();
    try {
      const r = await routedComplete({ ...opts, pre: cls, forceRef: ref, temperature: temps[i] ?? opts.temperature, signal, log: false, purpose: "think", tools: undefined });
      data.candidates[i]!.text = r.text; data.candidates[i]!.ms = Date.now() - s;
      if (!r.text.trim()) data.candidates[i]!.error = "empty answer";
    } catch (e: any) { if (opts.signal?.aborted) throw e; data.candidates[i]!.error = String(e.message).slice(0, 200); data.candidates[i]!.ms = Date.now() - s; }
  }));
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const good = data.candidates.filter((c) => c.text.trim() && !c.error);
  if (!good.length) throw Object.assign(new Error(`Every Think draft failed: ${data.candidates.map((c) => `${c.ref}: ${c.error}`).join(" | ")}`), { status: 502, fix: "Try again, or turn Think off to use normal routing." });

  let finalText = good[0]!.text; let chosen = good[0]!.ref;
  if (good.length > 1) {
    data.phase = "judging"; yield { type: "think", data: structuredClone(data) } as any;
    try {
      const j = await completeWithRefs(getRouterConfig().judge, { messages: judgePrompt(question, good.map((c, i) => ({ label: letters[i]!, text: c.text.slice(0, 6000) }))), temperature: 0, maxTokens: 4000, json: true, signal }, { localOnly, purpose: "think-judge" });
      const v = parseVerdict(j.text, good.length);
      if (v) { data.judge = { ref: j.ref, verdict: v.verdict, action: v.action }; if (v.action === "merge") { finalText = v.merged!; chosen = "merged"; } else { finalText = good[v.pick]!.text; chosen = good[v.pick]!.ref; } }
      else data.judge = { ref: j.ref, verdict: "The judge's reply could not be parsed; using the first successful draft.", action: "fallback" };
    } catch (e: any) { if (opts.signal?.aborted) throw e; data.judge = { ref: "none", verdict: `Judge unavailable (${String(e.message).slice(0, 120)}); using the first successful draft.`, action: "fallback" }; }
  } else data.judge = { ref: "none", verdict: "Only one draft succeeded, so no judging was needed.", action: "fallback" };

  data.chosen = chosen; data.phase = "done";
  const failed = data.candidates.filter((c) => c.error).map((c) => ({ ref: c.ref, error: c.error! }));
  const info: RouteInfo & { think?: ThinkData } = { task: cls.task, model: `think:${chosen}`, reason: `think · ${good.length}/${refs.length} drafts → ${data.judge?.action === "merge" ? "merged by " : data.judge?.action === "pick" ? "picked by " : ""}${data.judge?.ref ?? "—"}`, confidence: cls.confidence, source: cls.source === "classifier" ? "classifier" : "heuristic", fallbacksTried: failed, mode: opts.mode ?? "auto", localOnly, needsSearch: cls.task === "realtime", think: data };
  yield { type: "route", info } as any;
  yield { type: "think", data } as any;
  for (let i = 0; i < finalText.length; i += 60) yield { type: "text", text: finalText.slice(i, i + 60) };
  const ms = Date.now() - t0; const tokensOut = Math.ceil(finalText.length / 4);
  const r = getDb().prepare("INSERT INTO route_log(ts,task,model,provider,mode,confidence,source,latency_ms,tokens_in,tokens_out,tps,error,fallbacks) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(now(), cls.task, info.model, "think", info.mode, cls.confidence, "think", ms, Math.ceil(question.length / 4), tokensOut, Math.round((tokensOut / Math.max(ms / 1000, 0.1)) * 10) / 10, null, JSON.stringify(failed));
  yield { type: "meta", meta: { logId: Number(r.lastInsertRowid), latencyMs: ms, tokensIn: Math.ceil(question.length / 4), tokensOut, tps: 0 } } as any;
  void cfg;
}
