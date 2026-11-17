import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addRoutes } from "../app.js";
import { cfg, writeEnv } from "../config.js";
import { getSetting, setSetting } from "../db.js";
import { HttpError } from "../util/errors.js";
import { openSSE } from "../util/sse.js";
import { allTiers, detectHardware, tierFor } from "../hardware.js";
import { discoverAll } from "../providers/discovery.js";
import { allProviders, providerEnabled } from "../providers/registry.js";
import { searchStatus } from "../modules/search.js";
import { mediaStatus } from "../modules/mediaStatus.js";

/** Settings the UI may write to .env. Values are validated; secrets are never echoed back. */
export const WRITABLE_ENV = ["NVIDIA_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_PAID_API_KEY", "DEEPSEEK_API_KEY", "META_API_KEY", "FAL_KEY", "BRAVE_API_KEY",
  "ENABLE_PAID", "ALLOW_FREE_CLOUD", "MONTHLY_BUDGET_USD", "OLLAMA_URL", "SEARXNG_URL", "SEARCH_BACKEND", "MEDIA_PROVIDER", "COMFY_URL", "TTS_BACKEND", "GPU_WATTS", "USD_PER_KWH"] as const;
const SECRET = /KEY$/;
export function validateEnvUpdates(u: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(u)) {
    if (!(WRITABLE_ENV as readonly string[]).includes(k)) throw new HttpError(400, `${k} cannot be changed from the UI.`);
    const val = String(v).trim();
    if (/[\r\n\0]/.test(val) || val.length > 400) throw new HttpError(400, `${k}: invalid value.`);
    if (SECRET.test(k) && /\s/.test(val)) throw new HttpError(400, `${k}: API keys cannot contain spaces.`);
    if (/_URL$/.test(k) && val && !/^https?:\/\/[^\s]+$/.test(val)) throw new HttpError(400, `${k} must be an http(s) URL.`);
    if (/^(ENABLE_PAID|ALLOW_FREE_CLOUD)$/.test(k) && !/^(true|false)$/.test(val)) throw new HttpError(400, `${k} must be true or false.`);
    if (/^(MONTHLY_BUDGET_USD|GPU_WATTS|USD_PER_KWH)$/.test(k) && !(Number(val) >= 0)) throw new HttpError(400, `${k} must be a non-negative number.`);
    if (k === "SEARCH_BACKEND" && !/^(searxng|brave)$/.test(val)) throw new HttpError(400, "SEARCH_BACKEND must be searxng or brave.");
    if (k === "MEDIA_PROVIDER" && !/^(mock|comfy|fal|google-image)$/.test(val)) throw new HttpError(400, "MEDIA_PROVIDER must be mock, comfy, fal or google-image.");
    out[k] = val;
  }
  return out;
}

async function ollamaModels(): Promise<{ running: boolean; models: string[] }> {
  if (cfg.OPENMAX_STUB) return { running: true, models: ["llama3.2:1b"] };
  try { const r = await fetch(`${cfg.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) }); const j: any = await r.json(); return { running: true, models: (j.models ?? []).map((m: any) => m.name) }; }
  catch { return { running: false, models: [] }; }
}

export function registerSetup(app: FastifyInstance) {
  app.get("/api/setup/state", async () => {
    const hw = detectHardware(); const tier = tierFor(hw.memoryGb); const ol = await ollamaModels();
    const installed = (m: string) => ol.models.some((x) => x === m || x === `${m}:latest` || x.startsWith(`${m}:`));
    const keys = Object.fromEntries(allProviders().filter((p) => p.keyEnv).map((p) => [p.keyEnv, p.apiKey().length > 0]));
    return {
      done: getSetting<boolean>("setup.done", false), keys, paid: cfg.ENABLE_PAID, budget: cfg.MONTHLY_BUDGET_USD,
      providers: allProviders().filter((p) => !p.paid || cfg.ENABLE_PAID).map((p) => ({ id: p.id, label: p.label, keyEnv: p.keyEnv, paid: p.paid, local: p.local, enabled: providerEnabled(p), fix: p.fixHint })),
      hardware: hw, tier, tiers: allTiers().map((t) => t.label),
      ollama: { running: ol.running, models: ol.models, url: cfg.OLLAMA_URL, recommended: ["chat", "code", "vision", "embed"].flatMap((k) => ((tier as any)[k] as string[]).map((m) => ({ model: m, kind: k, installed: installed(m) }))) },
      search: await searchStatus(), media: await mediaStatus(), writable: WRITABLE_ENV,
      anyProvider: allProviders().some((p) => !p.paid && !p.local && providerEnabled(p)),
    };
  });
  app.put("/api/setup/env", async (req) => {
    const b = z.object({ updates: z.record(z.string(), z.string()) }).parse(req.body);
    const updates = validateEnvUpdates(b.updates);
    writeEnv(updates);
    const providers = await discoverAll();
    return { saved: Object.keys(updates), providers };
  });
  app.post("/api/setup/complete", async () => { setSetting("setup.done", true); return { ok: true }; });
  app.post("/api/setup/reset", async () => { setSetting("setup.done", false); return { ok: true }; });
  app.get("/api/ollama/models", async () => ollamaModels());
  app.post("/api/ollama/pull", async (req, reply) => {
    const b = z.object({ model: z.string().regex(/^[\w][\w.:/-]{1,80}$/, "Invalid model name") }).parse(req.body);
    const sse = openSSE(req, reply);
    try {
      if (cfg.OPENMAX_STUB) { for (const p of [0.2, 0.6, 1]) { sse.send("progress", { status: "pulling (stub)", completed: p * 100, total: 100 }); } sse.send("done", { model: b.model }); return sse.end(); }
      const r = await fetch(`${cfg.OLLAMA_URL}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: b.model, stream: true }), signal: sse.signal }).catch(() => undefined);
      if (!r?.ok || !r.body) { sse.send("error", { message: "Ollama is not running or refused the request.", fix: "Install Ollama (ollama.com), run `ollama serve`, then try again." }); return sse.end(); }
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of r.body as any) {
        buf += dec.decode(chunk, { stream: true }); let i: number;
        while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; try { const j = JSON.parse(line); if (j.error) { sse.send("error", { message: j.error }); return sse.end(); } sse.send("progress", { status: j.status, completed: j.completed, total: j.total }); } catch { /* skip */ } }
      }
      sse.send("done", { model: b.model });
    } catch (e: any) { if (!sse.signal.aborted) sse.send("error", { message: e.message }); }
    sse.end();
  });
}
addRoutes(registerSetup);
