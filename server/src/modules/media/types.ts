export const OPS = ["t2i", "i2v", "t2v", "v2v", "edit"] as const;
export type Op = (typeof OPS)[number];
export const SUBOPS = ["restyle", "extend", "replace_subject", "camera_move"] as const;
export type SubOp = (typeof SUBOPS)[number];

export interface JobParams {
  op: Op; subop?: SubOp; prompt: string; negative?: string; seed?: number; aspect: string; duration?: number; count: number;
  presets: string[]; inputAttachmentId?: string; backend?: string; storyRef?: string;
}
export interface MediaOutput { file: string; mime: string; kind: "image" | "video"; seed: number }
export interface OpSupport { supported: boolean; reason?: string }
export interface RunCtx {
  jobId: string; dir: string; params: JobParams; prompt: string; negative: string; seeds: number[]; width: number; height: number; frames: number; fps: number;
  inputPath?: string; inputMime?: string; refImagePath?: string; signal: AbortSignal; progress: (p: number, note?: string) => void;
}
export interface MediaBackend {
  id: string; label: string; gpu: boolean;
  status(): Promise<{ ok: boolean; detail?: string }>;
  ops(): Record<Op, OpSupport>;
  run(ctx: RunCtx): Promise<MediaOutput[]>;
  afterIdle?(): Promise<void>;
}
export const ASPECTS: Record<string, [number, number]> = { "1:1": [1, 1], "16:9": [16, 9], "9:16": [9, 16], "4:3": [4, 3], "3:4": [3, 4], "21:9": [21, 9], "3:2": [3, 2], "2:3": [2, 3] };
/** Dimensions rounded to multiples of 64 around a pixel budget (images ≈ 1 MP, video ≈ 0.35 MP). */
export function dimsFor(aspect: string, video: boolean): { width: number; height: number } {
  const [a, b] = ASPECTS[aspect] ?? [1, 1];
  const px = video ? 768 * 432 : 1024 * 1024;
  const h = Math.sqrt((px * b) / a), w = (h * a) / b;
  const r = (x: number) => Math.max(64, Math.round(x / 64) * 64);
  return { width: r(w), height: r(h) };
}
