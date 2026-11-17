import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fs from "node:fs";
import path from "node:path";
import { ROOT, cfg } from "./config.js";
import { openDb } from "./db.js";
import { friendlyError, HttpError } from "./util/errors.js";
import { registerHealth } from "./routes/health.js";
import { PUBLIC_API, checkPassword, isAuthorized, sessionCookie } from "./util/auth.js";

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
  // Optional single-user password (OPENMAX_PASSWORD): Bearer header for scripts, HttpOnly cookie for the browser UI.
  app.addHook("onRequest", async (req, reply) => {
    const pw = cfg.OPENMAX_PASSWORD; const url = req.url.split("?")[0]!;
    if (!pw || !url.startsWith("/api/") || PUBLIC_API.has(url)) return;
    if (!isAuthorized(pw, req.headers)) return reply.code(401).send({ error: "Sign in required.", fix: "Enter the OPENMAX_PASSWORD from your .env." });
  });
  app.post("/api/login", async (req, reply) => {
    const pw = cfg.OPENMAX_PASSWORD;
    if (!pw) return { ok: true, required: false };
    const given = String((req.body as any)?.password ?? "");
    if (!checkPassword(pw, given)) { await new Promise((r) => setTimeout(r, 400)); return reply.code(401).send({ error: "Wrong password." }); }
    reply.header("set-cookie", sessionCookie(pw)); return { ok: true, required: true };
  });
  app.get("/api/auth/status", async (req) => ({ required: !!cfg.OPENMAX_PASSWORD, authed: isAuthorized(cfg.OPENMAX_PASSWORD, req.headers) }));
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/vendor/")) reply.header("access-control-allow-origin", "*"); // sandboxed artifact iframes load React from here
    return payload;
  });
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
