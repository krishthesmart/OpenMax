import fs from "node:fs";
import path from "node:path";
import { getDb, now, uid } from "../../db.js";
import { safeResolve } from "../workspace.js";

export interface Deliverable { id: string; run_id: string; title: string; path: string; kind: "file" | "site"; mime: string; size: number; created_at: number }
const MIME: Record<string, string> = { html: "text/html", htm: "text/html", md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", zip: "application/zip", css: "text/css", js: "text/javascript", mjs: "text/javascript", wasm: "application/wasm",
  mp3: "audio/mpeg", wav: "audio/wav", mp4: "video/mp4", webm: "video/webm", py: "text/plain", ts: "text/plain", xml: "application/xml", yml: "text/plain", yaml: "text/plain" };
export const mimeFor = (file: string) => MIME[path.extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";

/** Register a file (or a folder containing index.html, treated as a small website) from the run's workspace as a deliverable. */
export function registerDeliverable(runId: string, workspace: string, rel: string, title?: string): Deliverable {
  const abs = safeResolve(workspace, rel);
  if (!fs.existsSync(abs)) throw new Error(`"${rel}" does not exist in the workspace.`);
  const st = fs.statSync(abs);
  if (st.isDirectory() && !fs.existsSync(path.join(abs, "index.html"))) throw new Error(`"${rel}" is a folder without an index.html, so it cannot be previewed as a website. Deliver individual files instead.`);
  const existing = getDb().prepare("SELECT * FROM deliverables WHERE run_id=? AND path=?").get(runId, abs) as Deliverable | undefined;
  const kind = st.isDirectory() ? "site" : "file", mime = st.isDirectory() ? "text/html" : mimeFor(abs);
  const size = st.isDirectory() ? dirSize(abs) : st.size;
  if (existing) { getDb().prepare("UPDATE deliverables SET size=?, title=COALESCE(?, title) WHERE id=?").run(size, title ?? null, existing.id); return getDeliverable(existing.id)!; }
  const id = uid("dl_");
  getDb().prepare("INSERT INTO deliverables(id,run_id,title,path,kind,mime,size,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, runId, (title ?? path.basename(abs)).slice(0, 120), abs, kind, mime, size, now());
  return getDeliverable(id)!;
}
function dirSize(d: string): number { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } return n; }
export const getDeliverable = (id: string) => getDb().prepare("SELECT * FROM deliverables WHERE id=?").get(id) as Deliverable | undefined;
export const listDeliverables = (runId: string) => getDb().prepare("SELECT * FROM deliverables WHERE run_id=? ORDER BY created_at").all(runId) as Deliverable[];

/** Resolve a request path inside a deliverable (the file itself, or a path inside a site folder); never outside it. */
export function resolveDeliverable(d: Deliverable, sub?: string): { file: string; mime: string } | undefined {
  if (d.kind === "file") { if (sub && sub !== path.basename(d.path)) return undefined; return fs.existsSync(d.path) ? { file: d.path, mime: d.mime } : undefined; }
  let target: string;
  try { target = safeResolve(d.path, sub && sub !== "" ? sub : "index.html"); } catch { return undefined; }
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
  return fs.existsSync(target) && fs.statSync(target).isFile() ? { file: target, mime: mimeFor(target) } : undefined;
}
