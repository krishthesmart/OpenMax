import fs from "node:fs";
import path from "node:path";
import { cfg, dataPath } from "../../config.js";
import { OPS, type MediaBackend, type MediaOutput, type Op, type OpSupport, type RunCtx } from "./types.js";

const wfFile = (op: Op) => dataPath("workflows", `${op}.json`);
// falls back to the repo default if DATA_DIR has none (see readJson); try both explicitly
const wfPath = (op: Op): string | undefined => {
  for (const p of [wfFile(op), path.join(process.cwd(), "data", "workflows", `${op}.json`)]) if (fs.existsSync(p)) return p;
  return undefined;
};

/** Replace {{tokens}}. A string that is exactly one token takes the token's native type (number/string). */
export function fillWorkflow(graph: unknown, vars: Record<string, string | number>): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = /^\{\{(\w+)\}\}$/.exec(v);
      if (whole) return whole[1]! in vars ? vars[whole[1]!] : v;
      return v.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(graph);
}

const REQUIRES_INPUT: Record<Op, string | undefined> = { t2i: undefined, t2v: undefined, i2v: "an input image", v2v: "an input video", edit: "an input image" };

async function upload(file: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([fs.readFileSync(file)], { type: mime }), path.basename(file));
  const r = await fetch(`${cfg.COMFY_URL}/upload/image`, { method: "POST", body: form });
  if (!r.ok) throw new Error(`ComfyUI upload failed (${r.status}).`);
  return ((await r.json()) as any).name;
}

export const comfyBackend: MediaBackend = {
  id: "comfy", label: "ComfyUI (local GPU)", gpu: true,
  async status() {
    try { const r = await fetch(`${cfg.COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(2000) }); return r.ok ? { ok: true } : { ok: false, detail: `ComfyUI returned ${r.status}` }; }
    catch { return { ok: false, detail: `ComfyUI is not reachable at ${cfg.COMFY_URL}. Start it (python main.py) or run docker compose --profile gpu up.` }; }
  },
  ops() {
    return Object.fromEntries(OPS.map((op) => [op, wfPath(op) ? { supported: true } : { supported: false, reason: `No workflow template data/workflows/${op}.json. Export one from ComfyUI (Save → API Format) with {{tokens}}; see data/workflows/README.md.` }])) as Record<Op, OpSupport>;
  },
  async run(ctx: RunCtx): Promise<MediaOutput[]> {
    const op = ctx.params.op, file = wfPath(op);
    if (!file) throw new Error(`No ComfyUI workflow for "${op}". See data/workflows/README.md.`);
    if (REQUIRES_INPUT[op] && !ctx.inputPath) throw new Error(`This operation needs ${REQUIRES_INPUT[op]}.`);
    const template = JSON.parse(fs.readFileSync(file, "utf8"));
    const outs: MediaOutput[] = [];
    let uploaded = "";
    if (ctx.inputPath) uploaded = await upload(ctx.inputPath, ctx.inputMime ?? "application/octet-stream");
    for (let i = 0; i < ctx.seeds.length; i++) {
      ctx.progress(i / ctx.seeds.length, `Queued ${i + 1}/${ctx.seeds.length} in ComfyUI`);
      const graph = fillWorkflow(template, { prompt: ctx.prompt, negative: ctx.negative, seed: ctx.seeds[i]!, width: ctx.width, height: ctx.height, frames: ctx.frames, image: uploaded, video: uploaded });
      const r = await fetch(`${cfg.COMFY_URL}/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: "openmax" }), signal: ctx.signal });
      if (!r.ok) { const t = await r.text(); let m = t.slice(0, 300); try { const j = JSON.parse(t); m = j.error?.message ?? m; const ne = Object.values(j.node_errors ?? {})[0] as any; if (ne?.errors?.[0]) m += ` — ${ne.class_type}: ${ne.errors[0].message}`; } catch { /* raw */ } throw new Error(`ComfyUI rejected the workflow: ${m}`); }
      const { prompt_id } = (await r.json()) as any;
      let hist: any;
      const t0 = Date.now();
      for (;;) {
        if (ctx.signal.aborted) { await fetch(`${cfg.COMFY_URL}/interrupt`, { method: "POST" }).catch(() => {}); throw new DOMException("Aborted", "AbortError"); }
        if (Date.now() - t0 > 30 * 60_000) throw new Error("ComfyUI took longer than 30 minutes.");
        const h = await fetch(`${cfg.COMFY_URL}/history/${prompt_id}`, { signal: ctx.signal }).then((x) => x.json()).catch(() => ({}));
        if (h[prompt_id]) { hist = h[prompt_id]; if (hist.status?.status_str === "error") throw new Error("ComfyUI reported an error while running the workflow."); if (hist.outputs && Object.keys(hist.outputs).length) break; }
        ctx.progress((i + Math.min(0.9, (Date.now() - t0) / 120000)) / ctx.seeds.length, "Generating…");
        await new Promise((res) => setTimeout(res, 1000));
      }
      const files: any[] = Object.values(hist.outputs).flatMap((o: any) => [...(o.images ?? []), ...(o.gifs ?? []), ...(o.videos ?? [])]).filter((f: any) => f.type !== "temp");
      if (!files.length) throw new Error("ComfyUI finished but produced no output files. Does the workflow end in SaveImage / a video save node?");
      for (const f of files.slice(0, 1)) {
        const u = new URL(`${cfg.COMFY_URL}/view`); u.searchParams.set("filename", f.filename); u.searchParams.set("subfolder", f.subfolder ?? ""); u.searchParams.set("type", f.type ?? "output");
        const buf = Buffer.from(await (await fetch(u, { signal: ctx.signal })).arrayBuffer());
        const ext = path.extname(f.filename) || ".png";
        const out = path.join(ctx.dir, `out-${i + 1}${ext}`); fs.writeFileSync(out, buf);
        const video = /\.(mp4|webm|gif|webp|mov)$/i.test(ext) && !/^\.(png|jpg|jpeg)$/i.test(ext);
        outs.push({ file: out, mime: { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" }[ext.toLowerCase()] ?? "application/octet-stream", kind: video ? "video" : "image", seed: ctx.seeds[i]! });
      }
    }
    return outs;
  },
  /** Unload checkpoints after use so the GPU is free for LLMs; the hot Ollama model is left loaded (keep_alive). */
  async afterIdle() { await fetch(`${cfg.COMFY_URL}/free`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) }).catch(() => {}); },
};
