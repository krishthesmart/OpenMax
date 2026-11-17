import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { addRoutes } from "../app.js";
import { getDb, now } from "../db.js";
import { HttpError, friendlyError } from "../util/errors.js";
import { openSSE } from "../util/sse.js";
import { saveAttachment } from "../modules/attachments.js";
import { addSource, createNotebook, deleteNotebook, getNotebook, getSourceText, listNotebooks, listSources, notebookChat, removeSource, updateNotebook } from "../modules/notebook/notebook.js";
import { GENERATORS, deleteOutput, generate, getOutput, listOutputs } from "../modules/notebook/generators.js";
import { nextReview } from "../modules/notebook/sm2.js";

const must = (id: string) => { const n = getNotebook(id); if (!n) throw new HttpError(404, "Notebook not found."); return n; };

export function registerNotebook(app: FastifyInstance) {
  app.get("/api/notebooks", async () => ({ notebooks: listNotebooks() }));
  app.post("/api/notebooks", async (req) => { const b = z.object({ title: z.string().default("Untitled notebook"), private: z.boolean().optional() }).parse(req.body ?? {}); return { notebook: createNotebook(b.title, b.private) }; });
  app.patch("/api/notebooks/:id", async (req) => { must((req.params as any).id); return { notebook: updateNotebook((req.params as any).id, z.object({ title: z.string().optional(), private: z.boolean().optional() }).parse(req.body)) }; });
  app.delete("/api/notebooks/:id", async (req) => { deleteNotebook((req.params as any).id); return { ok: true }; });
  app.get("/api/notebooks/:id", async (req) => { const id = (req.params as any).id; return { notebook: must(id), sources: listSources(id), outputs: listOutputs(id).map((o) => ({ id: o.id, kind: o.kind, title: o.title, created_at: o.created_at, hasFile: !!o.file })) }; });

  app.post("/api/notebooks/:id/sources", async (req) => {
    const id = (req.params as any).id; must(id);
    if ((req.headers["content-type"] ?? "").startsWith("multipart/")) {
      const part = await (req as any).file(); if (!part) throw new HttpError(400, "No file received.");
      const att = await saveAttachment(part.filename, part.mimetype, await part.toBuffer());
      return { source: await addSource(id, { kind: att.kind === "pdf" ? "pdf" : "file", attachmentId: att.id }), sources: listSources(id) };
    }
    const b = z.object({ kind: z.enum(["url", "text", "youtube"]), url: z.string().optional(), text: z.string().optional(), name: z.string().optional() }).parse(req.body);
    return { source: await addSource(id, b), sources: listSources(id) };
  });
  app.get("/api/notebooks/:id/sources/:sid", async (req) => { const p = req.params as any; const s = getSourceText(p.id, p.sid); if (!s) throw new HttpError(404, "Source not found."); return { source: s }; });
  app.delete("/api/notebooks/:id/sources/:sid", async (req) => { const p = req.params as any; removeSource(p.id, p.sid); return { sources: listSources(p.id) }; });

  app.post("/api/notebooks/:id/chat", async (req, reply) => {
    const id = (req.params as any).id; must(id);
    const b = z.object({ question: z.string().min(1), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(), allowCloud: z.boolean().optional() }).parse(req.body);
    const sse = openSSE(req, reply);
    try { for await (const ev of notebookChat({ notebookId: id, ...b, signal: sse.signal })) sse.send(ev.event, ev.data); }
    catch (e) { if (!sse.signal.aborted) { const f = friendlyError(e); sse.send("error", { message: f.message, fix: f.fix }); } }
    sse.end();
  });

  app.post("/api/notebooks/:id/generate", async (req) => {
    const id = (req.params as any).id; must(id);
    const b = z.object({ kind: z.enum(GENERATORS), focus: z.string().optional(), count: z.number().int().min(2).max(30).optional() }).parse(req.body);
    const o = await generate(id, b.kind, b);
    return { output: { ...o, hasFile: !!o.file } };
  });
  app.get("/api/notebooks/:id/outputs/:oid", async (req) => { const o = getOutput((req.params as any).oid); if (!o) throw new HttpError(404, "Output not found."); return { output: { ...o, hasFile: !!o.file } }; });
  app.delete("/api/notebooks/:id/outputs/:oid", async (req) => { deleteOutput((req.params as any).oid); return { ok: true }; });
  app.get("/api/notebooks/:id/outputs/:oid/file", async (req, reply) => {
    const o = getOutput((req.params as any).oid); if (!o?.file || !fs.existsSync(o.file)) throw new HttpError(404, "No file for this output.");
    const ext = o.file.split(".").pop()!;
    const mime = ({ mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" } as Record<string, string>)[ext] ?? "application/octet-stream";
    return reply.header("content-disposition", `inline; filename="${o.title.replace(/[^\w.-]+/g, "_")}.${ext}"`).type(mime).send(fs.createReadStream(o.file));
  });

  // Flashcards (spaced repetition)
  app.get("/api/notebooks/:id/cards", async (req) => { const id = (req.params as any).id; const all = getDb().prepare("SELECT * FROM cards WHERE notebook_id=? ORDER BY due").all(id) as any[]; return { cards: all, due: all.filter((c) => c.due <= now()).length }; });
  app.post("/api/cards/:cid/review", async (req) => {
    const cid = (req.params as any).cid; const q = z.object({ quality: z.number().min(0).max(5) }).parse(req.body).quality;
    const c = getDb().prepare("SELECT * FROM cards WHERE id=?").get(cid) as any; if (!c) throw new HttpError(404, "Card not found.");
    const n = nextReview(c, q); getDb().prepare("UPDATE cards SET ease=?, interval=?, reps=?, due=? WHERE id=?").run(n.ease, n.interval, n.reps, n.due, cid);
    return { card: { ...c, ...n } };
  });
}
addRoutes(registerNotebook);
