import fs from "node:fs";
import path from "node:path";
import { cfg, dataPath, readJson } from "../../config.js";
import { OPS, type MediaBackend, type MediaOutput, type Op, type OpSupport, type RunCtx } from "./types.js";

/** NVIDIA hosted FLUX text-to-image (build.nvidia.com), on the same NVIDIA_API_KEY used for chat models. */
export const nvidiaImageModel = () => readJson<{ nvidia?: { t2i?: string } }>(dataPath("media.json"), {}).nvidia?.t2i ?? "black-forest-labs/flux.1-schnell";

// The hosted API only accepts these edge lengths.
export const NVIDIA_SIZES = [768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344];
export const snapSize = (n: number) => NVIDIA_SIZES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), NVIDIA_SIZES[0]!);

/** Request body per model family: schnell is a 4-step model; dev takes a mode and guidance. Neither accepts a seed. */
export function buildBody(model: string, prompt: string, width: number, height: number): Record<string, unknown> {
  const base = { prompt, width: snapSize(width), height: snapSize(height) };
  if (/schnell/i.test(model)) return { ...base, steps: 4 };
  return { ...base, mode: "base", cfg_scale: 3.5, steps: 20 };
}

export const nvidiaImageBackend: MediaBackend = {
  id: "nvidia-image", label: "NVIDIA FLUX (free tier)", gpu: false,
  async status() {
    return cfg.NVIDIA_API_KEY ? { ok: true, detail: `model ${nvidiaImageModel()}; prompts are sent to NVIDIA. Free-tier credits are limited.` } : { ok: false, detail: "Set NVIDIA_API_KEY (build.nvidia.com)." };
  },
  ops() {
    return Object.fromEntries(OPS.map((op) => [op, op === "t2i" ? { supported: true } : { supported: false, reason: op === "edit" ? "NVIDIA's hosted Kontext editing only accepts pre-uploaded asset ids. Use ComfyUI or Gemini image for edits." : "NVIDIA's hosted image models generate stills only. Use ComfyUI or fal for video." }])) as Record<Op, OpSupport>;
  },
  async run(ctx: RunCtx): Promise<MediaOutput[]> {
    if (!cfg.NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY is not set.");
    const model = nvidiaImageModel(); const outs: MediaOutput[] = [];
    const prompt = ctx.prompt + (ctx.negative ? `. Avoid: ${ctx.negative}` : "");
    for (let i = 0; i < ctx.seeds.length; i++) {
      if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
      ctx.progress(i / ctx.seeds.length, `NVIDIA ${model.split("/").pop()} ${i + 1}/${ctx.seeds.length}`);
      const r = await fetch(`${cfg.NVIDIA_GENAI_URL}/${model}`, {
        method: "POST", headers: { authorization: `Bearer ${cfg.NVIDIA_API_KEY}`, accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(buildBody(model, prompt, ctx.width, ctx.height)), signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(180_000)]),
      }).catch((e) => { if (ctx.signal.aborted) throw e; throw new Error("Could not reach NVIDIA's image API. Check your internet connection."); });
      if (!r.ok) {
        const t = await r.text(); let m = t.slice(0, 200); try { const j = JSON.parse(t); m = typeof j.detail === "string" ? j.detail : j.detail?.[0]?.msg ?? j.title ?? m; } catch { /* raw */ }
        throw new Error(r.status === 401 || r.status === 403 ? "NVIDIA rejected the API key for image generation (check NVIDIA_API_KEY)." : r.status === 429 ? "NVIDIA image quota or rate limit reached for now." : `NVIDIA image API error ${r.status}: ${m}`);
      }
      const j: any = await r.json(); const a = j.artifacts?.[0];
      if (!a?.base64) throw new Error("NVIDIA returned no image.");
      if (a.finishReason && a.finishReason !== "SUCCESS") throw new Error(`NVIDIA did not return an image (${a.finishReason}); the prompt may have been filtered.`);
      const buf = Buffer.from(a.base64, "base64"); const mime = buf[0] === 0x89 ? "image/png" : "image/jpeg";
      const out = path.join(ctx.dir, `out-${i + 1}.${mime === "image/png" ? "png" : "jpg"}`); fs.writeFileSync(out, buf);
      outs.push({ file: out, mime, kind: "image", seed: ctx.seeds[i]! });
    }
    return outs;
  },
};
