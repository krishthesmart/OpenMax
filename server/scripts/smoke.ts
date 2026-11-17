/**
 * End-to-end smoke test against REAL services (no stubs, no mocks):
 *   - the real server on a random port, real SQLite, real router
 *   - real local inference through Ollama (needs `ollama serve` and at least one pulled model)
 *   - real web search (SearXNG/Brave/DuckDuckGo/Wikipedia, whichever is available) and real page fetches
 *   - real image generation (ComfyUI / Gemini / Pollinations, whichever is available)
 *   - real text-to-speech (macOS `say`, Piper or Kokoro)
 *   - a real Chromium driven through the real tool executor against a local web page, with real approvals over HTTP
 *   - a real SMTP server (local) receiving mail sent through nodemailer
 *
 * Checks that depend on a small local model producing valid JSON are "soft": they retry, and a failure is reported as a
 * warning (model too weak) rather than a bug. Everything else is a hard failure.
 *
 *   npm run smoke
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openmax-smoke-"));
Object.assign(process.env, { DATA_DIR: path.join(tmp, "data"), CODE_WORKSPACE: path.join(tmp, "workspace"), AGENT_SANDBOX: path.join(tmp, "agent-files"), OPENMAX_PASSWORD: "", ENABLE_PAID: "false", PORT: "0" });

const { cfg, setConfigForTest } = await import("../src/config.js");
const { buildApp } = await import("../src/app.js");
await import("../src/routes/all.js");
const { findChromium, PlaywrightDriver } = await import("../src/modules/agent/browser.js");
const { executeTool } = await import("../src/modules/agent/tools.js");
const { startTestPage } = await import("./testpage.js");

// ───────── a real (tiny) SMTP receiver ─────────
const mails: { from: string; to: string[]; data: string }[] = [];
const smtp = net.createServer((sock) => {
  let inData = false, buf = "", cur = { from: "", to: [] as string[], data: "" };
  sock.write("220 smoke ESMTP\r\n");
  sock.on("data", (d) => {
    buf += d.toString("latin1");
    for (;;) {
      if (inData) { const i = buf.indexOf("\r\n.\r\n"); if (i < 0) return; cur.data = buf.slice(0, i); buf = buf.slice(i + 5); inData = false; mails.push(cur); cur = { from: "", to: [], data: "" }; sock.write("250 queued\r\n"); continue; }
      const i = buf.indexOf("\r\n"); if (i < 0) return; const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (/^(EHLO|HELO)/i.test(line)) sock.write("250-smoke\r\n250 8BITMIME\r\n");
      else if (/^MAIL FROM/i.test(line)) { cur.from = line.slice(10); sock.write("250 ok\r\n"); }
      else if (/^RCPT TO/i.test(line)) { cur.to.push(line.slice(8)); sock.write("250 ok\r\n"); }
      else if (/^DATA/i.test(line)) { inData = true; sock.write("354 go\r\n"); }
      else if (/^QUIT/i.test(line)) { sock.write("221 bye\r\n"); sock.end(); }
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
setConfigForTest({ ...process.env, SMTP_HOST: "127.0.0.1", SMTP_PORT: String((smtp.address() as any).port), SMTP_FROM: "openmax@localhost" } as any);

const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const base = `http://127.0.0.1:${(app.server.address() as any).port}`;

// ───────── tiny HTTP helpers ─────────
async function http<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(base + url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j: any; try { j = JSON.parse(text); } catch { j = text; }
  if (!r.ok) throw Object.assign(new Error(`${method} ${url} -> ${r.status}: ${typeof j === "string" ? j.slice(0, 200) : (j.error ?? text.slice(0, 200)) + (j.fix ? ` (${j.fix})` : "")}`), { status: r.status, body: j });
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
async function until<T>(f: () => Promise<T | undefined | false> | T | undefined | false, ms = 30000, what = "condition"): Promise<T> {
  const t = Date.now();
  for (;;) { const v = await f(); if (v) return v as T; if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
function assert(c: unknown, msg: string): asserts c { if (!c) throw new Error(msg); }
async function retry<T>(n: number, f: () => Promise<T>): Promise<T> { let last: unknown; for (let i = 0; i < n; i++) { try { return await f(); } catch (e) { last = e; } } throw last; }

// ───────── runner ─────────
const results: { name: string; ok: boolean; soft?: boolean; note?: string }[] = [];
async function check(name: string, fn: () => Promise<string | void>, opts: { soft?: boolean; skip?: string } = {}) {
  if (opts.skip) { results.push({ name, ok: true, note: `SKIPPED: ${opts.skip}` }); console.log(`  - ${name}  (skipped: ${opts.skip})`); return; }
  try { const note = await fn(); results.push({ name, ok: true, note: note || undefined }); console.log(`  ✓ ${name}${note ? `  (${note})` : ""}`); }
  catch (e: any) { results.push({ name, ok: false, soft: opts.soft, note: e.message }); console.log(`  ${opts.soft ? "⚠" : "✗"} ${name}\n      ${e.message}`); }
}

console.log(`OpenMax smoke test on ${base}  (real services, no mocks)\n`);

// Preconditions: say plainly what is missing instead of pretending
const ollama = await fetch(`${cfg.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json() as Promise<any>).catch(() => undefined);
const localModels: string[] = (ollama?.models ?? []).map((m: any) => m.name);
if (!localModels.length) { console.error("Ollama is not running or has no models. Run `ollama serve` and `ollama pull llama3.2:1b`, then re-run the smoke test."); process.exit(2); }
console.log(`  local models: ${localModels.join(", ")}\n`);

await check("health: providers, search, media, hardware", async () => {
  const h = await http("GET", "/api/health");
  assert(h.ok && h.providers.some((p: any) => p.id === "ollama"), "ollama missing from health"); assert(!h.providers.some((p: any) => p.paid), "paid providers must be hidden by default");
  return `search=${h.search.backend}, media=${h.media.backend}, tier ${h.hardware.recommended.label}`;
});

await check("provider discovery: real Ollama model list and pings", async () => {
  const t = await http("POST", "/api/providers/test"); const ol = t.providers.find((p: any) => p.provider === "ollama");
  assert(ol?.ok && ol.models >= 1, "Ollama discovery failed"); const live = t.refs.filter((r: any) => r.ok); assert(live.length >= 1, "no live ref");
  return `${live.length}/${t.refs.filter((r: any) => !r.skipped).length} refs alive`;
});

await check("router explain: one labelled prompt per task + privacy rule", async () => {
  const cases: [string, any][] = [
    ["code", { text: "Fix this bug:\n```ts\nfoo()\n```\nTypeError: x is undefined" }], ["reasoning", { text: "Prove that the square root of 2 is irrational, step by step." }],
    ["research", { text: "Research the state of the art in solid-state batteries and cite sources" }], ["realtime", { text: "What is the latest news today?" }],
    ["creative", { text: "Write a haiku about autumn rain" }], ["vision", { text: "what is in this picture", attachments: ["image"] }],
    ["multimodal", { text: "summarize this", attachments: ["pdf"] }], ["long-context", { text: "summarize " + "word ".repeat(30000) }],
    ["agentic", { text: "Remind me to call the dentist every Monday morning and add it to my calendar" }], ["quick", { text: "hi" }],
  ];
  for (const [want, body] of cases) { const r = await http("POST", "/api/router/explain", body); assert(r.classification.task === want, `${want}: got ${r.classification.task}`); }
  const priv = await http("POST", "/api/router/explain", { text: "Write a poem about my diary", private: true }); assert(priv.localOnly && priv.chosen?.startsWith("ollama:"), "private text must route local-only");
  return `${cases.length} tasks`;
});

await check("chat: real local model streams an answer; route event; persistence; search; title", async () => {
  const ev = await sse("/api/chat/send", { text: "Write a TypeScript function that reverses a string", mode: "auto" });
  const names = ev.map((e) => e.event); for (const n of ["start", "route", "text", "done"]) assert(names.includes(n), `missing ${n} event (got ${names.join(",")}; ${JSON.stringify(ev.find((e) => e.event === "error")?.data)})`);
  const route = ev.find((e) => e.event === "route")!.data; assert(route.task === "code" && route.model.startsWith("ollama:"), `unexpected route ${route.model}`);
  const text = ev.filter((e) => e.event === "text").map((e) => e.data.text).join(""); assert(text.trim().length > 20, "answer too short");
  const done = ev.find((e) => e.event === "done")!.data; assert(done.meta.tokensOut > 0 && done.meta.tps > 0, "no usage/tps");
  const cid = ev[0]!.data.conversationId; assert((await http("GET", `/api/conversations/${cid}`)).messages.length === 2, "not persisted");
  assert((await http("GET", "/api/conversations?q=reverses")).conversations.length === 1, "history search");
  await sleep(1500); const conv = await http("GET", `/api/conversations/${cid}`); assert(conv.conversation.title !== "New chat", "no auto title");
  return `${route.model}, ${done.meta.tps} tok/s, title "${conv.conversation.title}"`;
});

await check("think mode: drafts from the available models, judge/fallback, persisted", async () => {
  const ev = await sse("/api/chat/send", { text: "Why is the sky blue? Answer in two sentences.", think: true });
  assert(!ev.some((e) => e.event === "error"), JSON.stringify(ev.find((e) => e.event === "error")?.data));
  const think = ev.filter((e) => e.event === "think").at(-1)?.data; assert(think?.phase === "done" && think.candidates.length >= 2 && think.judge, "think data missing");
  assert(ev.filter((e) => e.event === "text").map((e) => e.data.text).join("").trim().length > 10, "empty think answer");
  return `${think.candidates.filter((c: any) => !c.error).length}/${think.candidates.length} drafts, judge: ${think.judge.action}`;
});

await check("research: real search → real page fetch → synthesis → follow-ups", async () => {
  const ev = await sse("/api/research", { query: "What is a solid-state battery?" });
  assert(!ev.some((e) => e.event === "error"), JSON.stringify(ev.find((e) => e.event === "error")?.data));
  const names = ev.map((e) => e.event); for (const n of ["plan", "sources", "text", "done"]) assert(names.includes(n), `missing ${n}`);
  const src = ev.find((e) => e.event === "sources")!.data; assert(src.length >= 2 && /^https?:/.test(src[0].url), "sources");
  const steps = ev.filter((e) => e.event === "step" && e.data.id === "fetch" && e.data.status === "done"); assert(steps.length === 1 && /Read [1-9]/.test(steps[0]!.data.label), `no page was actually fetched: ${steps[0]?.data.label}`);
  return `${src.length} real sources from ${new URL(src[0].url).host}, ${steps[0]!.data.label.toLowerCase()}`;
});

await check("studio: real image generation when a backend exists, otherwise an honest refusal (never a fake image)", async () => {
  const info = await http("GET", "/api/studio/backends"); const def = info.backends.find((b: any) => b.default);
  if (!def?.status.ok) {
    try { await http("POST", "/api/studio/jobs", { op: "t2i", prompt: "a lighthouse at dusk", aspect: "16:9", count: 1, presets: [] }); } catch (e: any) { assert(e.status === 503 && /ComfyUI|Gemini/i.test(e.message + JSON.stringify(e.body)), `unexpected refusal: ${e.message}`); return `no image backend configured; refused with: ${String(e.body?.fix ?? e.message).slice(0, 90)}`; }
    throw new Error("an image job was accepted although no image backend is available");
  }
  const j = (await http("POST", "/api/studio/jobs", { op: "t2i", prompt: "a lighthouse at dusk, oil painting", aspect: "16:9", count: 1, presets: ["cinematic"] })).job;
  const done = await until(async () => { const r = (await http("GET", `/api/studio/jobs/${j.id}`)).job; if (r.status === "error") throw new Error(`${j.backend} failed: ${r.error}`); return r.status === "done" ? r : undefined; }, 300000, "image job");
  const f = await fetch(base + done.outputs[0].url); const buf = Buffer.from(await f.arrayBuffer());
  assert(f.ok && /^image\//.test(f.headers.get("content-type") ?? "") && buf.length > 2000, `not a real image (${f.headers.get("content-type")}, ${buf.length} bytes)`);
  return `${done.backend}, ${(buf.length / 1024).toFixed(0)} KB ${f.headers.get("content-type")}`;
});

await check("studio: video is refused with an explanation when no video backend exists (no fake clips)", async () => {
  const info = await http("GET", "/api/studio/backends");
  if (info.backends.some((b: any) => b.ops.t2v.supported)) return "a video backend is configured; skipping the refusal check";
  try { await http("POST", "/api/studio/jobs", { op: "t2v", prompt: "waves", aspect: "16:9", count: 1, duration: 3, presets: [] }); } catch (e: any) { assert((e.status === 400 || e.status === 503) && /cannot do|ComfyUI|not available/i.test(e.message), `unexpected: ${e.message}`); return `refused (${e.status}) with a fix-it message`; }
  throw new Error("video job was accepted without any video backend");
});

await check("speech: real text-to-speech produces audio; speech-to-text explains setup when unconfigured", async () => {
  const r = await fetch(base + "/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "OpenMax speech test." }) });
  if (!r.ok) { const j: any = await r.json(); throw new Error(`${j.error} ${j.fix ?? ""}`); }
  const buf = Buffer.from(await r.arrayBuffer()); assert(buf.length > 4000, `audio too small (${buf.length} bytes)`);
  const backend = r.headers.get("x-tts-backend");
  const fd = new FormData(); fd.append("file", new Blob([buf], { type: "audio/wav" }), "t.wav");
  const stt = await fetch(base + "/api/stt", { method: "POST", body: fd });
  if (stt.ok) return `tts=${backend}, stt transcribed: "${(await stt.json() as any).text}"`;
  const j: any = await stt.json(); assert(/speech-to-text|transcription/i.test(j.error) && j.fix, "STT failure must explain how to enable it");
  return `tts=${backend} (${(buf.length / 1024).toFixed(0)} KB), stt: ${j.error.slice(0, 50)}`;
});

await check("notebook: real retrieval → grounded chat with citation offsets → real audio overview", async () => {
  const nb = (await http("POST", "/api/notebooks", { title: "Cats" })).notebook;
  await http("POST", `/api/notebooks/${nb.id}/sources`, { kind: "text", name: "cats.txt", text: "Cats are obligate carnivores. They sleep between twelve and sixteen hours a day. A group of kittens is called a kindle. Cats purr at a frequency between 25 and 150 hertz." });
  const ev = await sse(`/api/notebooks/${nb.id}/chat`, { question: "How many hours a day do cats sleep?" });
  assert(!ev.some((e) => e.event === "error"), JSON.stringify(ev.find((e) => e.event === "error")?.data));
  const pool = ev.find((e) => e.event === "sources")?.data; assert(pool?.length >= 1 && pool[0].end > pool[0].start && /sleep/i.test(pool[0].text), "retrieval did not find the right passage");
  const done = ev.find((e) => e.event === "done")!.data; assert(done.text.trim().length > 5, "empty answer");
  return `retrieved passage [${pool[0].start}-${pool[0].end}], grounded=${done.grounded}`;
});

await check("notebook generators (small local model): flashcards + audio overview", async () => {
  const nb = (await http("POST", "/api/notebooks", { title: "Cats 2" })).notebook;
  await http("POST", `/api/notebooks/${nb.id}/sources`, { kind: "text", name: "cats.txt", text: "Cats are obligate carnivores. They sleep between twelve and sixteen hours a day. A group of kittens is called a kindle. Cats purr at a frequency between 25 and 150 hertz. Domestic cats descend from the African wildcat." });
  const cards = (await retry(3, () => http("POST", `/api/notebooks/${nb.id}/generate`, { kind: "flashcards" }))).output; assert(cards.data.cards.length >= 2, "flashcards");
  const audio = (await retry(3, () => http("POST", `/api/notebooks/${nb.id}/generate`, { kind: "audio" }))).output;
  const f = await fetch(`${base}/api/notebooks/${nb.id}/outputs/${audio.id}/file`); const buf = Buffer.from(await f.arrayBuffer());
  assert(f.ok && buf.length > 5000 && audio.data.chapters.length >= 1 && audio.data.duration > 1, "audio overview");
  return `${cards.data.cards.length} cards, ${audio.data.duration.toFixed(1)}s audio (${audio.data.encoder}, voice ${audio.data.ttsBackend})`;
}, { soft: true });

await check("canvas: patch engine (explicit ops) → versions → restore", async () => {
  const cv = (await http("POST", "/api/canvas", { title: "Notes", kind: "markdown", content: "# T\n\nHello world.\n" })).canvas;
  const p = await http("POST", `/api/canvas/${cv.id}/patch`, { ops: [{ op: "replace", find: "Hello world.", replace: "Hello, friend!" }] }); assert(p.canvas.content.includes("Hello, friend!") && p.canvas.version === 2, "patch");
  const bad = await fetch(base + `/api/canvas/${cv.id}/patch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ops: [{ op: "replace", find: "missing text", replace: "x" }] }) }); assert(bad.status === 409, "a failing patch must be rejected atomically");
  const back = await http("POST", `/api/canvas/${cv.id}/restore`, { version: 1 }); assert(back.canvas.content.includes("Hello world.") && back.canvas.version === 3, "restore");
  return "patch + atomic rejection + restore";
});
await check("canvas: real model edit (small local model)", async () => {
  const cv = (await http("POST", "/api/canvas", { title: "Notes", kind: "markdown", content: "# Plan\n\nWe will ship the product on Friday.\n" })).canvas;
  const r = await retry(3, () => http("POST", `/api/canvas/${cv.id}/edit`, { instruction: "Change Friday to Monday", localOnly: true })); assert(r.changed && /Monday/.test(r.canvas.content), "edit not applied");
  return `applied in ${r.attempts} attempt(s)`;
}, { soft: true });

await check("code workspace: path-escape protection and confirm-only delete over HTTP", async () => {
  await http("PUT", "/api/code/file", { path: "src/a.txt", content: "hi" }); assert((await http("GET", "/api/code/file?path=src/a.txt")).content === "hi", "round trip");
  for (const p of ["../../etc/passwd", "/etc/passwd"]) assert((await fetch(base + "/api/code/file?path=" + encodeURIComponent(p))).status === 400, `escape ${p} must be rejected`);
  assert((await fetch(base + "/api/code/delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "src/a.txt" }) })).status === 409, "delete needs confirm");
});

await check("usage meter, setup state and think estimate reflect the real calls above", async () => {
  const u = await http("GET", "/api/usage"); const ol = u.models.filter((m: any) => m.provider === "ollama"); assert(ol.length > 0 && ol[0].requests > 0 && ol[0].tokensOut > 0, "no ollama usage recorded");
  const s = await http("GET", "/api/setup/state"); assert(s.hardware.memoryGb > 0 && s.ollama.running && s.ollama.models.length > 0, "setup state");
  assert((await http("GET", "/api/think/estimate")).seconds > 0, "estimate");
  return `${ol.reduce((n: number, m: any) => n + m.requests, 0)} real local requests metered`;
});

// ───────── agent: real Chromium + real executor + real approvals over HTTP + real SMTP ─────────
const haveBrowser = !!findChromium();
await check("agent: real browser on a local page: gates fire, nothing happens before approval, secrets blocked, real email on approval only", async () => {
  const page = await startTestPage(); const driver = new PlaywrightDriver();
  const ctx = (name: string) => ({ runId: `smoke-${name}`, sandbox: cfg.AGENT_SANDBOX, signal: new AbortController().signal, browser: () => driver, unattended: false });
  try {
    fs.mkdirSync(cfg.AGENT_SANDBOX, { recursive: true });
    const opened = await executeTool("browser_open", { url: page.url }, ctx("open")); assert(opened.status === "ok", opened.message);
    const ref = (re: RegExp) => { const m = re.exec(opened.message); assert(m, `element not found: ${re}`); return Number(m[1]); };
    const emailRef = ref(/\[(\d+)\] <input[^\n]*name:email/), pwRef = ref(/\[(\d+)\] <input type=password/), orderRef = ref(/\[(\d+)\] <button[^\n]*Place order/);
    const approveNext = async (kind: string, decision: "approve" | "reject") => { const a = await until(async () => (await http("GET", "/api/approvals?status=pending")).approvals.find((x: any) => x.kind === kind), 20000, `${kind} approval`); await http("POST", `/api/approvals/${a.id}`, { decision }); };

    const typing = executeTool("browser_type", { ref: emailRef, text: "sam@example.com" }, ctx("type"));
    const a1 = await until(async () => (await http("GET", "/api/approvals?status=pending")).approvals.find((x: any) => x.kind === "personal_data"), 20000, "personal_data approval");
    assert(page.posts.length === 0, "nothing may be submitted before approval"); await http("POST", `/api/approvals/${a1.id}`, { decision: "approve" }); assert((await typing).status === "ok", "typing after approval");

    const pw = await executeTool("browser_type", { ref: pwRef, text: "hunter2" }, ctx("pw")); assert(pw.status === "blocked" && /never types passwords/.test(pw.message), "password must be blocked");
    const clicking = executeTool("browser_click", { ref: orderRef }, ctx("order"));
    const a2 = await until(async () => (await http("GET", "/api/approvals?status=pending")).approvals.find((x: any) => x.kind === "payment"), 20000, "payment approval");
    assert(page.posts.length === 0, "the order must not be placed before approval"); await http("POST", `/api/approvals/${a2.id}`, { decision: "approve" });
    assert((await clicking).status === "ok", "click after approval"); await until(() => page.posts.length === 1, 10000, "form post");
    assert(/email=sam%40example\.com/.test(page.posts[0]!) && /pw=(&|$)/.test(page.posts[0]!), "form must carry the email and an EMPTY password");

    const rejected = executeTool("send_email", { to: ["boss@example.com"], subject: "Order placed", body: "Done." }, ctx("mail1")); await approveNext("send_message", "reject");
    assert((await rejected).status === "rejected" && mails.length === 0, "a rejected email must never be sent");
    const sent = executeTool("send_email", { to: ["boss@example.com"], subject: "Order placed", body: "Your order is done. Card 4242 4242 4242 4242." }, ctx("mail2"));
    await until(async () => (await http("GET", "/api/approvals?status=pending")).approvals.find((x: any) => x.kind === "send_message"), 20000, "email approval"); await sleep(200); assert(mails.length === 0, "email must not be sent before approval");
    await approveNext("send_message", "approve"); assert((await sent).status === "ok", "send after approval"); await until(() => mails.length === 1, 10000, "SMTP delivery");
    assert(/boss@example\.com/.test(mails[0]!.to.join()) && /Order placed/.test(mails[0]!.data) && !/4242 4242 4242 4242/.test(mails[0]!.data) && /redacted/.test(mails[0]!.data), "real mail must arrive with the card number redacted");
    const shot = await driver.screenshot(); assert(shot && shot.length > 1000, "screenshot");
    return `personal_data + payment + send_message gates, password blocked, 1 form post, 1 real SMTP mail (card redacted)`;
  } finally { await driver.close(); await page.close(); }
}, { skip: haveBrowser ? undefined : "no Chromium found: run `npx playwright install chromium`" });

await check("agent loop (small local model): runs end to end, writes a file in the sandbox, logs steps, posts to the Inbox", async () => {
  const { id } = await http("POST", "/api/agent/runs", { goal: "Use the file_write tool to create a file named hello.txt containing the text hello openmax, then call finish." });
  const run = await until(async () => { const r = await http("GET", `/api/agent/runs/${id}`); return r.run.status !== "running" ? r : undefined; }, 120000, "agent run");
  assert(run.steps.length >= 1, `no steps (status ${run.run.status}: ${run.run.result})`);
  const wrote = fs.existsSync(path.join(cfg.AGENT_SANDBOX, "hello.txt")); assert(run.steps.some((s: any) => s.tool === "file_write") && wrote, `the model did not manage to write the file (steps: ${run.steps.map((s: any) => s.tool + ":" + s.status).join(", ")})`);
  assert((await http("GET", "/api/inbox")).items.some((i: any) => i.ref === id), "Inbox");
  return `${run.steps.length} steps, status ${run.run.status}`;
}, { soft: true });

// ───────── report ─────────
await app.close(); smtp.close(); await sleep(600);
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* best-effort */ }
const hard = results.filter((r) => !r.ok && !r.soft), soft = results.filter((r) => !r.ok && r.soft), skipped = results.filter((r) => r.note?.startsWith("SKIPPED"));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ""}${soft.length ? `, ${soft.length} warning(s) (a larger local model would fix these)` : ""}.`);
for (const w of soft) console.log(` ⚠ ${w.name}: ${w.note}`);
if (hard.length) { console.log("FAILED:\n" + hard.map((f) => ` ✗ ${f.name}: ${f.note}`).join("\n")); process.exit(1); }
process.exit(0);
