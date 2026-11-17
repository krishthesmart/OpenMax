import type { FastifyInstance } from "fastify";
import { addRoutes } from "../app.js";
import { getRouterConfig } from "../router/config.js";
import { thinkCandidates, estimateThink } from "../modules/think.js";
import { paidAllowed } from "../router/usage.js";
import { isLocalOnly } from "../router/privacy.js";

export function registerThink(app: FastifyInstance) {
  /** Estimated time shown before running Think, from this machine's own recent latencies. */
  app.get("/api/think/estimate", async (req) => {
    const q = req.query as any; const localOnly = isLocalOnly({ private: q.private === "1", hasAttachments: q.attachments === "1" });
    const cands = thinkCandidates({ short: q.short === "1", localOnly, paid: paidAllowed() });
    const est = estimateThink({ candidates: cands.length === 1 ? [cands[0]!, cands[0]!] : cands, judge: getRouterConfig().judge[0] });
    return { candidates: cands, ...est };
  });
}
addRoutes(registerThink);
