import { cfg } from "../config.js";
import { backendsInfo } from "./media/index.js";

export const NO_IMAGE_BACKEND = "No image backend is available. Start ComfyUI (local GPU), or add an NVIDIA API key (NVIDIA_API_KEY) for hosted FLUX, or a Gemini API key (GEMINI_API_KEY) for Gemini image generation.";

/** Summary for /api/health: the backend that would be used for a new image right now. */
export async function mediaStatus(): Promise<{ backend: string; ok: boolean; detail?: string }> {
  const info = await backendsInfo();
  const def = info.backends.find((b) => b.default) ?? info.backends[0]!;
  if (!def.status.ok && def.id === "comfy" && !cfg.GEMINI_API_KEY && !cfg.NVIDIA_API_KEY && cfg.MEDIA_PROVIDER === "auto") return { backend: "none", ok: false, detail: NO_IMAGE_BACKEND };
  return { backend: def.id, ok: def.status.ok, detail: def.status.detail };
}
