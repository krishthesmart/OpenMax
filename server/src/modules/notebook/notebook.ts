import { getDb, now, uid } from "../../db.js";
import { cfg } from "../../config.js";
import { runRouted, type RouteInfo } from "../../router/router.js";
import { attachmentText, getAttachment } from "../attachments.js";
import { fetchPage } from "../search.js";
import { deleteSource, formatContext, indexText, retrieve } from "../rag.js";
import { fetchTranscript, youtubeId } from "./youtube.js";
import { locatePassage } from "./locate.js";
import { stripInvalidCites } from "../../shared/cite.js";
import type { Message } from "../../providers/types.js";

export interface Notebook { id: string; title: string; private: boolean; created_at: number }
export interface NbSource { id: string; notebook_id: string; kind: string; name: string; url: string | null; chars: number; created_at: number }
const nb = (r: any): Notebook => ({ ...r, private: !!r.private });
export const listNotebooks = () => (getDb().prepare("SELECT * FROM notebooks ORDER BY created_at DESC").all() as any[]).map(nb);
export const getNotebook = (id: string) => { const r = getDb().prepare("SELECT * FROM notebooks WHERE id=?").get(id); return r ? nb(r) : undefined; };
export function createNotebook(title: string, isPrivate = false): Notebook {
  const id = uid("n_"); getDb().prepare("INSERT INTO notebooks(id,title,private,created_at) VALUES(?,?,?,?)").run(id, title.slice(0, 120) || "Untitled notebook", isPrivate ? 1 : 0, now()); return getNotebook(id)!;
}
export function updateNotebook(id: string, p: { title?: string; private?: boolean }) {
  if (p.title !== undefined) getDb().prepare("UPDATE notebooks SET title=? WHERE id=?").run(p.title.slice(0, 120), id);
  if (p.private !== undefined) getDb().prepare("UPDATE notebooks SET private=? WHERE id=?").run(p.private ? 1 : 0, id);
  return getNotebook(id)!;
}
export function deleteNotebook(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM chunks WHERE owner_kind='notebook' AND owner_id=?").run(id);
  for (const t of ["notebook_sources", "notebook_outputs", "cards"]) db.prepare(`DELETE FROM ${t} WHERE notebook_id=?`).run(id);
  db.prepare("DELETE FROM notebooks WHERE id=?").run(id);
}
export const listSources = (nid: string): NbSource[] => getDb().prepare("SELECT id,notebook_id,kind,name,url,length(text) chars,created_at FROM notebook_sources WHERE notebook_id=? ORDER BY created_at").all(nid) as NbSource[];
export const getSourceText = (nid: string, sid: string) => getDb().prepare("SELECT * FROM notebook_sources WHERE id=? AND notebook_id=?").get(sid, nid) as { id: string; name: string; kind: string; url: string | null; text: string } | undefined;

export async function addSource(nid: string, s: { kind: "pdf" | "url" | "text" | "youtube" | "file"; name?: string; url?: string; text?: string; attachmentId?: string }): Promise<NbSource> {
  const book = getNotebook(nid); if (!book) throw Object.assign(new Error("Notebook not found."), { status: 404 });
  let name = s.name ?? "Untitled", text = s.text ?? "", url = s.url ?? null, kind: string = s.kind;
  if (s.kind === "pdf" || s.kind === "file") {
    const a = s.attachmentId ? getAttachment(s.attachmentId) : undefined;
    if (!a) throw new Error("Upload the file first.");
    text = attachmentText(a); name = s.name ?? a.name; kind = a.kind === "pdf" ? "pdf" : "file";
    if (!text) throw Object.assign(new Error(a.note ?? "No readable text in that file."), { fix: "For scanned PDFs, install poppler (brew install poppler) or paste the text." });
  } else if (s.kind === "url") {
    if (!s.url) throw new Error("Enter a URL.");
    if (youtubeId(s.url)) { const t = await fetchTranscript(s.url); name = t.title; text = t.text; kind = "youtube"; }
    else { const p = await fetchPage(s.url, { maxChars: 400_000 }); name = s.name ?? (p.title || s.url); text = p.text; }
  } else if (s.kind === "youtube") {
    if (cfg.OPENMAX_STUB) { name = "YouTube (stub)"; text = s.text ?? "stub transcript"; } else { const t = await fetchTranscript(s.url ?? ""); name = t.title; text = t.text; }
  }
  text = text.trim();
  if (text.length < 20) throw Object.assign(new Error("That source has almost no text."), { fix: "Try a different page, or paste the text directly." });
  const id = uid("ns_");
  getDb().prepare("INSERT INTO notebook_sources(id,notebook_id,kind,name,url,text,created_at) VALUES(?,?,?,?,?,?,?)").run(id, nid, kind, name.slice(0, 200), url, text, now());
  await indexText({ kind: "notebook", id: nid }, { id, name }, text, { localOnly: book.private });
  return listSources(nid).find((x) => x.id === id)!;
}
export function removeSource(nid: string, sid: string) { deleteSource("notebook", nid, sid); getDb().prepare("DELETE FROM notebook_sources WHERE id=? AND notebook_id=?").run(sid, nid); }

export interface NbCitation { n: number; sourceId: string; source: string; text: string; start?: number; end?: number }
export function buildCitations(nid: string, hits: Awaited<ReturnType<typeof retrieve>>): NbCitation[] {
  return hits.map((h, i) => {
    const src = h.sourceId ? getSourceText(nid, h.sourceId) : undefined;
    const loc = src ? locatePassage(src.text, h.text) : undefined;
    return { n: i + 1, sourceId: h.sourceId ?? "", source: h.sourceName ?? "source", text: h.text, start: loc?.start, end: loc?.end };
  });
}

export const NOT_IN_SOURCES = "I can't find that in your sources. Add a source that covers it, or ask about what's in them.";
export const GROUNDED_SYSTEM = `You answer questions using ONLY the numbered source excerpts provided. Rules: (1) every claim must be supported by an excerpt and cited like [1] or [2][3]; (2) if the excerpts do not contain the answer, reply exactly: "${NOT_IN_SOURCES}"; (3) never use outside knowledge, never invent a citation number; (4) quote sparingly and keep answers focused.`;

export async function* notebookChat(o: { notebookId: string; question: string; history?: { role: "user" | "assistant"; content: string }[]; allowCloud?: boolean; signal?: AbortSignal }): AsyncGenerator<{ event: string; data: any }> {
  const book = getNotebook(o.notebookId); if (!book) throw Object.assign(new Error("Notebook not found."), { status: 404 });
  const hits = await retrieve({ kind: "notebook", id: o.notebookId }, o.question, 8, { localOnly: book.private });
  if (!hits.length) { yield { event: "text", data: { text: NOT_IN_SOURCES } }; yield { event: "done", data: { text: NOT_IN_SOURCES, citations: [], grounded: false } }; return; }
  const citations = buildCitations(o.notebookId, hits);
  yield { event: "sources", data: citations };
  const { context } = formatContext(hits);
  const messages: Message[] = [{ role: "system", content: `${GROUNDED_SYSTEM}\n\nSOURCE EXCERPTS:\n${context}` }, ...(o.history ?? []).slice(-6), { role: "user", content: o.question }];
  let text = "", info: RouteInfo | undefined;
  for await (const ev of runRouted({ messages, task: "research", private: book.private, allowCloud: o.allowCloud, signal: o.signal, purpose: "notebook-chat", temperature: 0.2 })) {
    if (ev.type === "route") { info = ev.info; yield { event: "route", data: ev.info }; }
    else if (ev.type === "text") { text += ev.text; yield { event: "text", data: { text: ev.text } }; }
  }
  const clean = stripInvalidCites(text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), citations.length);
  const refused = clean.includes("can't find that in your sources");
  const used = [...new Set([...clean.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
  yield { event: "done", data: { text: clean, citations: citations.filter((c) => used.includes(c.n)), grounded: refused || used.length > 0, refused, route: info } };
}
