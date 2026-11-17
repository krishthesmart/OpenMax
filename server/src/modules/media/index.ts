import fs from "node:fs";
import path from "node:path";
import { cfg, dataPath, readJson } from "../../config.js";
import { getDb, now, uid } from "../../db.js";
import { getAttachment } from "../attachments.js";
import { comfyBackend } from "./comfy.js";
import { falBackend } from "./fal.js";
import { googleImageBackend, pickGoogleImageModel } from "./googleImage.js";
import { mockBackend } from "./mock.js";
import { composePrompt } from "./presets.js";
import { gpu } from "./scheduler.js";
import { ASPECTS, dimsFor, OPS, SUBOPS, type JobParams, type MediaBackend, type MediaOutput, type Op, type OpSupport, type RunCtx } from "./types.js";

export * from "./types.js";
export { PRESETS, composePrompt } from "./presets.js";
export { gpu } from "./scheduler.js";
export { mockSvg } from "./mock.js";

export const mediaDir = () => { const d = dataPath("media"); fs.mkdirSync(d, { recursive: true }); return d; };

/** Backends visible right now. Paid (fal) only with ENABLE_PAID; Gemini image only when a Gemini key exists. */
export function listBackends(): MediaBackend[] {
  const out: MediaBackend[] = [mockBackend, comfyBackend];
  if (cfg.GEMINI_API_KEY && !cfg.OPENMAX_STUB) out.push(googleImageBackend);
  if (cfg.ENABLE_PAID) out.push(falBackend);
  return out;
}
export const getBackend = (id: string) => listBackends().find((b) => b.id === id);
export const defaultBackendId = () => { const want = cfg.MEDIA_PROVIDER === "google-image" ? "google-image" : cfg.MEDIA_PROVIDER; return getBackend(want) ? want : "mock"; };

export async function backendsInfo() {
  const info = [];
  for (const b of listBackends()) info.push({ id: b.id, label: b.label, gpu: b.gpu, status: await b.status(), ops: b.ops(), default: b.id === defaultBackendId() });
  return { backends: info, subops: SUBOPS, aspects: Object.keys(ASPECTS), gpu: gpu.state(), googleImageModel: pickGoogleImageModel() ?? null };
}

export function validateParams(p: JobParams): { backend: MediaBackend; support: OpSupport } {
  if (!OPS.includes(p.op)) throw Object.assign(new Error(`Unknown operation "${p.op}".`), { status: 400 });
  if (!p.prompt?.trim() && !(p.op === "v2v" && p.subop === "extend")) throw Object.assign(new Error("Write a prompt first."), { status: 400 });
  if (!(p.aspect in ASPECTS)) throw Object.assign(new Error(`Unsupported aspect ratio "${p.aspect}".`), { status: 400 });
  if (!(p.count >= 1 && p.count <= 4)) throw Object.assign(new Error("Count must be between 1 and 4."), { status: 400 });
  if (p.duration !== undefined && !(p.duration >= 1 && p.duration <= 10)) throw Object.assign(new Error("Duration must be 1–10 seconds."), { status: 400 });
  const backend = getBackend(p.backend ?? defaultBackendId());
  if (!backend) throw Object.assign(new Error(`Backend "${p.backend}" is not available.`), { status: 400, fix: "Pick one from the backend list." });
  const support = backend.ops()[p.op];
  if (!support.supported) throw Object.assign(new Error(`${backend.label} cannot do "${p.op}". ${support.reason ?? ""}`), { status: 400, fix: support.reason });
  if (p.op === "v2v" && p.subop && !SUBOPS.includes(p.subop)) throw Object.assign(new Error(`Unknown video edit "${p.subop}".`), { status: 400 });
  if ((p.op === "i2v" || p.op === "v2v" || p.op === "edit") && !p.inputAttachmentId) throw Object.assign(new Error(`"${p.op}" needs an input ${p.op === "v2v" ? "video" : "image"}. Upload one first.`), { status: 400 });
  return { backend, support };
}

export function buildCtx(jobId: string, p: JobParams, signal: AbortSignal, progress: RunCtx["progress"], refImagePath?: string): RunCtx {
  const video = p.op === "i2v" || p.op === "t2v" || p.op === "v2v";
  const { width, height } = dimsFor(p.aspect, video);
  const fps = readJson<{ fps?: number }>(dataPath("media.json"), {}).fps ?? 24;
  const dir = path.join(mediaDir(), jobId); fs.mkdirSync(dir, { recursive: true });
  const base = p.seed !== undefined && p.seed >= 0 ? p.seed : Math.floor(Math.random() * 2 ** 31);
  const { prompt, negative } = composePrompt(p.prompt, p.presets, p.op === "v2v" ? p.subop : undefined);
  const att = p.inputAttachmentId ? getAttachment(p.inputAttachmentId) : undefined;
  return { jobId, dir, params: p, prompt, negative: [p.negative, negative].filter(Boolean).join(", "), seeds: Array.from({ length: p.count }, (_, i) => base + i), width, height, frames: Math.round((p.duration ?? 4) * fps) + 1, fps, inputPath: att?.path, inputMime: att?.mime, refImagePath, signal, progress };
}

// ───────── job queue ─────────
const aborts = new Map<string, AbortController>();
let cpuSlots = 0; const CPU_MAX = 3; const cpuWaiters: (() => void)[] = [];
async function cpuAcquire() { if (cpuSlots < CPU_MAX) { cpuSlots++; return; } await new Promise<void>((r) => cpuWaiters.push(r)); cpuSlots++; }
const cpuRelease = () => { cpuSlots--; cpuWaiters.shift()?.(); };

export interface JobRow { id: string; kind: string; backend: string; params: JobParams; status: string; progress: number; note?: string; outputs: (MediaOutput & { url: string })[]; error: string | null; created_at: number; finished_at: number | null }
const hydrate = (r: any): JobRow => {
  const outs = JSON.parse(r.outputs) as MediaOutput[];
  return { ...r, params: JSON.parse(r.params), outputs: outs.map((o) => ({ ...o, url: `/api/media/${r.id}/${path.basename(o.file)}` })) };
};
export const getJob = (id: string) => { const r = getDb().prepare("SELECT * FROM media_jobs WHERE id=?").get(id); return r ? hydrate(r) : undefined; };
export const listJobs = (limit = 100) => (getDb().prepare("SELECT * FROM media_jobs ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map(hydrate);
const notes = new Map<string, string>();
export const jobNote = (id: string) => notes.get(id);

export function enqueue(p: JobParams): JobRow {
  const { backend } = validateParams(p);
  const id = uid("j_");
  getDb().prepare("INSERT INTO media_jobs(id,kind,backend,params,status,progress,outputs,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, p.op, backend.id, JSON.stringify({ ...p, backend: backend.id }), "queued", 0, "[]", now());
  void execute(id, backend, { ...p, backend: backend.id });
  return getJob(id)!;
}

export async function execute(id: string, backend: MediaBackend, p: JobParams) {
  const ac = new AbortController(); aborts.set(id, ac);
  const db = getDb();
  const setP = (progress: number, note?: string) => { db.prepare("UPDATE media_jobs SET progress=? WHERE id=?").run(Math.min(0.99, Math.max(0, progress)), id); if (note) notes.set(id, note); };
  const work = async () => {
    if (ac.signal.aborted) return;
    db.prepare("UPDATE media_jobs SET status='running' WHERE id=?").run(id);
    try {
      const outs = await backend.run(buildCtx(id, p, ac.signal, setP));
      if (!getJob(id)) return; // deleted while running
      db.prepare("UPDATE media_jobs SET status='done', progress=1, outputs=?, finished_at=? WHERE id=?").run(JSON.stringify(outs), now(), id);
    } catch (e: any) {
      if (!getJob(id)) return;
      const aborted = e?.name === "AbortError";
      db.prepare("UPDATE media_jobs SET status=?, error=?, finished_at=? WHERE id=?").run(aborted ? "cancelled" : "error", aborted ? null : String(e.message).slice(0, 400), now(), id);
    }
  };
  try {
    if (backend.gpu) await gpu.runExclusive(work, backend.afterIdle?.bind(backend));
    else { await cpuAcquire(); try { await work(); } finally { cpuRelease(); } }
  } finally { aborts.delete(id); notes.delete(id); }
}

export function deleteJob(id: string) {
  aborts.get(id)?.abort();
  getDb().prepare("DELETE FROM media_jobs WHERE id=?").run(id);
  fs.rmSync(path.join(mediaDir(), id), { recursive: true, force: true });
}
export function markInterruptedJobs() {
  getDb().prepare("UPDATE media_jobs SET status='error', error='Interrupted by a server restart. Use Remix to run it again.' WHERE status IN ('queued','running')").run();
}
export function mediaFilePath(jobId: string, file: string): string | undefined {
  if (!/^[\w-]+$/.test(jobId) || file !== path.basename(file)) return undefined;
  const p = path.join(mediaDir(), jobId, file);
  return fs.existsSync(p) ? p : undefined;
}

/** One-shot render used by Storybook: runs a backend inline (still GPU-exclusive) and returns the files. */
export async function renderInline(p: JobParams, jobId: string, refImagePath?: string, signal: AbortSignal = new AbortController().signal): Promise<MediaOutput[]> {
  const { backend } = validateParams(p);
  const work = () => backend.run(buildCtx(jobId, p, signal, () => {}, refImagePath));
  return backend.gpu ? gpu.runExclusive(work, backend.afterIdle?.bind(backend)) : work();
}
export type { Op };
