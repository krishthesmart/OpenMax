import fs from "node:fs";
import path from "node:path";
import { cfg, dataPath, readJson } from "../../config.js";
import { OPS, type MediaBackend, type MediaOutput, type Op, type OpSupport, type RunCtx } from "./types.js";

export const falModels = () => readJson<{ fal?: Partial<Record<Op, string>>; fps?: number }>(dataPath("media.json"), {}).fal ?? {};
const headers = () => ({ "content-type": "application/json", authorization: `Key ${cfg.FAL_KEY}` });

export const falBackend: MediaBackend = {
  id: "fal", label: "fal.ai (paid)", gpu: false,
  async status() { return cfg.FAL_KEY ? { ok: true, detail: "Paid per generation." } : { ok: false, detail: "Set FAL_KEY to use fal.ai." }; },
  ops() {
    const m = falModels();
    return Object.fromEntries(OPS.map((op) => [op, m[op] ? { supported: true } : { supported: false, reason: op === "v2v" ? "fal has no generic video-to-video endpoint configured in data/media.json." : `No fal model set for "${op}" in data/media.json.` }])) as Record<Op, OpSupport>;
  },
  async run(ctx: RunCtx): Promise<MediaOutput[]> {
    const op = ctx.params.op, model = falModels()[op];
    if (!cfg.FAL_KEY) throw new Error("FAL_KEY is not set.");
    if (!model) throw new Error(`No fal model for "${op}".`);
    const outs: MediaOutput[] = [];
    const dataUrl = ctx.inputPath ? `data:${ctx.inputMime ?? "image/png"};base64,${fs.readFileSync(ctx.inputPath).toString("base64")}` : undefined;
    for (let i = 0; i < ctx.seeds.length; i++) {
      ctx.progress(i / ctx.seeds.length, "Submitted to fal.ai");
      const body: Record<string, unknown> = { prompt: ctx.prompt, seed: ctx.seeds[i], image_size: { width: ctx.width, height: ctx.height }, num_frames: ctx.frames };
      if (dataUrl) body.image_url = dataUrl;
      if (ctx.negative) body.negative_prompt = ctx.negative;
      const sub = await fetch(`https://queue.fal.run/${model}`, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: ctx.signal });
      if (!sub.ok) throw new Error(`fal.ai rejected the request (${sub.status}): ${(await sub.text()).slice(0, 200)}`);
      const q: any = await sub.json();
      for (let t = 0; ; t++) {
        if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const s: any = await (await fetch(q.status_url, { headers: headers(), signal: ctx.signal })).json();
        if (s.status === "COMPLETED") break;
        if (s.status === "FAILED" || t > 600) throw new Error("fal.ai generation failed or timed out.");
        await new Promise((r) => setTimeout(r, 2000));
      }
      const res: any = await (await fetch(q.response_url, { headers: headers(), signal: ctx.signal })).json();
      const url: string | undefined = res.video?.url ?? res.images?.[0]?.url ?? res.image?.url;
      if (!url) throw new Error("fal.ai returned no media URL.");
      const r = await fetch(url, { signal: ctx.signal });
      const mime = r.headers.get("content-type") ?? "image/png";
      const ext = mime.includes("mp4") ? ".mp4" : mime.includes("webm") ? ".webm" : mime.includes("jpeg") ? ".jpg" : ".png";
      const out = path.join(ctx.dir, `out-${i + 1}${ext}`); fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
      outs.push({ file: out, mime, kind: mime.startsWith("video") ? "video" : "image", seed: ctx.seeds[i]! });
    }
    return outs;
  },
};
