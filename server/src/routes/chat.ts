import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { getDb } from "../db.js";
import { addRoutes } from "../app.js";
import { openSSE } from "../util/sse.js";
import { friendlyError, HttpError } from "../util/errors.js";
import { artifactsFor, chatTurn, createConv, deleteConv, getConv, listMessages, searchConvs } from "../modules/chat.js";
import { attachmentText, getAttachment, publicAttachment, saveAttachment } from "../modules/attachments.js";
import { addGemKnowledge, deleteGem, gemSources, getGem, listGems, removeGemKnowledge, saveGem } from "../modules/gems.js";
import { deleteMemory, listMemories, memoryUrl, saveMemory, setMemoryUrl, testMemoryConnection } from "../modules/memory.js";
import { synthesize, transcribe, ttsBackend } from "../modules/speech.js";

const sendSchema = z.object({
  conversationId: z.string().optional(), text: z.string().default(""), parentId: z.string().nullable().optional(), regenerateOf: z.string().optional(),
  gemId: z.string().optional(), attachmentIds: z.array(z.string()).optional(), mode: z.string().optional(), think: z.boolean().optional(),
  allowCloud: z.boolean().optional(), forceRef: z.string().optional(), search: z.boolean().optional(), private: z.boolean().optional(),
});

export function registerChat(app: FastifyInstance) {
  app.get("/api/conversations", async (req) => ({ conversations: searchConvs(String((req.query as any).q ?? "")) }));
  app.post("/api/conversations", async (req) => { const b = z.object({ gemId: z.string().optional(), private: z.boolean().optional() }).parse(req.body ?? {}); return { conversation: createConv(b) }; });
  app.get("/api/conversations/:id", async (req) => {
    const id = (req.params as any).id;
    const conv = getConv(id); if (!conv) throw new HttpError(404, "Conversation not found.");
    return { conversation: conv, messages: listMessages(id), artifacts: artifactsFor(id) };
  });
  app.patch("/api/conversations/:id", async (req) => {
    const id = (req.params as any).id;
    const b = z.object({ title: z.string().optional(), leafId: z.string().optional(), private: z.boolean().optional() }).parse(req.body);
    const db = getDb();
    if (b.title !== undefined) db.prepare("UPDATE conversations SET title=? WHERE id=?").run(b.title.slice(0, 120), id);
    if (b.leafId) db.prepare("UPDATE conversations SET leaf_id=? WHERE id=?").run(b.leafId, id);
    if (b.private !== undefined) db.prepare("UPDATE conversations SET private=? WHERE id=?").run(b.private ? 1 : 0, id);
    return { conversation: getConv(id) };
  });
  app.delete("/api/conversations/:id", async (req) => { deleteConv((req.params as any).id); return { ok: true }; });

  app.post("/api/chat/send", async (req, reply) => {
    const body = sendSchema.parse(req.body);
    const sse = openSSE(req, reply);
    try { for await (const ev of chatTurn(body, sse.signal)) sse.send(ev.event, ev.data); }
    catch (e) { if (!sse.signal.aborted) { const f = friendlyError(e); sse.send("error", { message: f.message, fix: f.fix }); } }
    sse.end();
  });

  app.post("/api/attachments", async (req) => {
    const part = await (req as any).file();
    if (!part) throw new HttpError(400, "No file received.");
    const buf = await part.toBuffer();
    return { attachment: publicAttachment(await saveAttachment(part.filename, part.mimetype, buf)) };
  });
  app.get("/api/attachments/:id/raw", async (req, reply) => {
    const a = getAttachment((req.params as any).id); if (!a) throw new HttpError(404, "Attachment not found.");
    return reply.type(a.mime).send(fs.createReadStream(a.path));
  });
  app.get("/api/attachments/:id/text", async (req) => { const a = getAttachment((req.params as any).id); if (!a) throw new HttpError(404, "Attachment not found."); return { text: attachmentText(a) }; });

  // Gems
  app.get("/api/gems", async () => ({ gems: listGems() }));
  app.post("/api/gems", async (req) => {
    const b = z.object({ id: z.string().optional(), name: z.string().min(1), icon: z.string().optional(), instructions: z.string().optional(), pinned_model: z.string().nullable().optional(), lane: z.string().nullable().optional(), starters: z.array(z.string()).optional(), private: z.boolean().optional() }).parse(req.body);
    return { gem: saveGem(b as any) };
  });
  app.delete("/api/gems/:id", async (req) => { deleteGem((req.params as any).id); return { ok: true }; });
  app.get("/api/gems/:id/knowledge", async (req) => { const id = (req.params as any).id; if (!getGem(id)) throw new HttpError(404, "Gem not found."); return { sources: gemSources(id) }; });
  app.post("/api/gems/:id/knowledge", async (req) => {
    const id = (req.params as any).id; if (!getGem(id)) throw new HttpError(404, "Gem not found.");
    const part = await (req as any).file(); if (!part) throw new HttpError(400, "No file received.");
    const att = await saveAttachment(part.filename, part.mimetype, await part.toBuffer());
    const r = await addGemKnowledge(id, att.id);
    return { indexed: r, sources: gemSources(id) };
  });
  app.delete("/api/gems/:id/knowledge/:sourceId", async (req) => { const p = req.params as any; removeGemKnowledge(p.id, p.sourceId); return { sources: gemSources(p.id) }; });

  // Memories
  app.get("/api/memories", async () => ({ memories: listMemories(), memoryos: { url: memoryUrl() } }));
  app.post("/api/memories", async (req) => ({ memory: await saveMemory(z.object({ text: z.string().min(2) }).parse(req.body).text, "manual") }));
  app.delete("/api/memories/:id", async (req) => { deleteMemory((req.params as any).id); return { ok: true }; });
  app.put("/api/memories/memoryos", async (req) => { setMemoryUrl(z.object({ url: z.string() }).parse(req.body).url.trim()); return testMemoryConnection(); });
  app.post("/api/memories/memoryos/test", async () => testMemoryConnection());

  // Speech
  app.post("/api/stt", async (req) => {
    const part = await (req as any).file(); if (!part) throw new HttpError(400, "No audio received.");
    return transcribe(await part.toBuffer(), part.filename, part.mimetype);
  });
  app.post("/api/tts", async (req, reply) => {
    const b = z.object({ text: z.string().min(1), voice: z.enum(["host_a", "host_b"]).optional() }).parse(req.body);
    const r = await synthesize(b.text, b.voice);
    return reply.header("x-tts-backend", r.backend).type(r.mime).send(r.audio);
  });
  app.get("/api/tts/backend", async () => ({ backend: await ttsBackend() }));
}
addRoutes(registerChat);
