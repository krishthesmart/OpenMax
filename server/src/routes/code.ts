import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addRoutes } from "../app.js";
import { openSSE } from "../util/sse.js";
import { friendlyError } from "../util/errors.js";
import { deletePath, listTree, outline, readFile, workspaceRoot, writeFile } from "../modules/workspace.js";
import { ACTIONS, parseFileBlock, proseOutside, runCodeAction } from "../modules/codeActions.js";

export function registerCode(app: FastifyInstance) {
  app.get("/api/code/tree", async () => { const root = workspaceRoot(); return { root, tree: listTree(root) }; });
  app.get("/api/code/file", async (req) => readFile(workspaceRoot(), String((req.query as any).path ?? "")));
  app.put("/api/code/file", async (req) => { const b = z.object({ path: z.string().min(1), content: z.string() }).parse(req.body); writeFile(workspaceRoot(), b.path, b.content); return { ok: true }; });
  app.post("/api/code/delete", async (req) => { const b = z.object({ path: z.string().min(1), confirm: z.boolean().optional() }).parse(req.body); deletePath(workspaceRoot(), b.path, b.confirm === true); return { ok: true }; });
  app.post("/api/code/action", async (req, reply) => {
    const b = z.object({ action: z.enum(ACTIONS), path: z.string().min(1), content: z.string().optional(), instruction: z.string().optional(), selection: z.string().optional(), mode: z.string().optional(), localOnly: z.boolean().optional() }).parse(req.body);
    const root = workspaceRoot();
    const content = b.content ?? readFile(root, b.path).content;
    const sse = openSSE(req, reply);
    let text = "";
    try {
      for await (const ev of runCodeAction({ ...b, content, outline: outline(root), signal: sse.signal })) {
        if (ev.type === "route") sse.send("route", ev.info);
        else if (ev.type === "text") { text += ev.text; sse.send("text", { text: ev.text }); }
      }
      const block = b.action === "explain" ? undefined : parseFileBlock(text);
      sse.send("result", { original: content, file: block ? { path: block.path ?? b.path, content: block.content } : null, prose: block ? proseOutside(text) : text });
    } catch (e) { if (!sse.signal.aborted) { const f = friendlyError(e); sse.send("error", { message: f.message, fix: f.fix }); } }
    sse.end();
  });
}
addRoutes(registerCode);
