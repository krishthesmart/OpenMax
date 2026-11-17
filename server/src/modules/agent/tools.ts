import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { cfg } from "../../config.js";
import { safeResolve } from "../workspace.js";
import { fetchPage, search } from "../search.js";
import { recallMemories, saveMemory } from "../memory.js";
import { redactCards } from "../../util/redact.js";
import type { ToolDef } from "../../providers/types.js";
import { buildIcs } from "./ics.js";
import { SMTP_FIX, sendMail, smtpConfigured, validEmail } from "./mail.js";
import { evaluateGate, type ApprovalKind, type ElementInfo } from "./gates.js";
import { createApproval, knownRecipients, rememberRecipients, waitForDecision } from "./approvals.js";
import type { BrowserDriver, PageView } from "./browser.js";
import { uid } from "../../db.js";

export interface ToolContext { runId: string; sandbox: string; signal: AbortSignal; browser: () => BrowserDriver; unattended: boolean; onApproval?: (a: any) => void; saveShot?: (png: Buffer) => string | undefined }
export interface ToolOutcome { status: "ok" | "error" | "blocked" | "rejected" | "pending_approval" | "finished"; message: string; data?: unknown; screenshot?: string; approvalId?: string }
interface Impl<A> { def: ToolDef; schema: z.ZodType<A>; deferrable?: boolean; precheck?(a: A): string | undefined; inspect?(a: A, c: ToolContext): Promise<ElementInfo | undefined>; run(a: A, c: ToolContext): Promise<{ message: string; data?: unknown }> }

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const trim = (s: string, n = 6000) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more characters)` : s);
const viewText = (v: PageView) => trim(`URL: ${v.url}\nTitle: ${v.title}\n\nPage text:\n${v.text}\n\nInteractive elements (use the ref number):\n${v.elements.map((e) => `[${e.ref}] <${e.tag}${e.type ? ` type=${e.type}` : ""}> ${[e.text, e.label && `label:${e.label}`, e.name && `name:${e.name}`, e.placeholder && `placeholder:${e.placeholder}`].filter(Boolean).join(" · ")}`).join("\n")}`, 9000);
const sandboxPath = (c: ToolContext, p: string) => { fs.mkdirSync(c.sandbox, { recursive: true }); return safeResolve(c.sandbox, p); };

const toolList: Impl<any>[] = [
  { def: { name: "web_search", description: "Search the web. Returns titles, URLs and snippets.", parameters: obj({ query: { type: "string" } }, ["query"]) }, schema: z.object({ query: z.string().min(1) }),
    async run(a) { const r = await search(a.query, { limit: 8 }); return { message: r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n") || "No results." }; } },
  { def: { name: "fetch_page", description: "Download a web page and return its readable text (no JavaScript).", parameters: obj({ url: { type: "string" } }, ["url"]) }, schema: z.object({ url: z.string().url() }),
    async run(a) { const p = await fetchPage(a.url, { maxChars: 8000, allowLocal: true }); return { message: `${p.title}\n\n${p.text}` }; } },
  { def: { name: "browser_open", description: "Open a URL in the agent's isolated browser. Returns the page text and a numbered list of interactive elements.", parameters: obj({ url: { type: "string" } }, ["url"]) }, schema: z.object({ url: z.string().url() }),
    async run(a, c) { return { message: viewText(await c.browser().open(a.url)) }; } },
  { def: { name: "browser_read", description: "Re-read the current page and its element list.", parameters: obj({}) }, schema: z.object({}), async run(_a, c) { return { message: viewText(await c.browser().read()) }; } },
  { def: { name: "browser_click", description: "Click the element with this ref number from the latest page listing. Buying, submitting and deleting require the user's approval.", parameters: obj({ ref: { type: "integer" } }, ["ref"]) }, schema: z.object({ ref: z.number().int() }),
    inspect: async (a, c) => c.browser().describe(a.ref), async run(a, c) { return { message: viewText(await c.browser().click(a.ref)) }; } },
  { def: { name: "browser_type", description: "Type text into the input with this ref. Personal data (email, phone, address, date of birth) requires approval. Passwords and card numbers are never allowed.", parameters: obj({ ref: { type: "integer" }, text: { type: "string" }, enter: { type: "boolean", description: "press Enter afterwards" } }, ["ref", "text"]) }, schema: z.object({ ref: z.number().int(), text: z.string().max(2000), enter: z.boolean().optional() }),
    inspect: async (a, c) => c.browser().describe(a.ref), async run(a, c) { return { message: viewText(await c.browser().type(a.ref, a.text, { enter: a.enter })) }; } },
  { def: { name: "browser_select", description: "Choose an option in a <select> by value or label.", parameters: obj({ ref: { type: "integer" }, value: { type: "string" } }, ["ref", "value"]) }, schema: z.object({ ref: z.number().int(), value: z.string() }),
    inspect: async (a, c) => c.browser().describe(a.ref), async run(a, c) { return { message: viewText(await c.browser().select(a.ref, a.value)) }; } },
  { def: { name: "file_list", description: "List files in the agent's sandbox folder.", parameters: obj({ path: { type: "string" } }) }, schema: z.object({ path: z.string().optional() }),
    async run(a, c) { const d = sandboxPath(c, a.path ?? "."); if (!fs.existsSync(d)) return { message: "(empty)" }; return { message: fs.readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(empty)" }; } },
  { def: { name: "file_read", description: "Read a text file from the sandbox.", parameters: obj({ path: { type: "string" } }, ["path"]) }, schema: z.object({ path: z.string() }),
    async run(a, c) { const f = sandboxPath(c, a.path); if (!fs.existsSync(f)) throw new Error("File not found."); return { message: trim(fs.readFileSync(f, "utf8")) }; } },
  { def: { name: "file_write", description: "Write (create or overwrite) a text file in the sandbox.", parameters: obj({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]) }, schema: z.object({ path: z.string(), content: z.string().max(500_000) }),
    async run(a, c) { const f = sandboxPath(c, a.path); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, redactCards(a.content)); return { message: `Wrote ${a.path} (${a.content.length} chars).` }; } },
  { def: { name: "file_delete", description: "Permanently delete a sandbox file or folder. Requires the user's approval.", parameters: obj({ path: { type: "string" } }, ["path"]) }, schema: z.object({ path: z.string() }), deferrable: true,
    async run(a, c) { const f = sandboxPath(c, a.path); if (f === fs.realpathSync(c.sandbox)) throw new Error("Refusing to delete the sandbox root."); if (!fs.existsSync(f)) throw new Error("Not found."); fs.rmSync(f, { recursive: true, force: true }); return { message: `Deleted ${a.path}.` }; } },
  { def: { name: "send_email", description: "Send an email via the user's SMTP account. ALWAYS requires the user's approval before anything is sent.", parameters: obj({ to: { type: "array", items: { type: "string" } }, subject: { type: "string" }, body: { type: "string" } }, ["to", "subject", "body"]) }, schema: z.object({ to: z.array(z.string()).min(1).max(20), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) }), deferrable: true,
    precheck: (a) => (!smtpConfigured() ? `Email is not configured. ${SMTP_FIX}` : a.to.some((x: string) => !validEmail(x)) ? "One of the recipient addresses is invalid." : undefined),
    async run(a) { const id = await sendMail(a.to, a.subject, a.body); rememberRecipients(a.to); return { message: `Email sent to ${a.to.join(", ")} (${id}).` }; } },
  { def: { name: "calendar_add", description: "Create a calendar event as an .ics file in the sandbox (calendar/). Times are ISO 8601.", parameters: obj({ title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, description: { type: "string" }, location: { type: "string" }, all_day: { type: "boolean" } }, ["title", "start"]) }, schema: z.object({ title: z.string(), start: z.string(), end: z.string().optional(), description: z.string().optional(), location: z.string().optional(), all_day: z.boolean().optional() }),
    async run(a, c) {
      const start = new Date(a.start), end = a.end ? new Date(a.end) : undefined;
      if (isNaN(+start) || (end && isNaN(+end))) throw new Error("Dates must be ISO 8601, e.g. 2026-03-14T15:00:00Z.");
      const ics = buildIcs({ uid: `${uid()}@openmax`, title: a.title, start, end, description: a.description, location: a.location, allDay: a.all_day });
      const rel = `calendar/${a.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "event"}-${start.toISOString().slice(0, 10)}.ics`;
      const f = sandboxPath(c, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, ics);
      return { message: `Saved ${rel}. Open it to add to a calendar app.`, data: { file: rel } };
    } },
  { def: { name: "memory_recall", description: "Look up what is known about the user from long-term memory.", parameters: obj({ query: { type: "string" } }, ["query"]) }, schema: z.object({ query: z.string() }),
    async run(a) { const m = await recallMemories(a.query, 8); return { message: m.length ? m.map((x) => `- ${x}`).join("\n") : "No relevant memories." }; } },
  { def: { name: "memory_save", description: "Save a durable fact about the user's preferences or context. Never store secrets or card numbers.", parameters: obj({ text: { type: "string" } }, ["text"]) }, schema: z.object({ text: z.string().min(3).max(400) }),
    async run(a) { const m = await saveMemory(a.text, "agent"); return { message: `Saved: ${m.text}` }; } },
  { def: { name: "ask_user", description: "Ask the user a question and wait for their typed answer. Never ask for passwords or card numbers.", parameters: obj({ question: { type: "string" } }, ["question"]) }, schema: z.object({ question: z.string().min(2).max(500) }),
    async run() { throw new Error("handled by the executor"); } },
  { def: { name: "finish", description: "End the task. Give the user a clear final summary of what was done and any results.", parameters: obj({ summary: { type: "string" } }, ["summary"]) }, schema: z.object({ summary: z.string() }), async run(a) { return { message: a.summary }; } },
];
export const TOOLS = new Map(toolList.map((t) => [t.def.name, t]));
export const toolDefs = (): ToolDef[] => toolList.map((t) => t.def);

/** Redact secrets from args before they are logged or stored. */
export function redactArgs(args: Record<string, any>): Record<string, any> {
  return JSON.parse(redactCards(JSON.stringify(args)));
}

/**
 * The only path from a model's tool call to a side effect. Order is fixed: validate → precheck → inspect → GATE → (wait for human) → run.
 * `run` is never reached for a gated action unless a human approved that specific approval row.
 */
export async function executeTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const impl = TOOLS.get(name);
  if (!impl) return { status: "error", message: `Unknown tool "${name}". Available: ${[...TOOLS.keys()].join(", ")}.` };
  const parsed = impl.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) return { status: "error", message: `Invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  const args = parsed.data as Record<string, any>;
  try {
    if (name === "finish") return { status: "finished", message: String(args.summary) };
    if (name === "ask_user") {
      const ap = createApproval({ runId: ctx.runId, kind: "question", summary: args.question, payload: { tool: name, args } });
      ctx.onApproval?.(ap);
      if (ctx.unattended) return { status: "pending_approval", message: "This run is unattended, so the question was left in the Inbox. Continue without the answer or finish.", approvalId: ap.id };
      const d = await waitForDecision(ap.id, ctx.signal);
      return d.status === "approved" ? { status: "ok", message: `The user answered: ${d.answer ?? "(no text)"}` } : { status: "rejected", message: "The user declined to answer." };
    }
    const pre = impl.precheck?.(args); if (pre) return { status: "error", message: pre };
    const element = impl.inspect ? await impl.inspect(args, ctx) : undefined;
    const gate = evaluateGate({ tool: name, args, element, knownRecipients: knownRecipients(), pageUrl: ctx.browser().currentUrl() });
    if (gate.action === "block") return { status: "blocked", message: `Blocked: ${gate.reason}` };
    if (gate.action === "approve") {
      const deferred = ctx.unattended && !!impl.deferrable;
      if (ctx.unattended && !impl.deferrable) return { status: "blocked", message: `"${gate.summary}" needs a live approval, which an unattended scheduled run cannot get. Run it interactively instead.` };
      const ap = createApproval({ runId: ctx.runId, kind: gate.kind as ApprovalKind, summary: gate.summary, payload: { tool: name, args: redactArgs(args), flags: gate.flags, deferred, rawArgs: deferred ? args : undefined } });
      ctx.onApproval?.(ap);
      if (deferred) return { status: "pending_approval", message: `Queued for the user's approval in the Inbox (${gate.summary}). It has NOT happened yet. Move on and mention it in your summary.`, approvalId: ap.id };
      const d = await waitForDecision(ap.id, ctx.signal);
      if (d.status !== "approved") return { status: "rejected", message: `The user rejected this action (${gate.summary}). Do not retry it; choose another approach or finish.`, approvalId: ap.id };
    }
    const r = await impl.run(args, ctx);
    let screenshot: string | undefined;
    if (name.startsWith("browser_")) { const png = await ctx.browser().screenshot(); if (png) screenshot = ctx.saveShot?.(png); }
    return { status: "ok", message: r.message, data: r.data, screenshot };
  } catch (e: any) {
    if (e?.name === "AbortError") throw e;
    return { status: "error", message: `${e.message}${e.fix ? ` (${e.fix})` : ""}`.slice(0, 800) };
  }
}

/** Runs an approved, deferred action (unattended runs) when the user approves it later from the Inbox. */
export async function runDeferred(a: { payload: any; id: string }, sandbox: string) {
  const { tool, rawArgs } = a.payload ?? {};
  const impl = TOOLS.get(tool); if (!impl || !impl.deferrable || !rawArgs) throw new Error("Nothing to run.");
  const args = impl.schema.parse(rawArgs);
  const pre = impl.precheck?.(args); if (pre) throw new Error(pre);
  await impl.run(args, { runId: "deferred", sandbox, signal: new AbortController().signal, browser: () => { throw new Error("no browser"); }, unattended: true });
}
void cfg;
