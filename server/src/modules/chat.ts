import { getDb, now, uid } from "../db.js";
import { cfg } from "../config.js";
import { classify, runRouted, type RouteInfo } from "../router/router.js";
import { isLocalOnly } from "../router/privacy.js";
import { getRouterConfig, type Task } from "../router/config.js";
import { completeWithRefs } from "../router/refs.js";
import type { ImagePart, Message } from "../providers/types.js";
import type { AttachmentKind } from "../router/classify.js";
import { getGem } from "./gems.js";
import { formatContext, retrieve } from "./rag.js";
import { extractRememberRequest, recallMemories, saveMemory } from "./memory.js";
import { attachmentImages, attachmentText, getAttachment, publicAttachment } from "./attachments.js";
import { fetchPage, search } from "./search.js";
import { artifactsOf, stripArtifacts } from "../shared/artifacts.js";
import { redactCards } from "../util/redact.js";
import { stripInvalidCites } from "../shared/cite.js";
import { runThink } from "./think.js";

export interface Conv { id: string; title: string; gem_id: string | null; mode: string; private: number; pinned_model: string | null; created_at: number; updated_at: number; leaf_id: string | null; allow_cloud: number }
export interface Msg { id: string; conversation_id: string; parent_id: string | null; role: "user" | "assistant" | "system"; content: string; meta: any; created_at: number }
const mrow = (r: any): Msg => ({ ...r, meta: JSON.parse(r.meta ?? "{}") });

export const getConv = (id: string) => getDb().prepare("SELECT * FROM conversations WHERE id=?").get(id) as Conv | undefined;
export function createConv(o: { gemId?: string | null; title?: string; private?: boolean } = {}): Conv {
  const id = uid("c_"), t = now();
  const gem = o.gemId ? getGem(o.gemId) : undefined;
  getDb().prepare("INSERT INTO conversations(id,title,gem_id,mode,private,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id, o.title ?? "New chat", o.gemId ?? null, "auto", o.private || gem?.private ? 1 : 0, t, t);
  return getConv(id)!;
}
export const listMessages = (convId: string) => (getDb().prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at, rowid").all(convId) as any[]).map(mrow);
export const getMsg = (id: string) => { const r = getDb().prepare("SELECT * FROM messages WHERE id=?").get(id); return r ? mrow(r) : undefined; };
function addMsg(convId: string, parentId: string | null, role: Msg["role"], content: string, meta: object = {}): Msg {
  const id = uid("m_");
  getDb().prepare("INSERT INTO messages(id,conversation_id,parent_id,role,content,meta,created_at) VALUES(?,?,?,?,?,?,?)").run(id, convId, parentId, role, role === "user" ? redactCards(content) : content, JSON.stringify(meta), now());
  getDb().prepare("UPDATE conversations SET leaf_id=?, updated_at=? WHERE id=?").run(id, now(), convId);
  return getMsg(id)!;
}
export function pathTo(leafId: string | null): Msg[] {
  const out: Msg[] = [];
  let cur = leafId ? getMsg(leafId) : undefined;
  while (cur) { out.unshift(cur); cur = cur.parent_id ? getMsg(cur.parent_id) : undefined; }
  return out;
}
export function deleteConv(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM messages WHERE conversation_id=?").run(id);
  db.prepare("DELETE FROM artifact_versions WHERE artifact_id IN (SELECT id FROM artifacts WHERE conversation_id=?)").run(id);
  db.prepare("DELETE FROM artifacts WHERE conversation_id=?").run(id);
  db.prepare("DELETE FROM conversations WHERE id=?").run(id);
}
export function searchConvs(q: string) {
  const db = getDb();
  if (!q.trim()) return db.prepare("SELECT id,title,gem_id,private,updated_at FROM conversations ORDER BY updated_at DESC LIMIT 200").all();
  const like = `%${q.replace(/[%_]/g, "")}%`;
  return db.prepare(`SELECT c.id,c.title,c.gem_id,c.private,c.updated_at, (SELECT substr(content, MAX(1, instr(lower(content), lower(?)) - 40), 120) FROM messages m WHERE m.conversation_id=c.id AND content LIKE ? LIMIT 1) snippet
    FROM conversations c WHERE c.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.content LIKE ?) ORDER BY c.updated_at DESC LIMIT 100`).all(q, like, like, like);
}

export function artifactsFor(convId: string) {
  const db = getDb();
  const arts = db.prepare("SELECT * FROM artifacts WHERE conversation_id=? ORDER BY created_at").all(convId) as any[];
  return arts.map((a) => ({ ...a, versions: db.prepare("SELECT version, content, created_at FROM artifact_versions WHERE artifact_id=? ORDER BY version").all(a.id) }));
}
function persistArtifacts(convId: string, text: string) {
  const db = getDb();
  for (const a of artifactsOf(text).filter((x) => x.complete)) {
    const id = `${convId}:${a.key}`;
    if (!db.prepare("SELECT 1 FROM artifacts WHERE id=?").get(id)) db.prepare("INSERT INTO artifacts(id,conversation_id,title,kind,created_at) VALUES(?,?,?,?,?)").run(id, convId, a.title, a.kind, now());
    const last = db.prepare("SELECT version, content FROM artifact_versions WHERE artifact_id=? ORDER BY version DESC LIMIT 1").get(id) as { version: number; content: string } | undefined;
    if (last?.content !== a.content) db.prepare("INSERT INTO artifact_versions(artifact_id,version,content,created_at) VALUES(?,?,?,?)").run(id, (last?.version ?? 0) + 1, a.content, now());
  }
}

const SYSTEM_BASE = `You are OpenMax, a capable, direct and honest assistant. Prefer clear, well-structured answers; use Markdown. Say so when you are unsure instead of guessing.

ARTIFACTS: when you produce a substantial, self-contained output the user will likely copy, run or edit (a document, a complete file or program, an HTML page, an SVG, a React component), wrap it exactly like this and keep commentary outside the block:
:::artifact{title="Short title" kind="code|markdown|html|svg|react" lang="python"}
...content only, no surrounding code fence...
:::
Use kind "html" for complete pages (inline CSS/JS, no external scripts), "react" for a single component with a default export (hooks allowed, no imports other than react), "svg" for graphics. Short snippets stay inline in normal fenced code blocks. To revise an earlier artifact, reuse its title.`;

export interface SendBody {
  conversationId?: string; text: string; parentId?: string | null; regenerateOf?: string; gemId?: string;
  attachmentIds?: string[]; mode?: string; think?: boolean; allowCloud?: boolean; forceRef?: string; search?: boolean; private?: boolean;
}
export interface ChatEvent { event: string; data: any }

async function webContext(query: string, signal?: AbortSignal) {
  const results = await search(query, { timeRange: "week", limit: 6, signal });
  const top = results.slice(0, 3);
  const pages = await Promise.all(top.map((r) => fetchPage(r.url, { maxChars: 3500, signal }).then((p) => p.text).catch(() => "")));
  const sources = results.slice(0, 6).map((r, i) => ({ n: i + 1, title: r.title, url: r.url, snippet: r.snippet, text: pages[i] || r.snippet }));
  return { sources, context: sources.map((s) => `[${s.n}] ${s.title} — ${s.url}\n${s.text}`).join("\n\n") };
}

export async function* chatTurn(body: SendBody, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const conv = body.conversationId ? getConv(body.conversationId) : createConv({ gemId: body.gemId, private: body.private });
  if (!conv) throw Object.assign(new Error("Conversation not found."), { status: 404 });
  const gem = conv.gem_id ? getGem(conv.gem_id) : undefined;
  const isPrivate = !!conv.private || !!gem?.private;
  const firstTurn = !body.conversationId || listMessages(conv.id).length === 0;

  let userMsg: Msg, parentOfAssistant: string;
  const atts = (body.attachmentIds ?? []).map((id) => getAttachment(id)).filter((a): a is NonNullable<typeof a> => !!a);
  if (body.regenerateOf) {
    const prev = getMsg(body.regenerateOf);
    if (!prev || prev.role !== "assistant" || !prev.parent_id) throw Object.assign(new Error("Nothing to regenerate."), { status: 400 });
    userMsg = getMsg(prev.parent_id)!;
    parentOfAssistant = userMsg.id;
    getDb().prepare("UPDATE conversations SET leaf_id=? WHERE id=?").run(userMsg.id, conv.id);
  } else {
    const parent = body.parentId === undefined ? conv.leaf_id : body.parentId;
    userMsg = addMsg(conv.id, parent, "user", body.text, { attachments: atts.map(publicAttachment) });
    parentOfAssistant = userMsg.id;
  }
  yield { event: "start", data: { conversationId: conv.id, userMessageId: userMsg.id, title: conv.title } };

  // attachments for this turn come from the user message being answered
  const turnAtts = ((userMsg.meta.attachments ?? []) as { id: string }[]).map((a) => getAttachment(a.id)).filter((a): a is NonNullable<typeof a> => !!a);
  const kinds = turnAtts.map((a) => a.kind) as AttachmentKind[];
  const images: ImagePart[] = turnAtts.flatMap(attachmentImages);

  const history = pathTo(userMsg.id);
  const lastUserText = userMsg.content;
  const messages: Message[] = [];
  let budget = 90_000;
  for (const m of [...history].reverse()) {
    const c = m.role === "assistant" ? stripArtifactsForContext(m.content) : m.content;
    budget -= c.length; if (budget < 0 && messages.length > 2) break;
    messages.unshift({ role: m.role, content: c });
  }
  // inline attachment text on the answered user message
  const last = messages[messages.length - 1]!;
  const inlined = turnAtts.map((a) => { const t = attachmentText(a); return t ? `\n\n[Attached file: ${a.name}]\n${t.slice(0, 24000)}${t.length > 24000 ? "\n…(truncated)" : ""}` : a.kind === "image" ? "" : `\n\n[Attached file: ${a.name} — ${a.note ?? "no readable text"}]`; }).join("");
  last.content += inlined;
  if (images.length) last.images = images;

  // classify first so we can act on the task (search for realtime) before generating
  const mode = body.mode ?? "auto";
  let pre: Awaited<ReturnType<typeof classify>> | undefined;
  let forceRef = body.forceRef ?? (mode.startsWith("manual:") ? undefined : gem?.pinned_model ?? undefined);
  if (gem?.lane) pre = { task: gem.lane as Task, confidence: 1, source: "heuristic", reason: `gem lane ${gem.lane}` };
  else pre = await classify({ messages, attachmentKinds: kinds, private: isPrivate, allowCloud: body.allowCloud, signal });

  const sysParts: string[] = [SYSTEM_BASE, `Today is ${new Date().toDateString()}.`];
  if (gem?.instructions) sysParts.push(`## Persona / instructions (${gem.name})\n${gem.instructions}`);
  const localOnly = isLocalOnly({ private: isPrivate, hasAttachments: kinds.length > 0, allowCloud: body.allowCloud });
  let citations: any[] = [];

  if (gem) {
    const hits = await retrieve({ kind: "gem", id: gem.id }, lastUserText, 6, { localOnly }).catch(() => []);
    if (hits.length) { const f = formatContext(hits); citations = f.citations.map((c) => ({ n: c.n, title: `${c.name} §${c.idx + 1}`, snippet: c.text.slice(0, 280), kind: "knowledge" })); sysParts.push(`## Knowledge base\nUse these excerpts when relevant and cite them like [1]. Never invent a citation number.\n${f.context}`); }
  }
  if (pre.task === "realtime" || body.search) {
    try {
      yield { event: "status", data: { text: "Searching the web…" } };
      const w = await webContext(lastUserText, signal);
      if (w.sources.length) { citations = w.sources.map((s) => ({ n: s.n, title: s.title, url: s.url, snippet: s.snippet, kind: "web" })); sysParts.push(`## Live web results\nAnswer from these results and cite with [n]. If they do not answer the question, say so.\n${w.context}`); }
    } catch (e: any) { sysParts.push(`(Live web search failed: ${e.message}. Say that you could not verify current facts.)`); }
  }
  const mems = await recallMemories(lastUserText).catch(() => []);
  if (mems.length) sysParts.push(`## What you know about the user (long-term memory)\n${mems.map((m) => `- ${m}`).join("\n")}`);
  if (citations.length) yield { event: "sources", data: citations };
  messages.unshift({ role: "system", content: sysParts.join("\n\n") });

  let text = "", reasoning = "", info: RouteInfo | undefined, meta: any, thinkData: any;
  const think = body.think && !forceRef;
  const gen = think
    ? runThink({ messages, pre, mode, private: isPrivate, allowCloud: body.allowCloud, attachments: images, attachmentKinds: kinds, signal })
    : runRouted({ messages, pre, mode, private: isPrivate, allowCloud: body.allowCloud, attachments: images, attachmentKinds: kinds, forceRef, signal, purpose: "chat" });
  try {
    for await (const ev of gen) {
      if (ev.type === "route") { info = ev.info; yield { event: "route", data: ev.info }; }
      else if (ev.type === "text") { text += ev.text; yield { event: "text", data: { text: ev.text } }; }
      else if (ev.type === "reasoning") { reasoning += ev.text; yield { event: "reasoning", data: { text: ev.text } }; }
      else if (ev.type === "meta") { meta = ev.meta; }
      else if ((ev as any).type === "think") { thinkData = (ev as any).data; yield { event: "think", data: thinkData }; }
    }
  } catch (e: any) {
    if (text) { addMsg(conv.id, parentOfAssistant, "assistant", text, { partial: true, route: info, error: e.message }); }
    if (e?.name === "AbortError" || signal?.aborted) return;
    yield { event: "error", data: { message: e.message, fix: e.fix, needsCloudOverride: !!e.status && e.status === 503 && localOnly && !body.allowCloud } };
    return;
  }
  if (citations.length) text = stripInvalidCites(text, citations.length);
  const asst = addMsg(conv.id, parentOfAssistant, "assistant", text, { route: info, citations, logId: meta?.logId, tps: meta?.tps, tokens: meta ? { in: meta.tokensIn, out: meta.tokensOut } : undefined, reasoning: reasoning || undefined, think: thinkData && thinkData.phase === "done" ? thinkData : undefined });
  persistArtifacts(conv.id, text);
  yield { event: "done", data: { messageId: asst.id, conversationId: conv.id, meta } };

  const remember = extractRememberRequest(lastUserText);
  if (remember) { const m = await saveMemory(remember, "chat").catch(() => undefined); if (m) yield { event: "memory", data: { id: m.id, text: m.text } }; }
  if (firstTurn && conv.title === "New chat") {
    const title = await makeTitle(lastUserText, text, localOnly).catch(() => undefined);
    if (title) { getDb().prepare("UPDATE conversations SET title=? WHERE id=?").run(title, conv.id); yield { event: "title", data: { title } }; }
  }
}

const stripArtifactsForContext = (t: string) => t;

export async function makeTitle(user: string, assistant: string, localOnly: boolean): Promise<string> {
  if (cfg.OPENMAX_STUB) return user.replace(/\s+/g, " ").slice(0, 40);
  const r = await completeWithRefs(getRouterConfig().titles, {
    messages: [{ role: "system", content: "Write a 3-6 word title for this conversation. Reply with the title only: no quotes, no trailing punctuation." }, { role: "user", content: `User: ${user.slice(0, 400)}\nAssistant: ${stripArtifacts(assistant).slice(0, 400)}` }],
    maxTokens: 24, temperature: 0.3,
  }, { localOnly, purpose: "title" });
  return r.text.replace(/^["'\s]+|["'.\s]+$/g, "").slice(0, 80) || user.slice(0, 40);
}
