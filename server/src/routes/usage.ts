import type { FastifyInstance } from "fastify";
import { addRoutes } from "../app.js";
import { usageReport } from "../modules/meter.js";

export function registerUsage(app: FastifyInstance) {
  app.get("/api/usage", async (req) => { const r = String((req.query as any).range ?? "month"); return usageReport(r === "day" || r === "all" ? r : "month"); });
}
addRoutes(registerUsage);
