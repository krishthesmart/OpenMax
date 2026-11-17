/**
 * End-to-end smoke test. Boots the real server on a random port with stub LLM providers, a stub search index and
 * MEDIA_PROVIDER=mock, then drives it over HTTP: health, router explain (one prompt per task), chat stream, research,
 * a Studio job, notebook, canvas, Think mode, and an agent run against a local test page that must hit the approval gates.
 *
 *   npm run smoke
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openmax-smoke-"));
Object.assign(process.env, {
  OPENMAX_STUB: "true", MEDIA_PROVIDER: "mock", DATA_DIR: path.join(tmp, "data"), CODE_WORKSPACE: path.join(tmp, "workspace"), AGENT_SANDBOX: path.join(tmp, "agent-files"),
  OPENMAX_PASSWORD: "", ENABLE_PAID: "false", PORT: "0",
});
for (const k of ["NVIDIA_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "GROQ_API_KEY"]) process.env[k] = "stub";

const { buildApp } = await import("../src/app.js");
await import("../src/routes/all.js");
const { setStubHandler } = await import("../src/providers/stub.js");
const { setStubSearch, setStubPages } = await import("../src/modules/search.js");
const { setMailTransportForTest } = await import("../src/modules/agent/mail.js");
const { findChromium } = await import("../src/modules/agent/browser.js");
const { startTestPage } = await import("./testpage.js");

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

// ───────── tiny HTTP helpers ─────────
async function http<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(base + url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j: any; try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status}: ${typeof j === "string" ? j.slice(0, 200) : j.error ?? text.slice(0, 200)}`);
  return j;
}
async function sse(url: string, body: unknown): Promise<{ event: string; data: any }[]> {
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`POST ${url} -> ${r.status}`);
  const out: { event: string; data: any }[] = [];
  for (const block of (await r.text()).split("\n\n")) {
    let ev = "message", data = "";
    for (const l of block.split("\n")) { if (l.startsWith("event:")) ev = l.slice(6).trim(); else if (l.startsWith("data:")) data += l.slice(5).trim(); }
    if (data) out.push({ event: ev, data: JSON.parse(data) });
  }
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(f: () => Promise<T | undefined | false> | T | undefined | false, ms = 20000, what = "condition"): Promise<T> {
  const t = Date.now();
  for (;;) { const v = await f(); if (v) return v as T; if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(40); }
}
function assert(c: unknown, msg: string): asserts c { if (!c) throw new Error(msg); }

// ───────── the stub "model" ─────────
const agent = { phase: 0, refs: {} as Record<string, number>, pageUrl: "" };
setStubHandler((req) => {
  const sys = req.messages[0]?.content ?? "", user = req.messages.at(-1)?.content ?? "";
  if (/OpenMax Agent/.test(sys)) {
    const tools = req.messages.filter((m) => m.role === "tool"); const last = tools.at(-1)?.content ?? "";
    const call = (name: string, args: any) => ({ text: "", toolCalls: [{ id: `c${agent.phase}`, name, args }] });
    if (tools.length === 0) return call("browser_open", { url: agent.pageUrl });
    if (tools.length === 1) { for (const [k, re] of [["email", /\[(\d+)\] <input[^\n]*name:email/], ["pw", /\[(\d+)\] <input type=password/], ["order", /\[(\d+)\] <button[^\n]*Place order/]] as const) { const m = re.exec(last); if (m) agent.refs[k] = Number(m[1]); } return call("browser_type", { ref: agent.refs.email, text: "sam@example.com" }); }
    if (tools.length === 2) return call("browser_type", { ref: agent.refs.pw, text: "hunter2" });
    if (tools.length === 3) return call("browser_click", { ref: agent.refs.order });
    if (tools.length === 4) return call("send_email", { to: ["boss@example.com"], subject: "Order placed", body: "Done." });
    return call("finish", { summary: "Opened the shop, entered the email, tried the password field (blocked), placed the order (approved) and drafted an email (rejected)." });
  }
  if (/Reply with ONLY JSON \{"task"/.test(sys)) return '{"task":"reasoning","reason":"smoke"}';
  if (/You plan web research/.test(sys)) return '{"queries":["solid state batteries","solid state battery cost"],"fresh":false}';
  if (/follow-up/.test(sys)) return '{"followups":["What about cost?","Who leads the field?","When will they ship?"]}';
  if (/meticulous research analyst/.test(sys)) return "Solid-state cells are denser [1] and still costly [2].";
  if (/impartial judge/.test(sys)) return '{"verdict":"A is correct and clear","action":"pick","pick":"A"}';
  if (/ONLY the numbered source excerpts/.test(sys)) return "Cats sleep twelve to sixteen hours a day [1].";
  if (/You edit a .* document/.test(sys)) return '{"summary":"Friendlier greeting","ops":[{"op":"replace","find":"Hello world.","replace":"Hello, friend!"}]}';
  if (/flashcards/.test(sys)) return '{"cards":[{"front":"Kitten group","back":"kindle"},{"front":"Sleep","back":"12-16 hours"}]}';
  return `[stub] ${user.slice(0, 120)}`;
});
setStubSearch((q) => [1, 2, 3].map((i) => ({ title: `${q} source ${i}`, url: `https://example.test/${encodeURIComponent(q)}/${i}`, snippet: `Snippet ${i} about ${q}.` })));
setStubPages((u) => `Detailed page text for ${u}. It explains the topic in depth with several concrete facts.`);

// ───────── checks ─────────
const results: { name: string; ok: boolean; ms: number; note?: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>, opts: { skip?: string } = {}) {
  const t = Date.now();
  if (opts.skip) { results.push({ name, ok: true, ms: 0, note: `SKIPPED: ${opts.skip}` }); console.log(`  - ${name}  (skipped: ${opts.skip})`); return; }
  try { const note = await fn(); results.push({ name, ok: true, ms: Date.now() - t, note: note || undefined }); console.log(`  ✓ ${name}${note ? `  (${note})` : ""}`); }
  catch (e: any) { results.push({ name, ok: false, ms: Date.now() - t, note: e.message }); console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log(`OpenMax smoke test on ${base} (stub providers, mock media)\n`);

await check("health: providers, search, media, hardware", async () => {
  const h = await http("GET", "/api/health");
  assert(h.ok && h.stub, "health not ok"); assert(h.providers.some((p: any) => p.id === "ollama") && h.providers.some((p: any) => p.id === "groq"), "providers missing");
  assert(!h.providers.some((p: any) => p.paid), "paid providers must be hidden by default"); assert(h.media.backend === "mock" && h.search.backend === "stub", "backends");
  return `${h.providers.length} providers, tier ${h.hardware.recommended.label}`;
});

await check("providers test endpoint + model discovery", async () => { const t = await http("POST", "/api/providers/test"); assert(t.providers.every((p: any) => p.ok) && t.refs.length > 10, "discovery/ping failed"); return `${t.refs.length} refs pinged`; });

await check("router explain: one labelled prompt per task", async () => {
  const cases: [string, any, string][] = [
    ["code", { text: "Fix this bug:\n```ts\nfoo()\n```\nTypeError: x is undefined" }, "code"],
    ["reasoning", { text: "Prove that the square root of 2 is irrational, step by step." }, "reasoning"],
    ["research", { text: "Research the state of the art in solid-state batteries and cite sources" }, "research"],
    ["realtime", { text: "What is the latest news today?" }, "realtime"],
    ["creative", { text: "Write a haiku about autumn rain" }, "creative"],
    ["vision", { text: "what is in this picture", attachments: ["image"] }, "vision"],
    ["multimodal", { text: "summarize this", attachments: ["pdf"] }, "multimodal"],
    ["long-context", { text: "summarize " + "word ".repeat(30000) }, "long-context"],
    ["agentic", { text: "Remind me to call the dentist every Monday morning and add it to my calendar" }, "agentic"],
    ["quick", { text: "hi" }, "quick"],
  ];
  for (const [label, body, want] of cases) { const r = await http("POST", "/api/router/explain", body); assert(r.classification.task === want, `${label}: expected ${want}, got ${r.classification.task}`); assert(r.candidates.length > 0, `${label}: no candidates`); }
  const priv = await http("POST", "/api/router/explain", { text: "Write a poem about my diary", private: true }); assert(priv.localOnly && priv.chosen.startsWith("ollama:"), "private text must route local-only");
  return `${cases.length} tasks + privacy rule`;
});

await check("chat: SSE stream with route event, persistence, history search", async () => {
  const ev = await sse("/api/chat/send", { text: "Write a TypeScript function that reverses a string", mode: "auto" });
  const names = ev.map((e) => e.event); for (const n of ["start", "route", "text", "done"]) assert(names.includes(n), `missing ${n} event`);
  const route = ev.find((e) => e.event === "route")!.data; assert(route.task === "code" && route.model && "fallbacksTried" in route && "confidence" in route, "route event shape");
  const cid = ev[0]!.data.conversationId; const conv = await http("GET", `/api/conversations/${cid}`); assert(conv.messages.length === 2, "messages not persisted");
  const found = await http("GET", "/api/conversations?q=reverses"); assert(found.conversations.length === 1, "search failed");
  return `${route.task} → ${route.model}`;
});

await check("think mode: drafts + judge, considered approaches persisted", async () => {
  const ev = await sse("/api/chat/send", { text: "Why is the sky blue?", think: true });
  const think = ev.filter((e) => e.event === "think").at(-1)?.data; assert(think?.phase === "done" && think.candidates.length >= 3 && think.judge, "think data missing");
  assert(ev.find((e) => e.event === "route")!.data.model.startsWith("think:"), "route should be a think route");
  return `${think.candidates.length} drafts, judge ${think.judge.ref}`;
});

await check("research: plan → search → fetch → cited answer → follow-ups", async () => {
  const ev = await sse("/api/research", { query: "state of solid-state batteries", deep: true });
  const names = ev.map((e) => e.event); for (const n of ["plan", "sources", "text", "followups", "done"]) assert(names.includes(n), `missing ${n}`);
  assert(!names.includes("error"), "research errored"); const src = ev.find((e) => e.event === "sources")!.data; assert(src.length >= 3 && src[0].n === 1, "sources");
  assert(ev.filter((e) => e.event === "step").some((e) => e.data.id === "gap" && e.data.status === "done"), "deep mode gap round missing");
  return `${src.length} sources, deep gap round ran`;
});

await check("studio: mock t2i + t2v jobs finish and serve files", async () => {
  const j1 = (await http("POST", "/api/studio/jobs", { op: "t2i", prompt: "a lighthouse at dusk", aspect: "16:9", count: 2, presets: ["cinematic"] })).job;
  const j2 = (await http("POST", "/api/studio/jobs", { op: "t2v", prompt: "waves on a beach", aspect: "16:9", count: 1, duration: 3, presets: ["dolly_in"] })).job;
  for (const j of [j1, j2]) { const done = await until(async () => { const r = (await http("GET", `/api/studio/jobs/${j.id}`)).job; if (r.status === "error") throw new Error(r.error); return r.status === "done" ? r : undefined; }, 15000, "studio job"); const f = await fetch(base + done.outputs[0].url); assert(f.ok && (f.headers.get("content-type") ?? "").includes("svg"), "media not served"); if (j === j1) assert(done.outputs.length === 2, "count"); }
  const bad = await fetch(base + "/api/studio/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "i2v", prompt: "x", aspect: "16:9", count: 1 }) }); assert(bad.status === 400, "i2v without input must be refused");
  return "images 2×, video 1×";
});

await check("notebook: sources → grounded chat with citations → flashcards", async () => {
  const nb = (await http("POST", "/api/notebooks", { title: "Cats" })).notebook;
  await http("POST", `/api/notebooks/${nb.id}/sources`, { kind: "text", name: "cats.txt", text: "Cats are obligate carnivores. They sleep between twelve and sixteen hours a day. A group of kittens is a kindle." });
  const ev = await sse(`/api/notebooks/${nb.id}/chat`, { question: "How long do cats sleep?" }); const done = ev.find((e) => e.event === "done")!.data;
  assert(done.grounded && done.citations.length === 1 && done.citations[0].end > done.citations[0].start, "citation grounding");
  const out = (await http("POST", `/api/notebooks/${nb.id}/generate`, { kind: "flashcards" })).output; assert(out.data.cards.length === 2, "flashcards");
  const cards = await http("GET", `/api/notebooks/${nb.id}/cards`); assert(cards.due === 2, "cards due");
  return "1 citation with passage offsets, 2 cards due";
});

await check("canvas: model patch edit → version 2 → restore", async () => {
  const cv = (await http("POST", "/api/canvas", { title: "Notes", kind: "markdown", content: "# T\n\nHello world.\n" })).canvas;
  const r = await http("POST", `/api/canvas/${cv.id}/edit`, { instruction: "make the greeting friendlier" }); assert(r.changed && r.canvas.content.includes("Hello, friend!") && r.canvas.version === 2, "edit not applied");
  const back = await http("POST", `/api/canvas/${cv.id}/restore`, { version: 1 }); assert(back.canvas.content.includes("Hello world.") && back.canvas.version === 3, "restore");
  return "patch applied, restored as v3";
});

await check("code workspace: path-escape protection over HTTP", async () => {
  await http("PUT", "/api/code/file", { path: "src/a.txt", content: "hi" });
  assert((await http("GET", "/api/code/file?path=src/a.txt")).content === "hi", "round trip");
  for (const p of ["../../etc/passwd", "/etc/passwd"]) { const r = await fetch(base + "/api/code/file?path=" + encodeURIComponent(p)); assert(r.status === 400, `escape ${p} must be rejected (got ${r.status})`); }
  const del = await fetch(base + "/api/code/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/a.txt" }) }); assert(del.status === 409, "delete without confirm must be refused");
});

await check("usage meter and setup state endpoints", async () => {
  const u = await http("GET", "/api/usage"); assert(u.models.length > 0 && u.comparison.subscriptionsMonthly > 0 && Array.isArray(u.freeCaps), "usage shape");
  const s = await http("GET", "/api/setup/state"); assert(s.hardware.memoryGb > 0 && s.ollama.recommended.length > 0, "setup state");
  return `${u.models.length} model rows`;
});

// ───────── agent against a local test page: the approval gates must fire ─────────
const haveBrowser = !!findChromium() || !!process.env.PLAYWRIGHT_CHROMIUM_PATH;
await check("agent: local test page, approval gates fire and are enforced", async () => {
  const page = await startTestPage(); agent.pageUrl = page.url; agent.phase = 0;
  let mails = 0; setMailTransportForTest({ sendMail: async () => { mails++; return { messageId: "m" }; } });
  try {
    const { id } = await http("POST", "/api/agent/runs", { goal: "Open the test shop, enter my email, place the order, then email my boss." });
    const next = async (kind: string) => until(async () => (await http("GET", "/api/approvals?status=pending")).approvals.find((a: any) => a.kind === kind), 30000, `${kind} approval`);
    const a1 = await next("personal_data"); assert(page.posts.length === 0, "nothing may be submitted before approval");
    await http("POST", `/api/approvals/${a1.id}`, { decision: "approve" });
    const a2 = await next("payment"); assert(page.posts.length === 0, "the order must not be placed before the payment approval");
    await http("POST", `/api/approvals/${a2.id}`, { decision: "approve" });
    await until(() => page.posts.length === 1, 10000, "form post after approval"); assert(/email=sam%40example\.com/.test(page.posts[0]!) && /pw=(&|$)/.test(page.posts[0]!), "form must contain the email and an EMPTY password");
    const a3 = await next("send_message"); assert(mails === 0, "email must not be sent before approval");
    await http("POST", `/api/approvals/${a3.id}`, { decision: "reject" });
    const run = await until(async () => { const r = await http("GET", `/api/agent/runs/${id}`); return r.run.status !== "running" ? r : undefined; }, 30000, "run to finish");
    assert(run.run.status === "done", `run ended ${run.run.status}: ${run.run.result}`); assert(mails === 0, "rejected email must never be sent");
    const steps = run.steps.map((s: any) => `${s.tool}:${s.status}`);
    assert(steps.includes("browser_type:blocked"), "password typing must be blocked"); assert(steps.includes("send_email:rejected"), "rejection recorded");
    assert(run.steps.some((s: any) => s.screenshot), "browser steps should keep screenshots");
    const inbox = await http("GET", "/api/inbox"); assert(inbox.items.some((i: any) => i.ref === id), "result missing from Inbox");
    return `3 gates fired (personal_data, payment, send_message), password blocked, ${page.posts.length} form post after approval`;
  } finally { await page.close(); setMailTransportForTest(undefined); }
}, { skip: haveBrowser ? undefined : "no Chromium found: run `npx playwright install chromium`" });

// ───────── report ─────────
await app.close();
await sleep(600); // let Chromium finish writing its profile before cleanup
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp dir cleanup is best-effort */ }
const failed = results.filter((r) => !r.ok); const skipped = results.filter((r) => r.note?.startsWith("SKIPPED"));
console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped.length ? ` (${skipped.length} skipped)` : ""}.`);
if (failed.length) { console.log("FAILED:\n" + failed.map((f) => ` - ${f.name}: ${f.note}`).join("\n")); process.exit(1); }
process.exit(0);
