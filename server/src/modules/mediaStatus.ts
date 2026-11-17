import { cfg } from "../config.js";
export async function mediaStatus(): Promise<{ backend: string; ok: boolean; detail?: string }> {
  const b = cfg.MEDIA_PROVIDER;
  if (b === "mock") return { backend: "mock", ok: true, detail: "SVG placeholders; no GPU needed" };
  if (b === "comfy") {
    try { const r = await fetch(`${cfg.COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(1500) }); return { backend: "comfy", ok: r.ok }; }
    catch { return { backend: "comfy", ok: false, detail: "ComfyUI not reachable" }; }
  }
  if (b === "fal") return { backend: "fal", ok: !!cfg.FAL_KEY, detail: cfg.FAL_KEY ? undefined : "FAL_KEY missing" };
  return { backend: b, ok: false, detail: "unknown MEDIA_PROVIDER" };
}
