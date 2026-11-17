import { extractJSON } from "../../providers/llm.js";
import type { Message, ToolCall, ToolDef } from "../../providers/types.js";
import { routedComplete } from "../../router/router.js";
import { pool } from "../research.js";
import { fetchPage, search } from "../search.js";
import fs from "node:fs";
import path from "node:path";
import { registerDeliverable, type Deliverable } from "./deliverables.js";
import { toCsv, toMarkdownTable } from "./documents.js";

/**
 * Wide research: one small, read-only sub-agent per item, run in parallel, then merged into a table and a report.
 * Sub-agents can only search and read pages, so they need no approval gates.
 */
export interface WideRow { item: string; summary: string; fields: Record<string, string>; sources: string[]; ok: boolean; error?: string; steps: number }
export const MAX_ITEMS = 40; export const SUB_STEPS = 8; export const CONCURRENCY = 4;

const TOOLS: ToolDef[] = [
  { name: "web_search", description: "Search the web. Returns titles, URLs and snippets.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "fetch_page", description: "Download a web page and return its readable text.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
  { name: "finish", description: "Report your findings for this item. Call exactly once when done.", parameters: { type: "object", properties: { summary: { type: "string", description: "2-5 sentences of concrete findings" }, fields: { type: "object", description: "values for the requested columns, keyed by column name" }, sources: { type: "array", items: { type: "string" }, description: "URLs you used" } }, required: ["summary"], additionalProperties: false } },
];

export interface SubAgentDeps { search: typeof search; fetch: typeof fetchPage; complete: typeof routedComplete }
const realDeps: SubAgentDeps = { search, fetch: fetchPage, complete: routedComplete };

export async function researchItem(item: string, task: string, columns: string[] | undefined, signal?: AbortSignal, deps: SubAgentDeps = realDeps): Promise<WideRow> {
  const colText = columns?.length ? `Also fill these fields: ${columns.map((c) => `"${c}"`).join(", ")} (use "unknown" when you cannot verify a value).` : "";
  const messages: Message[] = [
    { role: "system", content: `You research ONE item for a larger study. Task for every item: ${task}\n${colText}\nUse web_search and fetch_page to find real, current facts; never invent them. Be efficient (at most ${SUB_STEPS} tool calls). When you have enough, call finish with a short factual summary${columns?.length ? ", the requested fields" : ""} and the source URLs you actually used.` },
    { role: "user", content: `Item: ${item}` },
  ];
  const visited = new Set<string>(); let steps = 0;
  for (; steps < SUB_STEPS; steps++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const r = await deps.complete({ task: "research", messages, tools: TOOLS, signal, purpose: "wide-research", temperature: 0.2, maxTokens: 1500 });
    let call: ToolCall | undefined = r.toolCalls[0];
    if (!call) { const j = extractJSON<any>(r.text); if (j?.summary) call = { id: "txt", name: "finish", args: j }; else return { item, summary: r.text.trim().slice(0, 800) || "No findings.", fields: {}, sources: [...visited], ok: !!r.text.trim(), steps: steps + 1 }; }
    if (call.name === "finish") {
      const a = call.args as any; const fields: Record<string, string> = {};
      for (const c of columns ?? []) fields[c] = String(a.fields?.[c] ?? "unknown").slice(0, 300);
      const srcs = (Array.isArray(a.sources) ? a.sources : []).map(String).filter((u: string) => /^https?:/.test(u));
      return { item, summary: String(a.summary ?? "").slice(0, 1200), fields, sources: [...new Set([...srcs, ...visited])].slice(0, 6), ok: true, steps: steps + 1 };
    }
    let result: string;
    try {
      if (call.name === "web_search") { const rs = await deps.search(String((call.args as any).query ?? ""), { limit: 6, signal }); result = rs.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n") || "No results."; }
      else if (call.name === "fetch_page") { const u = String((call.args as any).url ?? ""); const p = await deps.fetch(u, { maxChars: 5000, signal }); visited.add(u); result = `${p.title}\n\n${p.text}`; }
      else result = `Unknown tool ${call.name}.`;
    } catch (e: any) { if (e?.name === "AbortError") throw e; result = `Error: ${e.message}`; }
    messages.push({ role: "assistant", content: r.text, toolCalls: [call] }, { role: "tool", toolCallId: call.id, name: call.name, content: result.slice(0, 5000) });
  }
  return { item, summary: "The sub-agent ran out of steps before reporting.", fields: {}, sources: [...visited], ok: false, error: "step limit", steps };
}

export async function runWide(o: { items: string[]; task: string; columns?: string[]; signal?: AbortSignal; onRow?: (row: WideRow, done: number, total: number) => void; deps?: SubAgentDeps }): Promise<WideRow[]> {
  const items = [...new Set(o.items.map((i) => i.trim()).filter(Boolean))].slice(0, MAX_ITEMS);
  if (!items.length) throw new Error("Give at least one item to research.");
  let done = 0;
  return pool(items, CONCURRENCY, async (item) => {
    let row: WideRow;
    try { row = await researchItem(item, o.task, o.columns, o.signal, o.deps); }
    catch (e: any) { if (e?.name === "AbortError") throw e; row = { item, summary: `Failed: ${e.message}`.slice(0, 300), fields: {}, sources: [], ok: false, error: e.message, steps: 0 }; }
    o.onRow?.(row, ++done, items.length);
    return row;
  });
}

/** Cross-item synthesis: what the rows say together. */
export async function synthesize(task: string, rows: WideRow[], signal?: AbortSignal, complete: typeof routedComplete = routedComplete): Promise<string> {
  const ok = rows.filter((r) => r.ok);
  if (!ok.length) return "No item could be researched, so there is nothing to synthesize.";
  const r = await complete({ task: "research", signal, purpose: "wide-synthesis", temperature: 0.3, maxTokens: 1800, messages: [
    { role: "system", content: "You write the conclusion of a multi-item research study. Using ONLY the per-item findings, write a Markdown report: a short executive summary, a comparison of the items (call out clear leaders, outliers and gaps), and caveats. Cite items by name. Do not add facts that are not in the findings." },
    { role: "user", content: `Task: ${task}\n\nFindings:\n${ok.map((x) => `## ${x.item}\n${x.summary}\n${Object.entries(x.fields).map(([k, v]) => `- ${k}: ${v}`).join("\n")}`).join("\n\n")}` },
  ] });
  return r.text.trim();
}

/** Writes the CSV table and Markdown report into the run workspace and registers both as deliverables. */
export function writeWideOutputs(runId: string, workspace: string, task: string, rows: WideRow[], columns: string[] | undefined, report: string): { csv: Deliverable; md: Deliverable; table: Record<string, unknown>[]; cols: string[] } {
  const table = rows.map((r) => ({ item: r.item, summary: r.summary, ...r.fields, sources: r.sources }));
  const cols = ["item", ...(columns ?? []), "summary", "sources"];
  const ws = fs.realpathSync(workspace); const dir = path.join(ws, "wide"); fs.mkdirSync(dir, { recursive: true });
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "research";
  fs.writeFileSync(path.join(dir, `${slug}.csv`), toCsv(table, cols));
  fs.writeFileSync(path.join(dir, `${slug}.md`), `# ${task}\n\n${report}\n\n## Per-item findings\n\n${toMarkdownTable(table, cols)}\n`);
  return { csv: registerDeliverable(runId, ws, `wide/${slug}.csv`, "Wide research table (CSV)"), md: registerDeliverable(runId, ws, `wide/${slug}.md`, "Wide research report"), table, cols };
}
