import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addRoutes } from "../app.js";
import { HttpError } from "../util/errors.js";
import { TONES, createCanvas, deleteCanvas, editWithInstruction, getCanvas, getVersion, listCanvases, listVersions, restoreVersion, saveContent, suggest, transform, updateMeta } from "../modules/canvas/canvas.js";
import { applyPatch, parseOps } from "../shared/patch.js";
import { saveVersion } from "../modules/canvas/canvas.js";

const must = (id: string) => { const c = getCanvas(id); if (!c) throw new HttpError(404, "Canvas not found."); return c; };
const common = z.object({ selection: z.string().optional(), localOnly: z.boolean().optional() });

export function registerCanvas(app: FastifyInstance) {
  app.get("/api/canvas", async () => ({ canvases: listCanvases() }));
  app.post("/api/canvas", async (req) => ({ canvas: createCanvas(z.object({ title: z.string().optional(), kind: z.string().optional(), content: z.string().optional() }).parse(req.body ?? {})) }));
  app.get("/api/canvas/:id", async (req) => { const c = must((req.params as any).id); return { canvas: c, versions: listVersions(c.id) }; });
  app.patch("/api/canvas/:id", async (req) => { const id = (req.params as any).id; must(id); updateMeta(id, z.object({ title: z.string().optional(), kind: z.string().optional() }).parse(req.body)); return { canvas: getCanvas(id) }; });
  app.put("/api/canvas/:id", async (req) => { const id = (req.params as any).id; const b = z.object({ content: z.string(), note: z.string().optional() }).parse(req.body); return { canvas: saveContent(id, b.content, b.note), versions: listVersions(id) }; });
  app.delete("/api/canvas/:id", async (req) => { deleteCanvas((req.params as any).id); return { ok: true }; });
  app.get("/api/canvas/:id/versions/:v", async (req) => { const p = req.params as any; const v = getVersion(p.id, Number(p.v)); if (!v) throw new HttpError(404, "Version not found."); return { version: v }; });
  app.post("/api/canvas/:id/restore", async (req) => { const id = (req.params as any).id; const c = restoreVersion(id, z.object({ version: z.number().int() }).parse(req.body).version); return { canvas: c, versions: listVersions(id) }; });
  /** Apply explicit ops (e.g. accepting an inline suggestion). Atomic: errors leave the document untouched. */
  app.post("/api/canvas/:id/patch", async (req, reply) => {
    const id = (req.params as any).id; const c = must(id);
    const b = z.object({ ops: z.array(z.any()), note: z.string().optional() }).parse(req.body);
    const { ops, dropped } = parseOps(b.ops);
    const r = applyPatch(c.content, ops);
    if (!r.ok || dropped.length) return reply.code(409).send({ error: "The edit could not be applied.", fix: [...dropped, ...r.errors].join("; ") });
    if (r.content !== c.content) saveVersion(id, r.content, b.note ?? "Patch");
    return { canvas: getCanvas(id), versions: listVersions(id) };
  });
  app.post("/api/canvas/:id/edit", async (req) => { const id = (req.params as any).id; must(id); const b = common.extend({ instruction: z.string().min(2) }).parse(req.body); const r = await editWithInstruction(id, b.instruction, b); return { ...r, versions: listVersions(id) }; });
  app.post("/api/canvas/:id/suggest", async (req) => { const id = (req.params as any).id; must(id); const b = common.extend({ instruction: z.string().default("") }).parse(req.body); return { suggestions: await suggest(id, b.instruction, b) }; });
  app.post("/api/canvas/:id/transform", async (req) => {
    const id = (req.params as any).id; must(id);
    const b = common.extend({ kind: z.enum(["shorter", "longer", "tone", "reading_level"]), tone: z.enum(TONES).optional(), level: z.string().optional() }).parse(req.body);
    const action = b.kind === "tone" ? { kind: "tone" as const, tone: b.tone ?? "formal" } : b.kind === "reading_level" ? { kind: "reading_level" as const, level: b.level ?? "general audience" } : { kind: b.kind };
    return { canvas: await transform(id, action, b), versions: listVersions(id) };
  });
}
addRoutes(registerCanvas);
