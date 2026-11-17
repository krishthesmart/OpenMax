import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { addRoutes } from "../app.js";
import { HttpError, friendlyError } from "../util/errors.js";
import { backendsInfo, defaultBackendId, deleteJob, enqueue, getBackend, getJob, jobNote, listJobs, mediaFilePath, OPS, PRESETS, refreshReachability, SUBOPS } from "../modules/media/index.js";
import { NO_IMAGE_BACKEND } from "../modules/mediaStatus.js";
import { cfg } from "../config.js";
import { deleteStory, getStory, listStories, startStory, storyFile, storyPdfPath } from "../modules/media/story.js";
import { routedComplete } from "../router/router.js";

const mime = (f: string) => ({ svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", pdf: "application/pdf" } as Record<string, string>)[f.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

export function registerStudio(app: FastifyInstance) {
  app.get("/api/studio/backends", async () => backendsInfo());
  app.get("/api/studio/presets", async () => ({ presets: PRESETS }));
  app.post("/api/studio/jobs", async (req, reply) => {
    const b = z.object({
      op: z.enum(OPS), subop: z.enum(SUBOPS).optional(), prompt: z.string().default(""), negative: z.string().optional(), seed: z.number().int().optional(),
      aspect: z.string().default("1:1"), duration: z.number().optional(), count: z.number().int().default(1), presets: z.array(z.string()).default([]),
      inputAttachmentId: z.string().optional(), backend: z.string().optional(),
    }).parse(req.body);
    await refreshReachability();
    const be = getBackend(b.backend ?? defaultBackendId());
    const st = be ? await be.status() : undefined;
    if (be && !st!.ok) return reply.code(503).send({ error: `${be.label} is not available: ${st!.detail ?? "unreachable"}`, fix: be.id === "comfy" && !cfg.GEMINI_API_KEY && !cfg.NVIDIA_API_KEY ? NO_IMAGE_BACKEND : st!.detail });
    try { return { job: enqueue(b) }; }
    catch (e: any) { return reply.code(e.status ?? 400).send({ error: e.message, fix: e.fix }); }
  });
  app.get("/api/studio/jobs", async () => ({ jobs: listJobs().map((j) => ({ ...j, note: jobNote(j.id) })) }));
  app.get("/api/studio/jobs/:id", async (req) => { const j = getJob((req.params as any).id); if (!j) throw new HttpError(404, "Job not found."); return { job: { ...j, note: jobNote(j.id) } }; });
  app.delete("/api/studio/jobs/:id", async (req) => { deleteJob((req.params as any).id); return { ok: true }; });
  app.get("/api/media/:job/:file", async (req, reply) => {
    const p = req.params as any; const f = mediaFilePath(p.job, p.file) ?? storyFile(String(p.job).replace(/^story-/, ""), p.file);
    if (!f) throw new HttpError(404, "File not found.");
    return reply.header("cache-control", "public, max-age=3600").type(mime(f)).send(fs.createReadStream(f));
  });
  app.post("/api/studio/enhance", async (req) => {
    const b = z.object({ prompt: z.string().min(2), op: z.enum(OPS).optional() }).parse(req.body);
    const r = await routedComplete({ task: "creative", purpose: "enhance", temperature: 0.8, maxTokens: 300, messages: [{ role: "system", content: `Rewrite the user's idea as one rich, concrete ${b.op && b.op !== "t2i" && b.op !== "edit" ? "video" : "image"} generation prompt (subject, setting, lighting, lens/composition, mood). Keep their intent. Output only the prompt, under 80 words.` }, { role: "user", content: b.prompt }] });
    return { prompt: r.text.replace(/^["'\s]+|["'\s]+$/g, "") };
  });

  app.post("/api/studio/story", async (req, reply) => {
    const b = z.object({ premise: z.string().min(5), style: z.string().optional(), backend: z.string().optional() }).parse(req.body);
    await refreshReachability(); const be = getBackend(b.backend ?? defaultBackendId()); const st = be ? await be.status() : undefined;
    if (be && !st!.ok) return reply.code(503).send({ error: `${be.label} is not available: ${st!.detail ?? "unreachable"}`, fix: be.id === "comfy" && !cfg.GEMINI_API_KEY && !cfg.NVIDIA_API_KEY ? NO_IMAGE_BACKEND : st!.detail });
    return { id: startStory(b) };
  });
  app.get("/api/studio/story", async () => ({ stories: listStories() }));
  app.get("/api/studio/story/:id", async (req) => { const s = getStory((req.params as any).id); if (!s) throw new HttpError(404, "Story not found."); return { story: s }; });
  app.delete("/api/studio/story/:id", async (req) => { deleteStory((req.params as any).id); return { ok: true }; });
  app.get("/api/studio/story/:id/pdf", async (req, reply) => { const p = storyPdfPath((req.params as any).id); if (!p) throw new HttpError(404, "The PDF is not ready yet."); return reply.header("content-disposition", 'attachment; filename="storybook.pdf"').type("application/pdf").send(fs.createReadStream(p)); });
  void friendlyError;
}
addRoutes(registerStudio);
