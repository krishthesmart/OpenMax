import { cfg } from "../config.js";
import { getProvider, providerEnabled } from "../providers/registry.js";
import { cooldownRemaining } from "../providers/limits.js";
import { splitRef } from "../providers/types.js";
import { getRouterConfig } from "../router/config.js";

export const HASH_DIM = 256;
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(HASH_DIM).fill(0);
  const words = text.toLowerCase().match(/[a-z0-9À-￿]+/g) ?? [];
  const add = (tok: string, w: number) => { let h = 2166136261; for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); } v[Math.abs(h) % HASH_DIM]! += (h & 0x100 ? -1 : 1) * w; };
  words.forEach((w, i) => { add(w, 1); if (i > 0) add(words[i - 1] + " " + w, 0.5); });
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}
export const toBlob = (v: number[]) => Buffer.from(new Float32Array(v).buffer);

export interface EmbedResult { vectors: number[][]; model: string; dim: number }
export async function embedWith(ref: string, texts: string[], kind: "passage" | "query"): Promise<number[][]> {
  const { provider, model } = splitRef(ref);
  const p = getProvider(provider)!;
  if (p.dialect === "ollama") {
    const r = await fetch(`${p.baseUrl()}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input: texts }), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`ollama embed ${r.status}`);
    return ((await r.json()) as any).embeddings;
  }
  const body: Record<string, unknown> = { model, input: texts, encoding_format: "float" };
  if (provider === "nvidia") { body.input_type = kind; body.truncate = "END"; }
  const r = await fetch(`${p.baseUrl()}/embeddings`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey()}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${provider} embeddings ${r.status}`);
  const j: any = await r.json();
  return j.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
}

let working: string | undefined;
export const resetEmbedCache = () => { working = undefined; };

/** Embed with the first working model in router.json; falls back to a deterministic hashed bag-of-words. */
export async function embed(texts: string[], kind: "passage" | "query" = "passage", opts: { localOnly?: boolean } = {}): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], model: "none", dim: 0 };
  {
    const refs = getRouterConfig().embeddings.filter((r) => {
      const p = getProvider(splitRef(r).provider);
      return p && providerEnabled(p) && (!opts.localOnly || p.local) && cooldownRemaining(p.id) === 0;
    });
    const ordered = working && refs.includes(working) ? [working, ...refs.filter((r) => r !== working)] : refs;
    for (const ref of ordered) {
      try {
        const out: number[][] = [];
        for (let i = 0; i < texts.length; i += 32) out.push(...(await embedWith(ref, texts.slice(i, i + 32), kind)));
        working = ref;
        return { vectors: out, model: ref, dim: out[0]?.length ?? 0 };
      } catch { /* next */ }
    }
  }
  return { vectors: texts.map(hashEmbed), model: "hash", dim: HASH_DIM };
}
