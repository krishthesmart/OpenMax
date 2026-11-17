import { getDb, now, uid } from "../../db.js";
import { routedComplete, routedJSON } from "../../router/router.js";
import { applyPatch, parseOps, type PatchOp } from "../../shared/patch.js";
import type { Message } from "../../providers/types.js";

export type CanvasKind = "markdown" | "code" | "html" | "react" | "svg";
export interface Canvas { id: string; title: string; kind: CanvasKind; lang?: string; updated_at: number; version: number; content: string }
const KINDS = ["markdown", "code", "html", "react", "svg"];

export function createCanvas(o: { title?: string; kind?: string; content?: string; conversationId?: string }): Canvas {
  const id = uid("cv_"); const kind = KINDS.includes(o.kind ?? "") ? o.kind! : "markdown";
  getDb().prepare("INSERT INTO canvases(id,title,kind,conversation_id,updated_at) VALUES(?,?,?,?,?)").run(id, (o.title ?? "Untitled").slice(0, 120), kind, o.conversationId ?? null, now());
  saveVersion(id, o.content ?? "", "Created");
  return getCanvas(id)!;
}
export function saveVersion(id: string, content: string, note: string): number {
  const last = getDb().prepare("SELECT MAX(version) v FROM canvas_versions WHERE canvas_id=?").get(id) as { v: number | null };
  const v = (last.v ?? 0) + 1;
  getDb().prepare("INSERT INTO canvas_versions(canvas_id,version,content,note,created_at) VALUES(?,?,?,?,?)").run(id, v, content, note, now());
  getDb().prepare("UPDATE canvases SET updated_at=? WHERE id=?").run(now(), id);
  return v;
}
export function getCanvas(id: string): Canvas | undefined {
  const c = getDb().prepare("SELECT * FROM canvases WHERE id=?").get(id) as any; if (!c) return undefined;
  const v = getDb().prepare("SELECT version, content FROM canvas_versions WHERE canvas_id=? ORDER BY version DESC LIMIT 1").get(id) as any;
  return { id: c.id, title: c.title, kind: c.kind, updated_at: c.updated_at, version: v?.version ?? 0, content: v?.content ?? "" };
}
export const listCanvases = () => getDb().prepare("SELECT id,title,kind,updated_at FROM canvases ORDER BY updated_at DESC").all();
export const listVersions = (id: string) => getDb().prepare("SELECT version, note, created_at, length(content) chars FROM canvas_versions WHERE canvas_id=? ORDER BY version DESC").all(id);
export const getVersion = (id: string, v: number) => getDb().prepare("SELECT version, content, note, created_at FROM canvas_versions WHERE canvas_id=? AND version=?").get(id, v) as any;
export function deleteCanvas(id: string) { getDb().prepare("DELETE FROM canvas_versions WHERE canvas_id=?").run(id); getDb().prepare("DELETE FROM canvases WHERE id=?").run(id); }
export function updateMeta(id: string, p: { title?: string; kind?: string }) {
  if (p.title !== undefined) getDb().prepare("UPDATE canvases SET title=? WHERE id=?").run(p.title.slice(0, 120), id);
  if (p.kind && KINDS.includes(p.kind)) getDb().prepare("UPDATE canvases SET kind=? WHERE id=?").run(p.kind, id);
}
/** Manual save: only creates a version when the content actually changed. */
export function saveContent(id: string, content: string, note = "Manual edit"): Canvas {
  const c = getCanvas(id); if (!c) throw Object.assign(new Error("Canvas not found."), { status: 404 });
  if (c.content !== content) saveVersion(id, content, note);
  return getCanvas(id)!;
}
export function restoreVersion(id: string, version: number): Canvas {
  const v = getVersion(id, version); if (!v) throw Object.assign(new Error("Version not found."), { status: 404 });
  saveVersion(id, v.content, `Restored v${version}`);
  return getCanvas(id)!;
}

const OPS_DOC = `Edit operations (JSON): {"op":"replace","find":"exact existing text","replace":"new text","all":false} · {"op":"insert_after"|"insert_before","anchor":"exact existing text","text":"..."} · {"op":"delete","find":"exact existing text"} · {"op":"replace_lines","start":1,"end":3,"text":"..."} (1-based, inclusive) · {"op":"append","text":"..."} · {"op":"set","text":"full new document"}.
"find"/"anchor" must match the document EXACTLY (including whitespace) and be unique: include enough surrounding text. Prefer small targeted ops over "set". Use "set" only when most of the document changes.`;

export interface EditResult { canvas: Canvas; ops: PatchOp[]; summary: string; attempts: number; changed: boolean }

/** Chat-driven edit: the model returns structured ops; they are applied atomically; failures are fed back once for a retry. */
export async function editWithInstruction(id: string, instruction: string, o: { selection?: string; localOnly?: boolean; signal?: AbortSignal } = {}): Promise<EditResult> {
  const c = getCanvas(id); if (!c) throw Object.assign(new Error("Canvas not found."), { status: 404 });
  const base: Message[] = [
    { role: "system" as const, content: `You edit a ${c.kind} document ("${c.title}") for the user. ${OPS_DOC}\nReply with ONLY JSON: {"summary":"one short sentence about what you changed","ops":[...]}.` },
    { role: "user" as const, content: `Document:\n<<<\n${c.content}\n>>>\n${o.selection ? `Selected text (the instruction is about this):\n<<<\n${o.selection}\n>>>\n` : ""}Instruction: ${instruction}` },
  ];
  let messages: Message[] = base; let last: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { value } = await routedJSON<any>({ task: c.kind === "markdown" ? "creative" : "code", private: o.localOnly, purpose: "canvas-edit", signal: o.signal, temperature: 0.2, maxTokens: 6000, messages });
    const { ops, dropped } = parseOps(value);
    const res = applyPatch(c.content, ops);
    if (ops.length && res.ok) {
      const note = String(value.summary ?? instruction).slice(0, 140);
      if (res.content === c.content) return { canvas: c, ops, summary: "No change was needed.", attempts: attempt, changed: false };
      saveVersion(id, res.content, note);
      return { canvas: getCanvas(id)!, ops, summary: note, attempts: attempt, changed: true };
    }
    last = [...dropped, ...res.errors, ...(ops.length ? [] : ["no valid operations returned"])];
    messages = [...base, { role: "assistant", content: JSON.stringify(value) }, { role: "user", content: `Those operations could not be applied: ${last.join("; ")}. Return corrected JSON (the document is unchanged).` }];
  }
  // Structured ops failed twice (common with small models): fall back to asking for the complete revised document.
  try {
    const r = await routedComplete({ task: c.kind === "markdown" ? "creative" : "code", private: o.localOnly, purpose: "canvas-rewrite", signal: o.signal, temperature: 0.2, maxTokens: 6000, messages: [
      { role: "system", content: `You edit a ${c.kind} document. Apply the user's instruction and output ONLY the complete revised document, with no commentary and no code fences. Change nothing else.` },
      { role: "user", content: `Document:\n${c.content}\n\nInstruction: ${instruction}` },
    ] });
    const out = r.text.replace(/^```[\w-]*\n/, "").replace(/\n```\s*$/, "").trim();
    const lenOk = out.length > 0 && out.length > c.content.length * 0.4 && out.length < c.content.length * 3 + 400;
    if (lenOk) {
      const next = out + (c.content.endsWith("\n") && !out.endsWith("\n") ? "\n" : "");
      if (next === c.content) return { canvas: c, ops: [], summary: "No change was needed.", attempts: 3, changed: false };
      saveVersion(id, next, `Rewrite: ${instruction}`.slice(0, 140));
      return { canvas: getCanvas(id)!, ops: [{ op: "set", text: next }], summary: "Rewrote the document (structured edits were not usable).", attempts: 3, changed: true };
    }
  } catch (e: any) { if (e?.name === "AbortError") throw e; }
  throw Object.assign(new Error(`The model's edits could not be applied: ${last.slice(0, 2).join("; ")}.`), { fix: "Try a more specific instruction, or select the text you want changed.", status: 422 });
}

export interface Suggestion { find: string; replace: string; why: string }
export function validateSuggestions(content: string, v: any): Suggestion[] {
  const arr: any[] = Array.isArray(v?.suggestions) ? v.suggestions : Array.isArray(v) ? v : [];
  return arr.map((s) => ({ find: String(s?.find ?? ""), replace: String(s?.replace ?? ""), why: String(s?.why ?? "").slice(0, 200) }))
    .filter((s) => s.find && s.find !== s.replace && content.split(s.find).length === 2).slice(0, 12);
}
/** Inline suggestions: nothing is applied; each suggestion is accepted or rejected by the user. */
export async function suggest(id: string, instruction: string, o: { selection?: string; localOnly?: boolean; signal?: AbortSignal } = {}): Promise<Suggestion[]> {
  const c = getCanvas(id); if (!c) throw Object.assign(new Error("Canvas not found."), { status: 404 });
  const { value } = await routedJSON<any>({ task: c.kind === "markdown" ? "creative" : "code", private: o.localOnly, purpose: "canvas-suggest", signal: o.signal, temperature: 0.4, maxTokens: 3000, messages: [
    { role: "system", content: `You review a ${c.kind} document and propose improvements as inline suggestions. Each suggestion replaces an EXACT, UNIQUE passage of the document. Reply with ONLY JSON {"suggestions":[{"find":"exact existing text","replace":"improved text","why":"short reason"}]}. Give at most 8, most valuable first.` },
    { role: "user", content: `Document:\n<<<\n${c.content}\n>>>\n${o.selection ? `Focus on this selection:\n<<<\n${o.selection}\n>>>\n` : ""}${instruction ? `Goal: ${instruction}` : "Goal: improve clarity, correctness and style."}` },
  ] });
  return validateSuggestions(c.content, value);
}

export const TONES = ["formal", "casual", "friendly", "persuasive", "technical", "concise"] as const;
export type TransformAction = { kind: "shorter" } | { kind: "longer" } | { kind: "tone"; tone: (typeof TONES)[number] } | { kind: "reading_level"; level: string };
/** Length / tone controls rewrite the selection (or the whole document) and save a new version. */
export async function transform(id: string, action: TransformAction, o: { selection?: string; localOnly?: boolean; signal?: AbortSignal } = {}): Promise<Canvas> {
  const c = getCanvas(id); if (!c) throw Object.assign(new Error("Canvas not found."), { status: 404 });
  const target = o.selection && c.content.split(o.selection).length === 2 ? o.selection : c.content;
  const how = action.kind === "shorter" ? "Make it about half as long: keep every key point, cut filler." : action.kind === "longer" ? "Expand it to roughly twice the length with useful detail and examples; keep the same structure." : action.kind === "tone" ? `Rewrite in a ${action.tone} tone; keep the meaning and structure.` : `Rewrite for a ${action.level} reading level; keep the meaning.`;
  const r = await routedComplete({ task: "creative", private: o.localOnly, purpose: "canvas-transform", signal: o.signal, temperature: 0.5, maxTokens: 6000, messages: [
    { role: "system", content: `You rewrite text. ${how} Keep the ${c.kind === "markdown" ? "Markdown" : c.kind} format. Output ONLY the rewritten text, no commentary and no code fences.` },
    { role: "user", content: target },
  ] });
  const out = r.text.replace(/^```[\w-]*\n/, "").replace(/\n```$/, "");
  if (!out.trim()) throw new Error("The model returned nothing. Try again.");
  const next = target === c.content ? out : c.content.replace(target, () => out);
  const label = action.kind === "tone" ? `Tone: ${action.tone}` : action.kind === "reading_level" ? `Reading level: ${action.level}` : `Made ${action.kind}${target !== c.content ? " (selection)" : ""}`;
  saveVersion(id, next, label);
  return getCanvas(id)!;
}
