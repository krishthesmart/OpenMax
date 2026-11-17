import { cfg } from "../config.js";
import { getDb, now } from "../db.js";
import { allProviders, providerEnabled, refAllowed } from "./registry.js";
import { complete } from "./llm.js";
import { ProviderError, splitRef, type ProviderDef } from "./types.js";
import { allRefs, getRouterConfig } from "../router/config.js";
import { embedWith } from "../modules/embeddings.js";
import { record429 } from "./limits.js";

export interface DiscoveredModel { id: string; ctx?: number; vision?: boolean; tools?: boolean; kind: "chat" | "embedding" | "image" | "audio" | "other"; sizeB?: number }

export function classifyKind(id: string): DiscoveredModel["kind"] {
  const s = id.toLowerCase();
  if (/embed|nvclip|retriev/.test(s)) return "embedding";
  if (/whisper|tts|riva|parakeet|speech/.test(s)) return "audio";
  if (/imagen|image-gen|flux|stable-diffusion|sdxl|veo|dall-e|cosmos-predict/.test(s)) return "image";
  if (/guard|safety|moderation|detector|topic-control|calibration/.test(s)) return "other";
  return "chat";
}
export function guessSizeB(id: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*b(?![a-z])/i.exec(id.replace(/[-_:]/g, " "));
  return m ? Number(m[1]) : undefined;
}

/** Parse a provider's /models response body into normalized models. */
export function parseModelList(provider: string, body: any): DiscoveredModel[] {
  let items: any[] = [];
  if (provider === "ollama") items = (body?.models ?? []).map((m: any) => ({ id: m.name ?? m.model, details: m.details }));
  else items = body?.data ?? body?.models ?? [];
  return items
    .map((m: any): DiscoveredModel | undefined => {
      const raw: string | undefined = typeof m === "string" ? m : m.id ?? m.name;
      if (!raw) return undefined;
      const id = raw.replace(/^models\//, "");
      const arch = m.architecture?.input_modalities as string[] | undefined;
      const params = (m.supported_parameters ?? []) as string[];
      return {
        id,
        ctx: m.context_length ?? m.inputTokenLimit ?? m.max_model_len ?? undefined,
        vision: arch ? arch.includes("image") : /vision|vl\b|omni|gemini|gemma-[34]|llava|moondream|pixtral/i.test(id),
        tools: params.length ? params.includes("tools") : undefined,
        kind: classifyKind(id),
        sizeB: (m.details?.parameter_size ? Number(String(m.details.parameter_size).replace(/[^\d.]/g, "")) || undefined : undefined) ?? guessSizeB(id),
      };
    })
    .filter((x): x is DiscoveredModel => !!x);
}

const catalog = new Map<string, DiscoveredModel[]>();
export const getCatalog = () => Object.fromEntries(catalog);
export const getCatalogFor = (provider: string) => catalog.get(provider) ?? [];

async function listModels(p: ProviderDef): Promise<DiscoveredModel[]> {
  const url = p.dialect === "ollama" ? `${p.baseUrl()}/api/tags` : `${p.baseUrl()}/models`;
  const headers: Record<string, string> = {};
  if (p.dialect === "anthropic") { headers["x-api-key"] = p.apiKey(); headers["anthropic-version"] = "2023-06-01"; }
  else if (p.apiKey()) headers.authorization = `Bearer ${p.apiKey()}`;
  let res: Response;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); }
  catch { throw new ProviderError(`Could not reach ${p.label}.`, p.id, 0, undefined, p.fixHint); }
  if (!res.ok) throw new ProviderError(`${p.label} /models returned ${res.status}${res.status === 401 || res.status === 403 ? " (check the API key)" : ""}.`, p.id, res.status, undefined, p.fixHint);
  let models = parseModelList(p.id, await res.json());
  if (p.id === "openrouter" && !cfg.ENABLE_PAID) models = models.filter((m) => m.id.endsWith(":free"));
  return models;
}

export interface ProviderTest { provider: string; label: string; enabled: boolean; ok: boolean; error?: string; fix?: string; models: number }

export async function discoverAll(): Promise<ProviderTest[]> {
  const results = await Promise.all(
    allProviders().filter((p) => !p.paid || cfg.ENABLE_PAID).map(async (p): Promise<ProviderTest> => {
      const enabled = providerEnabled(p);
      if (!enabled) return { provider: p.id, label: p.label, enabled, ok: false, error: p.local ? "not running" : "no API key", fix: p.fixHint, models: 0 };
      try {
        const models = await listModels(p);
        catalog.set(p.id, models);
        const db = getDb();
        const ins = db.prepare("INSERT INTO model_catalog(provider,model,meta,seen_at) VALUES(?,?,?,?) ON CONFLICT(provider,model) DO UPDATE SET meta=excluded.meta, seen_at=excluded.seen_at");
        db.transaction(() => models.forEach((m) => ins.run(p.id, m.id, JSON.stringify(m), now())))();
        return { provider: p.id, label: p.label, enabled, ok: true, models: models.length };
      } catch (e: any) {
        return { provider: p.id, label: p.label, enabled, ok: false, error: e.message, fix: e.fix ?? p.fixHint, models: 0 };
      }
    }),
  );
  return results;
}

export interface RefStatus { ref: string; ok: boolean; error?: string; ms?: number; tools?: boolean; listed?: boolean; skipped?: boolean }

const TOOL_PROBE = [{ name: "get_number", description: "Returns the number 42. Always call this.", parameters: { type: "object", properties: {}, additionalProperties: false } }];

export async function pingRef(ref: string, probeTools = false, role: "chat" | "embedding" | "stt" = "chat"): Promise<RefStatus> {
  const { provider, model } = splitRef(ref);
  const p = allProviders().find((x) => x.id === provider);
  if (!p || !providerEnabled(p) || !refAllowed(provider, model)) return { ref, ok: false, skipped: true, error: p ? "provider disabled" : "unknown provider" };
  const listed = catalog.get(provider);
  const inList = listed ? listed.some((m) => m.id === model || m.id === `${model}:latest`) : undefined;
  const t0 = Date.now();
  if (role === "stt") return { ref, ok: inList !== false, ms: 0, listed: inList, error: inList === false ? "not in the provider's model list" : undefined };
  try {
    if (role === "embedding") { const v = await embedWith(ref, ["ping"], "query"); return { ref, ok: Array.isArray(v[0]) && v[0].length > 0, ms: Date.now() - t0, listed: inList }; }
    const r = await complete({ model: ref, messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 8, temperature: 0 });
    let tools: boolean | undefined;
    if (probeTools) {
      try {
        const t = await complete({ model: ref, messages: [{ role: "user", content: "Call the get_number tool." }], tools: TOOL_PROBE, maxTokens: 64, temperature: 0 });
        tools = t.toolCalls.length > 0;
      } catch { tools = false; }
    }
    void r;
    return { ref, ok: true, ms: Date.now() - t0, tools, listed: inList };
  } catch (e: any) {
    if (e instanceof ProviderError && e.status === 429) { record429(provider, e.retryAfterSec); return { ref, ok: true, ms: Date.now() - t0, error: "rate limited (alive)", listed: inList }; }
    return { ref, ok: false, error: e.message, ms: Date.now() - t0, listed: inList };
  }
}

export async function pingAll(): Promise<RefStatus[]> {
  const rc = getRouterConfig();
  const probe = new Set(rc.toolProbe), embeds = new Set(rc.embeddings), stts = new Set(rc.stt);
  const refs = allRefs(rc);
  const out: RefStatus[] = [];
  // sequential per provider (be gentle on free tiers), parallel across providers
  const byProvider = new Map<string, string[]>();
  for (const r of refs) { const k = splitRef(r).provider; byProvider.set(k, [...(byProvider.get(k) ?? []), r]); }
  await Promise.all([...byProvider.values()].map(async (list) => {
    for (const ref of list) out.push(await pingRef(ref, probe.has(ref), embeds.has(ref) ? "embedding" : stts.has(ref) ? "stt" : "chat"));
  }));
  const db = getDb();
  const up = db.prepare("INSERT INTO ref_status(ref,ok,error,ms,tools,checked_at) VALUES(?,?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET ok=excluded.ok,error=excluded.error,ms=excluded.ms,tools=excluded.tools,checked_at=excluded.checked_at");
  db.transaction(() => out.forEach((s) => { if (!s.skipped) up.run(s.ref, s.ok ? 1 : 0, s.error ?? null, s.ms ?? null, s.tools === undefined ? null : s.tools ? 1 : 0, now()); }))();
  return out;
}

export function getRefStatuses(): Record<string, { ok: boolean; error?: string; ms?: number; tools?: boolean }> {
  const rows = getDb().prepare("SELECT * FROM ref_status").all() as any[];
  return Object.fromEntries(rows.map((r) => [r.ref, { ok: !!r.ok, error: r.error ?? undefined, ms: r.ms ?? undefined, tools: r.tools == null ? undefined : !!r.tools }]));
}
export const refVerifiedTools = (ref: string) => getRefStatuses()[ref]?.tools === true;

/** Suggest lane picks from the live catalog by size/capability keywords. Never auto-applied. */
export function suggestLanes(): Record<string, string[]> {
  const pick = (provider: string, f: (m: DiscoveredModel) => boolean, score: (m: DiscoveredModel) => number, n = 2) =>
    getCatalogFor(provider).filter((m) => m.kind === "chat" && f(m)).sort((a, b) => score(b) - score(a)).slice(0, n).map((m) => `${provider}:${m.id}`);
  const size = (m: DiscoveredModel) => m.sizeB ?? 0;
  const out: Record<string, string[]> = {};
  out.code = [...pick("openrouter", (m) => /code|coder|devstral/i.test(m.id), size, 1), ...pick("nvidia", (m) => /code|coder|ultra|nemotron/i.test(m.id), size, 1), ...pick("groq", (m) => /70b|120b|coder/i.test(m.id), size, 1)];
  out.reasoning = [...pick("nvidia", (m) => /ultra|reason|r1|235b|550b/i.test(m.id), size, 1), ...pick("openrouter", (m) => /reason|ultra|r1|thinking/i.test(m.id), size, 1), ...pick("google", (m) => /gemini.*(pro|flash)/i.test(m.id), (m) => (/pro/.test(m.id) ? 2 : 1), 1)];
  out["long-context"] = [...pick("google", (m) => /gemini/i.test(m.id), (m) => m.ctx ?? 0, 1), ...pick("openrouter", (m) => (m.ctx ?? 0) >= 500_000, (m) => m.ctx ?? 0, 1)];
  out.vision = [...pick("google", (m) => !!m.vision, (m) => m.ctx ?? 0, 1), ...pick("nvidia", (m) => !!m.vision || /omni|vl/i.test(m.id), size, 1)];
  out.quick = pick("groq", (m) => /8b|instant|small|mini/i.test(m.id), (m) => -size(m), 1);
  out.agentic = [...pick("nvidia", (m) => /omni|nemotron|ultra/i.test(m.id), size, 1), ...pick("google", (m) => /gemini/i.test(m.id), (m) => m.ctx ?? 0, 1)];
  for (const k of Object.keys(out)) if (!out[k]!.length) delete out[k];
  return out;
}
void allRefs;
