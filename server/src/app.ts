import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fs from "node:fs";
import path from "node:path";
import { ROOT, cfg } from "./config.js";
import { openDb } from "./db.js";
import { friendlyError, HttpError } from "./util/errors.js";
import { registerHealth } from "./routes/health.js";

export type Registrar = (app: FastifyInstance) => void | Promise<void>;
const registrars: Registrar[] = [registerHealth];
export const addRoutes = (r: Registrar) => { registrars.push(r); };

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  openDb();
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 * 1024 });
  await app.register(fastifyMultipart, { limits: { fileSize: 200 * 1024 * 1024 } });
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, fix: err.fix });
    if (err?.validation || err?.name === "ZodError") return reply.code(400).send({ error: "Invalid request.", fix: err.issues?.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") ?? err.message });
    const f = friendlyError(err);
    reply.code(f.status && f.status >= 400 && f.status < 600 ? f.status : 500).send({ error: f.message, fix: f.fix });
  });
  if (cfg.OPENMAX_PASSWORD) {
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/api/") || req.url === "/api/health") return;
      const h = req.headers.authorization ?? "";
      if (h !== `Bearer ${cfg.OPENMAX_PASSWORD}`) reply.code(401).send({ error: "Unauthorized", fix: "Send Authorization: Bearer <OPENMAX_PASSWORD>." });
    });
  }
  for (const r of registrars) await r(app);
  const webDist = path.join(ROOT, "web", "dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}
