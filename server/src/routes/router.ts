import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db.js";
import { getRouterConfig, setRouterConfig, allRefs, TASKS, RouterConfigSchema } from "../router/config.js";
import { classify } from "../router/router.js";
import { selectCandidates } from "../router/lanes.js";
import { isLocalOnly, privacyReason } from "../router/privacy.js";
import { estimateTokens } from "../router/classify.js";
import { getRefStatuses, suggestLanes } from "../providers/discovery.js";
import { cooldownRemaining } from "../providers/limits.js";
import { addRoutes } from "../app.js";

export function routerStats() {
  const db = getDb();
  const byTask = db.prepare(`SELECT task, COUNT(*) requests, SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) ok,
      ROUND(AVG(CASE WHEN error IS NULL THEN latency_ms END)) avg_latency, ROUND(AVG(CASE WHEN tps>0 THEN tps END),1) avg_tps,
      SUM(CASE WHEN rating>0 THEN 1 ELSE 0 END) up, SUM(CASE WHEN rating<0 THEN 1 ELSE 0 END) down
      FROM route_log GROUP BY task ORDER BY requests DESC`).all();
  const rows = db.prepare("SELECT task, model, error, fallbacks, latency_ms, rating FROM route_log").all() as any[];
  const per = new Map<string, { task: string; model: string; wins: number; failures: number; r429: number; lat: number[]; up: number; down: number }>();
  const get = (task: string, model: string) => { const k = `${task}|${model}`; let v = per.get(k); if (!v) { v = { task, model, wins: 0, failures: 0, r429: 0, lat: [], up: 0, down: 0 }; per.set(k, v); } return v; };
  for (const r of rows) {
    if (r.model && !r.error) { const v = get(r.task, r.model); v.wins++; v.lat.push(r.latency_ms ?? 0); if (r.rating > 0) v.up++; if (r.rating < 0) v.down++; }
    let fb: any[] = []; try { fb = JSON.parse(r.fallbacks ?? "[]"); } catch { /* ignore */ }
    for (const f of fb) { const v = get(r.task, f.ref); v.failures++; if (f.status === 429 || /cooling|429/.test(f.error ?? "")) v.r429++; }
  }
  const byModel = [...per.values()].map((v) => {
    const attempts = v.wins + v.failures;
    return { task: v.task, model: v.model, wins: v.wins, failures: v.failures, r429: v.r429, winRate: attempts ? Math.round((v.wins / attempts) * 100) : 0, avgLatency: v.lat.length ? Math.round(v.lat.reduce((a, b) => a + b, 0) / v.lat.length) : null, up: v.up, down: v.down };
  }).sort((a, b) => a.task.localeCompare(b.task) || b.wins - a.wins);
  const recent = db.prepare("SELECT id, ts, task, model, mode, confidence, source, latency_ms, tps, error, rating FROM route_log ORDER BY id DESC LIMIT 30").all();
  return { byTask, byModel, recent };
}

export function registerRouter(app: FastifyInstance) {
  app.get("/api/router/config", async () => ({
    config: getRouterConfig(), tasks: TASKS, statuses: getRefStatuses(), refs: allRefs(), suggestions: suggestLanes(),
    cooldowns: Object.fromEntries([...new Set(allRefs().map((r) => r.split(":")[0]!))].map((p) => [p, cooldownRemaining(p)])),
  }));
  app.put("/api/router/config", async (req) => {
    const parsed = RouterConfigSchema.parse(req.body);
    return { config: setRouterConfig(parsed) };
  });
  app.post("/api/router/explain", async (req) => {
    const b = z.object({ text: z.string(), attachments: z.array(z.enum(["image", "pdf", "audio", "video", "text"])).optional(), mode: z.string().optional(), private: z.boolean().optional(), allowCloud: z.boolean().optional() }).parse(req.body);
    const messages = [{ role: "user" as const, content: b.text }];
    const c = await classify({ messages, attachmentKinds: b.attachments, private: b.private, allowCloud: b.allowCloud });
    const localOnly = isLocalOnly({ private: b.private, allowCloud: b.allowCloud, hasAttachments: (b.attachments?.length ?? 0) > 0 });
    const sel = selectCandidates({ task: c.task, mode: b.mode ?? "auto", localOnly, preferTools: c.task === "agentic" });
    return { classification: c, tokens: estimateTokens(b.text), localOnly, privacy: privacyReason({ private: b.private, hasAttachments: (b.attachments?.length ?? 0) > 0, allowCloud: b.allowCloud }), chosen: sel.candidates[0]?.ref ?? null, candidates: sel.candidates, skipped: sel.skipped };
  });
  app.get("/api/router/stats", async () => routerStats());
  app.post("/api/router/rate", async (req) => {
    const b = z.object({ id: z.number(), rating: z.number().min(-1).max(1) }).parse(req.body);
    getDb().prepare("UPDATE route_log SET rating=? WHERE id=?").run(b.rating, b.id);
    return { ok: true };
  });
}
addRoutes(registerRouter);
