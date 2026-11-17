import fs from "node:fs";
import path from "node:path";
import { cfg, dataPath, readJson } from "../../config.js";
import { getCatalogFor } from "../../providers/discovery.js";
import { OPS, type MediaBackend, type MediaOutput, type Op, type OpSupport, type RunCtx } from "./types.js";

export const googleImageModels = () => readJson<{ googleImage?: string[] }>(dataPath("media.json"), {}).googleImage ?? [];
/** First configured model that the key's catalog actually lists (or the first configured one when the catalog is unknown). */
export function pickGoogleImageModel(): string | undefined {
  const cat = getCatalogFor("google").map((m) => m.id);
  const want = googleImageModels();
  if (!cat.length) return cfg.GEMINI_API_KEY ? want[0] : undefined;
  return want.find((m) => cat.includes(m)) ?? cat.find((m) => /image/.test(m) && /gemini|imagen/.test(m));
}

export const googleImageBackend: MediaBackend = {
  id: "google-image", label: "Gemini image (free tier)", gpu: false,
  async status() {
    if (!cfg.GEMINI_API_KEY) return { ok: false, detail: "Set GEMINI_API_KEY." };
    const m = pickGoogleImageModel();
    return m ? { ok: true, detail: `model ${m}` } : { ok: false, detail: "Your Gemini key does not list an image-capable model (see data/media.json → googleImage)." };
  },
  ops() {
    const no = (reason: string): OpSupport => ({ supported: false, reason });
    return Object.fromEntries(OPS.map((op) => [op, op === "t2i" || op === "edit" ? { supported: true } : no("Gemini image models generate stills, not video. Use ComfyUI, fal or mock for video.")])) as Record<Op, OpSupport>;
  },
  async run(ctx: RunCtx): Promise<MediaOutput[]> {
    const model = pickGoogleImageModel();
    if (!model) throw new Error("No Gemini image model is available for your key.");
    const outs: MediaOutput[] = [];
    for (let i = 0; i < ctx.seeds.length; i++) {
      ctx.progress(i / ctx.seeds.length, `Gemini image ${i + 1}/${ctx.seeds.length}`);
      const parts: any[] = [{ text: ctx.prompt + (ctx.negative ? `\nAvoid: ${ctx.negative}` : "") + `\nAspect ratio ${ctx.params.aspect}.` }];
      for (const p of [ctx.inputPath, ctx.refImagePath]) if (p) parts.push({ inlineData: { mimeType: /\.jpe?g$/i.test(p) ? "image/jpeg" : "image/png", data: fs.readFileSync(p).toString("base64") } });
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": cfg.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"], seed: ctx.seeds[i] } }), signal: ctx.signal,
      });
      if (!r.ok) throw new Error(r.status === 429 ? "Gemini image quota reached for now (free tier). Try again later." : `Gemini image error ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j: any = await r.json();
      const part = (j.candidates?.[0]?.content?.parts ?? []).find((p: any) => p.inlineData?.data);
      if (!part) throw new Error("Gemini returned no image (the prompt may have been refused).");
      const mime = part.inlineData.mimeType ?? "image/png";
      const out = path.join(ctx.dir, `out-${i + 1}.${mime.includes("jpeg") ? "jpg" : "png"}`);
      fs.writeFileSync(out, Buffer.from(part.inlineData.data, "base64"));
      outs.push({ file: out, mime, kind: "image", seed: ctx.seeds[i]! });
    }
    return outs;
  },
};
