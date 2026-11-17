import { cfg } from "../config.js";
import { getProvider, refAllowed } from "./registry.js";
import { ProviderError, splitRef, type LLMRequest, type StreamEvent, type ToolCall } from "./types.js";
import { buildOpenAIBody, parseOpenAIStream } from "./dialects/openai.js";
import { buildAnthropicBody, parseAnthropicStream } from "./dialects/anthropic.js";
import { buildOllamaBody, parseOllamaStream } from "./dialects/ollama.js";
import { record429, recordHeaders, parseDuration } from "./limits.js";
import { stubRun } from "./stub.js";

export interface LLMResult { text: string; reasoning: string; toolCalls: ToolCall[]; tokensIn: number; tokensOut: number; ms: number; finish?: string }

function friendly(provider: string, status: number, body: string, fix: string): string {
  if (status === 401 || status === 403) return `${provider} rejected the API key. ${fix}`;
  if (status === 404) return `${provider} does not have that model (it may have been renamed). Open /router and run "Test providers", then pick a live model.`;
  if (status === 429) return `${provider} is rate limiting this key; falling back to another provider.`;
  if (status >= 500) return `${provider} had a server error (${status}). Try again shortly.`;
  return `${provider} returned ${status}: ${body.slice(0, 200)}`;
}

export async function* stream(req: LLMRequest): AsyncGenerator<StreamEvent> {
  const { provider, model } = splitRef(req.model);
  const p = getProvider(provider);
  if (!p) throw new ProviderError(`Unknown provider "${provider}" in ${req.model}.`, provider, 0, undefined, "Check data/router.json.");
  if (!refAllowed(provider, model)) throw new ProviderError(`${req.model} is a paid OpenRouter model; set ENABLE_PAID=true to allow it.`, provider, 0);
  if (req.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  if (cfg.OPENMAX_STUB) {
    const r = await stubRun(req, provider, model);
    if (r.text) yield { type: "text", text: r.text };
    for (const c of r.toolCalls ?? []) yield { type: "tool_call", call: c };
    yield { type: "usage", tokensIn: r.tokensIn ?? 0, tokensOut: r.tokensOut ?? 0 };
    yield { type: "done", finish: "stop" };
    return;
  }

  const key = p.apiKey();
  if (!p.local && !key) throw new ProviderError(`${p.label} has no API key.`, provider, 401, undefined, p.fixHint);

  let url: string, headers: Record<string, string> = { "content-type": "application/json" }, body: unknown;
  if (p.dialect === "anthropic") {
    url = `${p.baseUrl()}/messages`;
    headers = { ...headers, "x-api-key": key, "anthropic-version": "2023-06-01" };
    body = buildAnthropicBody(req, model);
  } else if (p.dialect === "ollama") {
    url = `${p.baseUrl()}/api/chat`;
    body = buildOllamaBody(req, model);
  } else {
    url = `${p.baseUrl()}/chat/completions`;
    if (key) headers.authorization = `Bearer ${key}`;
    body = buildOpenAIBody(req, model);
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") throw e;
    const hint = p.local ? p.fixHint : "Check your network connection.";
    throw new ProviderError(`Could not reach ${p.label}. ${hint}`, provider, 0, undefined, hint);
  }
  recordHeaders(provider, res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const retry = parseDuration(res.headers.get("retry-after")) ?? parseDuration(res.headers.get("x-ratelimit-reset-requests"));
    if (res.status === 429) record429(provider, retry, text.slice(0, 120));
    throw new ProviderError(friendly(p.label, res.status, text, p.fixHint), provider, res.status, retry, p.fixHint);
  }
  if (!res.body) throw new ProviderError(`${p.label} returned an empty response.`, provider, res.status);
  const parser = p.dialect === "anthropic" ? parseAnthropicStream : p.dialect === "ollama" ? parseOllamaStream : parseOpenAIStream;
  yield* parser(res.body);
}

export async function complete(req: LLMRequest): Promise<LLMResult> {
  const t0 = Date.now();
  const out: LLMResult = { text: "", reasoning: "", toolCalls: [], tokensIn: 0, tokensOut: 0, ms: 0 };
  for await (const ev of stream(req)) {
    if (ev.type === "text") out.text += ev.text;
    else if (ev.type === "reasoning") out.reasoning += ev.text;
    else if (ev.type === "tool_call") out.toolCalls.push(ev.call);
    else if (ev.type === "usage") { out.tokensIn = ev.tokensIn; out.tokensOut = ev.tokensOut; }
    else if (ev.type === "done") out.finish = ev.finish;
  }
  out.ms = Date.now() - t0;
  // some models inline <think> blocks
  out.text = out.text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!out.tokensOut) out.tokensOut = Math.ceil(out.text.length / 4);
  return out;
}

/** Lenient JSON extraction: fenced blocks, surrounding prose, trailing commas, single quotes. */
export function extractJSON<T = unknown>(text: string): T | undefined {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (let m = fence.exec(text); m; m = fence.exec(text)) candidates.push(m[1]!);
  candidates.push(text);
  for (const c of candidates) {
    for (const open of ["{", "["]) {
      const close = open === "{" ? "}" : "]";
      let start = c.indexOf(open);
      while (start >= 0) {
        const end = c.lastIndexOf(close);
        if (end <= start) break;
        const slice = c.slice(start, end + 1);
        for (const s of [slice, slice.replace(/,\s*([}\]])/g, "$1")]) {
          try { return JSON.parse(s) as T; } catch { /* next */ }
        }
        start = c.indexOf(open, start + 1);
        if (start > 0 && end - start < 2) break;
      }
    }
  }
  return undefined;
}

export async function completeJSON<T = unknown>(req: LLMRequest): Promise<{ value: T; raw: LLMResult }> {
  const raw = await complete({ ...req, json: true });
  const value = extractJSON<T>(raw.text);
  if (value === undefined) throw new ProviderError(`The model did not return valid JSON (${raw.text.slice(0, 80)}).`, splitRef(req.model).provider, 0);
  return { value, raw };
}
