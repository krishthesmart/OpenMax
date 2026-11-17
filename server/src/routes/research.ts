import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db.js";
import { addRoutes } from "../app.js";
import { openSSE } from "../util/sse.js";
import { HttpError } from "../util/errors.js";
import { runResearch } from "../modules/research.js";

export function registerResearch(app: FastifyInstance) {
  app.post("/api/research", async (req, reply) => {
    const b = z.object({ query: z.string().min(2), deep: z.boolean().optional() }).parse(req.body);
    const sse = openSSE(req, reply);
    for await (const ev of runResearch({ ...b, signal: sse.signal })) sse.send(ev.event, ev.data);
    sse.end();
  });
  app.get("/api/research", async () => ({ items: getDb().prepare("SELECT id, query, deep, model, created_at FROM research ORDER BY created_at DESC LIMIT 100").all() }));
  app.get("/api/research/:id", async (req) => {
    const r = getDb().prepare("SELECT * FROM research WHERE id=?").get((req.params as any).id) as any;
    if (!r) throw new HttpError(404, "Research not found.");
    return { ...r, deep: !!r.deep, sources: JSON.parse(r.sources), steps: JSON.parse(r.steps), followups: JSON.parse(r.followups) };
  });
  app.delete("/api/research/:id", async (req) => { getDb().prepare("DELETE FROM research WHERE id=?").run((req.params as any).id); return { ok: true }; });
}
addRoutes(registerResearch);
