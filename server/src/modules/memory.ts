import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { cfg } from "../config.js";
import { getDb, getSetting, now, setSetting, uid } from "../db.js";
import { redactCards } from "../util/redact.js";
import { setMcpStatus } from "./mcpState.js";

export interface Memory { id: string; text: string; source: string | null; created_at: number }
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

export function listMemories(): Memory[] { return getDb().prepare("SELECT * FROM memories ORDER BY created_at DESC").all() as Memory[]; }
export function deleteMemory(id: string) { getDb().prepare("DELETE FROM memories WHERE id=?").run(id); }
function addLocal(text: string, source?: string): Memory {
  const clean = redactCards(text.trim()).slice(0, 500);
  const existing = listMemories().find((m) => m.text.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const m: Memory = { id: uid("m_"), text: clean, source: source ?? null, created_at: now() };
  getDb().prepare("INSERT INTO memories(id,text,source,created_at) VALUES(?,?,?,?)").run(m.id, m.text, m.source, m.created_at);
  return m;
}

// ───────── MemoryOS over MCP ─────────
export const memoryUrl = () => getSetting<string>("memoryos.url", "") || cfg.MEMORYOS_URL;
export const setMemoryUrl = (u: string) => { setSetting("memoryos.url", u); mcp = undefined; };
interface Conn { client: Client; tools: { name: string; schema: any }[]; readTool?: string; writeTool?: string }
let mcp: Conn | undefined;
export type McpFactory = (url: string) => Promise<{ client: Pick<Client, "callTool" | "listTools" | "close"> }>;
let factory: McpFactory = async (url) => {
  const client = new Client({ name: "openmax", version: "0.1.0" });
  try { await client.connect(new StreamableHTTPClientTransport(new URL(url))); }
  catch { const c2 = new Client({ name: "openmax", version: "0.1.0" }); await c2.connect(new SSEClientTransport(new URL(url))); return { client: c2 }; }
  return { client };
};
export const setMcpFactoryForTest = (f: McpFactory | undefined) => { mcp = undefined; factory = f ?? factory; };

export function pickTools(tools: { name: string; description?: string }[]): { read?: string; write?: string } {
  const find = (re: RegExp) => tools.find((t) => re.test(t.name))?.name ?? tools.find((t) => re.test(t.description ?? ""))?.name;
  return { read: find(/search|recall|retriev|query|get_?mem|find|read/i), write: find(/add|store|save|remember|write|create|insert|upsert/i) };
}
const textArgFor = (schema: any, text: string) => {
  const props = Object.keys(schema?.properties ?? {});
  const key = ["query", "text", "content", "memory", "message", "input", "q"].find((k) => props.includes(k)) ?? props.find((k) => schema.properties[k]?.type === "string") ?? "text";
  return { [key]: text };
};

async function connection(): Promise<Conn | undefined> {
  const url = memoryUrl();
  if (!url) return undefined;
  if (mcp) return mcp;
  try {
    const { client } = await factory(url);
    const { tools } = await client.listTools();
    const picked = pickTools(tools);
    mcp = { client: client as Client, tools: tools.map((t) => ({ name: t.name, schema: t.inputSchema })), readTool: picked.read, writeTool: picked.write };
    setMcpStatus({ name: "MemoryOS", url, connected: true, tools: tools.map((t) => t.name) });
    return mcp;
  } catch (e: any) {
    setMcpStatus({ name: "MemoryOS", url, connected: false, tools: [], error: `cannot connect: ${e.message}`.slice(0, 160) });
    return undefined;
  }
}
export async function testMemoryConnection() { mcp = undefined; const c = await connection(); return { connected: !!c, tools: c?.tools.map((t) => t.name) ?? [], read: c?.readTool, write: c?.writeTool }; }

const resultText = (r: any): string => (r?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

/** Memories relevant to a query: MemoryOS when connected, otherwise the local table. */
export async function recallMemories(query: string, limit = 8): Promise<string[]> {
  const c = await connection();
  if (c?.readTool) {
    try {
      const tool = c.tools.find((t) => t.name === c.readTool)!;
      const r = await c.client.callTool({ name: tool.name, arguments: textArgFor(tool.schema, query) });
      const t = resultText(r).trim();
      if (t) {
        try { const j = JSON.parse(t); const arr = Array.isArray(j) ? j : j.memories ?? j.results; if (Array.isArray(arr)) return arr.map((x: any) => (typeof x === "string" ? x : x.text ?? x.content ?? x.memory ?? JSON.stringify(x))).slice(0, limit); } catch { /* plain text */ }
        return t.split(/\n+/).map((l) => l.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean).slice(0, limit);
      }
    } catch { mcp = undefined; /* fall back to local */ }
  }
  const all = listMemories();
  if (all.length <= limit) return all.map((m) => m.text);
  const q = words(query);
  const scored = all.map((m, i) => ({ m, s: [...words(m.text)].filter((w) => q.has(w)).length + (i < 3 ? 0.5 : 0) })).sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.m.text);
}

/** Save a memory (MemoryOS if connected, always mirrored locally so it can be reviewed and deleted). */
export async function saveMemory(text: string, source?: string): Promise<Memory> {
  const local = addLocal(text, source);
  const c = await connection();
  if (c?.writeTool) {
    try {
      const tool = c.tools.find((t) => t.name === c.writeTool)!;
      await c.client.callTool({ name: tool.name, arguments: textArgFor(tool.schema, local.text) });
    } catch { mcp = undefined; }
  }
  return local;
}

/** Explicit "remember that …" requests only; keeps surprises out of long-term memory. */
export function extractRememberRequest(text: string): string | undefined {
  const m = /^\s*(?:please\s+)?(?:remember|note|keep in mind|don'?t forget)(?:\s+that)?[:\s]+(.{4,400})/i.exec(text);
  return m?.[1]?.trim().replace(/[.!\s]+$/, "");
}
