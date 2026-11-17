export interface Preset { id: string; label: string; kind: "motion" | "style"; prompt: string; negative?: string }
/** Motion presets add camera language to the prompt; style presets add look. */
export const PRESETS: Preset[] = [
  { id: "static", label: "Static", kind: "motion", prompt: "locked-off static camera, no camera movement" },
  { id: "dolly_in", label: "Dolly in", kind: "motion", prompt: "slow smooth dolly in toward the subject" },
  { id: "dolly_out", label: "Dolly out", kind: "motion", prompt: "slow smooth dolly out revealing the scene" },
  { id: "orbit", label: "Orbit", kind: "motion", prompt: "camera orbits 180 degrees around the subject" },
  { id: "crane", label: "Crane up", kind: "motion", prompt: "crane shot rising up and tilting down over the scene" },
  { id: "pan_left", label: "Pan left", kind: "motion", prompt: "smooth pan to the left" },
  { id: "pan_right", label: "Pan right", kind: "motion", prompt: "smooth pan to the right" },
  { id: "handheld", label: "Handheld", kind: "motion", prompt: "handheld camera with natural subtle shake" },
  { id: "fpv", label: "FPV drone", kind: "motion", prompt: "fast FPV drone flight weaving through the scene" },
  { id: "bullet_time", label: "Bullet time", kind: "motion", prompt: "bullet-time freeze with the camera sweeping around the frozen subject" },
  { id: "crash_zoom", label: "Crash zoom", kind: "motion", prompt: "sudden crash zoom onto the subject" },
  { id: "rack_focus", label: "Rack focus", kind: "motion", prompt: "rack focus shifting from foreground to background" },
  { id: "timelapse", label: "Timelapse", kind: "motion", prompt: "timelapse, clouds and light changing rapidly" },
  { id: "slow_mo", label: "Slow motion", kind: "motion", prompt: "ultra slow motion, 240fps look" },
  { id: "cinematic", label: "Cinematic", kind: "style", prompt: "cinematic lighting, anamorphic lens, film grain, shallow depth of field, color graded", negative: "flat lighting, snapshot" },
  { id: "anime", label: "Anime", kind: "style", prompt: "anime style, clean line art, vibrant cel shading, studio-quality animation", negative: "photorealistic" },
  { id: "noir", label: "Film noir", kind: "style", prompt: "black and white film noir, hard shadows, high contrast, moody", negative: "color, bright" },
  { id: "product", label: "Product shot", kind: "style", prompt: "premium product photography, seamless studio backdrop, soft box lighting, crisp reflections", negative: "clutter, text, watermark" },
];
export const presetById = (id: string) => PRESETS.find((p) => p.id === id);
export function composePrompt(prompt: string, presetIds: string[], subop?: string): { prompt: string; negative: string } {
  const ps = presetIds.map(presetById).filter((p): p is Preset => !!p);
  const sub = ({ restyle: "Restyle the footage while keeping the same motion and composition: ", extend: "Continue this clip naturally for more seconds: ", replace_subject: "Replace the main subject while keeping the background and motion: ", camera_move: "Keep the content, add this camera movement: " } as Record<string, string>)[subop ?? ""] ?? "";
  return { prompt: `${sub}${prompt.trim()}${ps.length ? ", " + ps.map((p) => p.prompt).join(", ") : ""}`.trim(), negative: [...new Set(ps.flatMap((p) => (p.negative ? [p.negative] : [])))].join(", ") };
}
