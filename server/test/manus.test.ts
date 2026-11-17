import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { freshEnv } from "./helpers.js";
import { ROOT } from "../src/config.js";
import { getDb } from "../src/db.js";
import { setStubHandler, setStubSearch } from "./fake.js";
import { buildProfile, runSandboxed, sandboxAvailable } from "../src/modules/agent/sandbox.js";
import { evaluateGate } from "../src/modules/agent/gates.js";
import { executeTool, type ToolContext } from "../src/modules/agent/tools.js";
import { decide, listApprovals } from "../src/modules/agent/approvals.js";
import { getDeliverable, listDeliverables, registerDeliverable, resolveDeliverable } from "../src/modules/agent/deliverables.js";
import { markdownToPdf, toCsv, toMarkdownTable } from "../src/modules/agent/documents.js";
import { researchItem, runWide, synthesize, writeWideOutputs, MAX_ITEMS, CONCURRENCY, SUB_STEPS } from "../src/modules/agent/wide.js";
import { getRun, runFinished, runSteps, startRun, startWide, runWorkspace, subscribe } from "../src/modules/agent/agent.js";
import { listInbox } from "../src/modules/inbox.js";
import { buildApp } from "../src/app.js";
import "../src/routes/all.js";

let tmp: string, ws: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "om-manus-")); ws = path.join(tmp, "ws"); fs.mkdirSync(ws, { recursive: true }); freshEnv({ DATA_DIR: path.join(tmp, "data"), AGENT_SANDBOX: path.join(tmp, "sandbox") }); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = async (f: () => any, ms = 8000) => { const t = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 15)); } };
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ runId: "r1", sandbox: path.join(tmp, "sandbox"), workspace: ws, signal: new AbortController().signal, browser: () => { throw new Error("no browser"); }, unattended: false, ...over });
const realSandbox = sandboxAvailable();

describe.skipIf(!realSandbox)("code sandbox (real macOS sandbox-exec)", () => {
  it("runs code and lets it write inside the workspace only", async () => {
    const outside = path.join(tmp, "outside"); fs.mkdirSync(outside);
    const r = await runSandboxed(`python3 -c "open('made.txt','w').write('hi'); print(sum(range(10)))" && echo "x" > ${outside}/nope.txt`, { workspace: ws });
    expect(r.contained).toBe(true); expect(r.output).toContain("45"); expect(fs.readFileSync(path.join(ws, "made.txt"), "utf8")).toBe("hi");
    expect(r.code).not.toBe(0); expect(fs.existsSync(path.join(outside, "nope.txt"))).toBe(false); expect(r.output).toMatch(/not permitted/i);
  });
  it("has no network by default (not even localhost); allows it when asked", async () => {
    const srv = net.createServer((s) => s.end("pong")); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); const port = (srv.address() as any).port;
    const py = `python3 -c "import socket;s=socket.create_connection(('127.0.0.1',${port}),2);print(s.recv(10).decode())"`;
    const blocked = await runSandboxed(py, { workspace: ws }); expect(blocked.code).not.toBe(0); expect(blocked.output).not.toContain("pong");
    const open = await runSandboxed(py, { workspace: ws, network: true }); expect(open.output).toContain("pong"); srv.close();
  });
  it("cannot read credential stores, .env files, or OpenMax's own secrets", async () => {
    fs.writeFileSync(path.join(ws, ".env"), "SECRET=1"); fs.writeFileSync(path.join(ws, ".env.local"), "SECRET=2"); fs.writeFileSync(path.join(ws, "env.txt"), "fine");
    expect((await runSandboxed("cat .env", { workspace: ws })).code).not.toBe(0); expect((await runSandboxed("cat .env.local", { workspace: ws })).code).not.toBe(0);
    expect((await runSandboxed("cat env.txt", { workspace: ws })).output).toContain("fine");
    if (fs.existsSync(path.join(ROOT, ".env"))) { const r = await runSandboxed(`cat ${path.join(ROOT, ".env")}`, { workspace: ws }); expect(r.code).not.toBe(0); expect(r.output).not.toMatch(/API_KEY=./); }
    if (fs.existsSync(path.join(os.homedir(), ".ssh"))) expect((await runSandboxed(`ls ${path.join(os.homedir(), ".ssh")}`, { workspace: ws })).code).not.toBe(0);
  });
  it("strips API keys from the environment, redirects HOME/TMPDIR into the workspace, and kills runaway commands", async () => {
    process.env.GROQ_API_KEY = "supersecret"; process.env.MY_PASSWORD = "pw";
    const r = await runSandboxed('echo "k=[$GROQ_API_KEY] p=[$MY_PASSWORD] home=$HOME"', { workspace: ws }); delete process.env.GROQ_API_KEY; delete process.env.MY_PASSWORD;
    expect(r.output).toContain("k=[] p=[]"); expect(r.output).toContain(fs.realpathSync(ws));
    const t = await runSandboxed("sleep 30 & sleep 30", { workspace: ws, timeoutMs: 1200 }); expect(t.timedOut).toBe(true); expect(t.ms).toBeLessThan(5000);
    const ac = new AbortController(); setTimeout(() => ac.abort(), 150); expect((await runSandboxed("sleep 30", { workspace: ws, signal: ac.signal })).aborted).toBe(true);
  });
  it("tool: shell_run runs code, reports exit codes and timeouts, and keeps the working directory in the run workspace", async () => {
    const events: any[] = [];
    const ok = await executeTool("shell_run", { command: "python3 -c \"print('answer', 6*7)\" && pwd" }, ctx({ emit: (t, d) => events.push([t, d]) }));
    expect(ok.status).toBe("ok"); expect(ok.message).toContain("exit code 0"); expect(ok.message).toContain("answer 42"); expect(ok.message).toContain(fs.realpathSync(ws));
    expect(events[0][0]).toBe("terminal"); expect(events[0][1].contained).toBe(true);
    expect((await executeTool("shell_run", { command: "exit 3" }, ctx())).message).toContain("exit code 3");
    expect((await executeTool("shell_run", { command: "sleep 20", timeout_sec: 1 }, ctx())).message).toContain("TIMED OUT");
  });
  it("tool: network access needs the user's approval and nothing runs before it", async () => {
    const p = executeTool("shell_run", { command: "echo ran > marker.txt", network: true }, ctx());
    const ap = await wait(() => listApprovals("pending")[0]); expect(ap.kind).toBe("network_access"); await new Promise((r) => setTimeout(r, 80)); expect(fs.existsSync(path.join(ws, "marker.txt"))).toBe(false);
    await decide(ap.id, "approve"); expect((await p).status).toBe("ok"); expect(fs.existsSync(path.join(ws, "marker.txt"))).toBe(true);
    const q = executeTool("shell_run", { command: "echo ran2 > marker2.txt", network: true }, ctx()); await decide((await wait(() => listApprovals("pending")[0])).id, "reject");
    expect((await q).status).toBe("rejected"); expect(fs.existsSync(path.join(ws, "marker2.txt"))).toBe(false);
  });
});

describe("sandbox profile and gates (pure)", () => {
  it("profile denies writes outside the workspace, network by default, secrets and .env", () => {
    const p = buildProfile(ws, { network: false }); const real = fs.realpathSync(ws);
    expect(p).toContain("(deny network*)"); expect(p).toContain("(deny file-write*)"); expect(p).toContain(`(subpath "${real}")`);
    expect(p).toContain(".ssh"); expect(p).toContain("Keychains"); expect(p).toMatch(/\\\.env/);
    expect(buildProfile(ws, { network: true })).not.toContain("(deny network*)");
  });
  it("gates: contained shell is free, network needs approval, an unsandboxed shell always needs approval", () => {
    expect(evaluateGate({ tool: "shell_run", args: { command: "ls" }, sandboxed: true })).toEqual({ action: "allow" });
    expect(evaluateGate({ tool: "shell_run", args: { command: "pip install x", network: true }, sandboxed: true })).toMatchObject({ action: "approve", kind: "network_access" });
    expect(evaluateGate({ tool: "shell_run", args: { command: "ls" }, sandboxed: false })).toMatchObject({ action: "approve", kind: "code_exec" });
    expect(evaluateGate({ tool: "plan_update", args: {} })).toEqual({ action: "allow" });
    for (const t of ["deliver", "make_pdf", "make_pptx", "wide_research"]) expect(evaluateGate({ tool: t, args: {} }).action).toBe("allow");
  });
});

describe("plan, documents and deliverables", () => {
  it("plan_update saves the checklist on the run and emits it live", async () => {
    getDb().prepare("INSERT INTO agent_runs(id,goal,status,created_at) VALUES('r1','g','running',1)").run();
    const events: any[] = [];
    const r = await executeTool("plan_update", { items: [{ text: "Research", status: "done" }, { text: "Write", status: "doing" }, { text: "Ship", status: "pending" }] }, ctx({ emit: (t, d) => events.push([t, d]) }));
    expect(r.message).toContain("1/3 done"); expect(JSON.parse(getRun("r1").plan)).toHaveLength(3); expect(events[0][0]).toBe("plan");
    expect((await executeTool("plan_update", { items: [] }, ctx())).status).toBe("error");
  });
  it("make_pdf renders Markdown to a real PDF and delivers it; make_pptx makes a real deck", async () => {
    const md = "# Title\n\nSome **bold** text and `code`.\n\n- one\n- two\n1. first\n\n```\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const r = await executeTool("make_pdf", { path: "out/report", title: "Report", markdown: md + "\ncard 4242 4242 4242 4242" }, ctx());
    expect(r.status).toBe("ok"); const f = path.join(ws, "out", "report.pdf"); const buf = fs.readFileSync(f); expect(buf.subarray(0, 4).toString()).toBe("%PDF"); expect(buf.length).toBeGreaterThan(1500);
    const d = listDeliverables("r1")[0]!; expect(d).toMatchObject({ title: "Report", mime: "application/pdf", kind: "file" });
    const p = await executeTool("make_pptx", { path: "deck.pptx", title: "Deck", slides: [{ title: "One", bullets: ["a", "b"], notes: "n" }, { title: "Two", bullets: ["c"] }] }, ctx());
    expect(p.status).toBe("ok"); expect(fs.readFileSync(path.join(ws, "deck.pptx")).subarray(0, 2).toString()).toBe("PK"); expect(listDeliverables("r1")).toHaveLength(2);
    expect((await executeTool("make_pdf", { path: "../escape.pdf", title: "x", markdown: "x" }, ctx())).status).toBe("error"); expect(fs.existsSync(path.join(tmp, "escape.pdf"))).toBe(false);
    await markdownToPdf(path.join(ws, "empty.pdf"), "Empty", ""); expect(fs.statSync(path.join(ws, "empty.pdf")).size).toBeGreaterThan(500);
  });
  it("deliver: files and websites; folders need an index.html; escapes are refused; re-delivering updates in place", async () => {
    fs.writeFileSync(path.join(ws, "notes.md"), "# hi"); fs.mkdirSync(path.join(ws, "site")); fs.mkdirSync(path.join(ws, "empty"));
    const d1 = (await executeTool("deliver", { path: "notes.md", title: "Notes" }, ctx())).data as any; expect(d1).toMatchObject({ kind: "file", mime: "text/markdown", title: "Notes" });
    expect((await executeTool("deliver", { path: "empty" }, ctx())).message).toMatch(/index\.html/);
    expect((await executeTool("deliver", { path: "missing.txt" }, ctx())).status).toBe("error"); expect((await executeTool("deliver", { path: "../../etc/passwd" }, ctx())).status).toBe("error");
    fs.writeFileSync(path.join(ws, "site", "index.html"), "<h1>site</h1>"); fs.writeFileSync(path.join(ws, "site", "app.js"), "1"); const s = (await executeTool("deliver", { path: "site" }, ctx())).data as any; expect(s.kind).toBe("site");
    fs.writeFileSync(path.join(ws, "notes.md"), "# hi again, longer"); const again = registerDeliverable("r1", ws, "notes.md"); expect(again.id).toBe(d1.id); expect(again.size).toBeGreaterThan(d1.size);
    expect(resolveDeliverable(getDeliverable(s.id)!)!.file).toMatch(/index\.html$/); expect(resolveDeliverable(getDeliverable(s.id)!, "app.js")!.mime).toBe("text/javascript");
    expect(resolveDeliverable(getDeliverable(s.id)!, "../notes.md")).toBeUndefined(); expect(resolveDeliverable(getDeliverable(s.id)!, "nope.css")).toBeUndefined(); expect(resolveDeliverable(getDeliverable(d1.id)!, "other.txt")).toBeUndefined();
  });
  it("HTTP: deliverables are served inline with an opaque-origin CSP, sites resolve relative files, escapes 404", async () => {
    fs.mkdirSync(path.join(ws, "site")); fs.writeFileSync(path.join(ws, "site", "index.html"), "<script src=app.js></script>"); fs.writeFileSync(path.join(ws, "site", "app.js"), "console.log(1)"); fs.writeFileSync(path.join(ws, "secret.txt"), "nope"); fs.writeFileSync(path.join(ws, "data.bin"), Buffer.from([1, 2, 3]));
    const site = registerDeliverable("r1", ws, "site", "Site"), bin = registerDeliverable("r1", ws, "data.bin");
    const app = await buildApp();
    const idx = await app.inject({ url: `/api/agent/deliverables/${site.id}` }); expect(idx.statusCode).toBe(200); expect(idx.body).toContain("app.js"); expect(String(idx.headers["content-security-policy"])).toMatch(/^sandbox /); expect(idx.headers["x-content-type-options"]).toBe("nosniff"); expect(String(idx.headers["content-disposition"])).toContain("inline");
    expect((await app.inject({ url: `/api/agent/deliverables/${site.id}/app.js` })).body).toBe("console.log(1)");
    expect((await app.inject({ url: `/api/agent/deliverables/${site.id}/../secret.txt` })).statusCode).toBe(404); expect((await app.inject({ url: `/api/agent/deliverables/${site.id}/%2e%2e/secret.txt` })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/agent/deliverables/dl_nope" })).statusCode).toBe(404);
    expect(String((await app.inject({ url: `/api/agent/deliverables/${bin.id}` })).headers["content-disposition"])).toContain("attachment");
    await app.close();
  });
});

describe("tables", () => {
  it("CSV quotes commas, quotes and newlines; Markdown tables escape pipes", () => {
    const rows = [{ item: 'A, "Inc"', note: "line1\nline2", tags: ["x", "y"] }, { item: "B|C" }];
    expect(toCsv(rows, ["item", "note", "tags"])).toBe('item,note,tags\n"A, ""Inc""","line1\nline2",x; y\nB|C,,\n');
    expect(toMarkdownTable(rows, ["item", "tags"])).toContain("B\\|C");
  });
});

describe("wide research", () => {
  const mkDeps = (opts: { delay?: number; fail?: Set<string> } = {}) => {
    let live = 0, peak = 0; const searched: string[] = [];
    const deps = {
      search: async (q: string) => { searched.push(q); return [{ title: `About ${q}`, url: `https://x.test/${encodeURIComponent(q)}`, snippet: `snippet for ${q}` }]; },
      fetch: async (u: string) => ({ url: u, title: "Page", text: `Facts at ${u}` }),
      complete: (async (o: any) => {
        live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, opts.delay ?? 5)); live--;
        const item = o.messages[1].content.replace("Item: ", ""); const turns = o.messages.filter((m: any) => m.role === "tool").length;
        if (opts.fail?.has(item)) throw new Error("model exploded");
        if (turns === 0) return { text: "", toolCalls: [{ id: "c1", name: "web_search", args: { query: item } }], reasoning: "" };
        if (turns === 1) return { text: "", toolCalls: [{ id: "c2", name: "fetch_page", args: { url: `https://x.test/${encodeURIComponent(item)}` } }], reasoning: "" };
        return { text: "", toolCalls: [{ id: "c3", name: "finish", args: { summary: `${item} is great`, fields: { Price: `$${item.length}` }, sources: [`https://x.test/${encodeURIComponent(item)}`] } }], reasoning: "" };
      }) as any,
    };
    return { deps, stats: () => ({ peak, searched }) };
  };
  it("a sub-agent searches, reads, and reports summary, requested fields and the sources it used", async () => {
    const { deps } = mkDeps(); const row = await researchItem("Acme", "price and quality", ["Price", "Missing"], undefined, deps);
    expect(row).toMatchObject({ item: "Acme", ok: true, summary: "Acme is great", fields: { Price: "$4", Missing: "unknown" }, steps: 3 }); expect(row.sources[0]).toBe("https://x.test/Acme");
  });
  it("runs sub-agents in parallel but never more than the concurrency cap; failures become rows, not crashes", async () => {
    const { deps, stats } = mkDeps({ delay: 15, fail: new Set(["bad"]) });
    const items = ["a", "b", "bad", "c", "d", "e", "f", "g", "a"]; const progress: number[] = [];
    const rows = await runWide({ items, task: "do the thing", columns: ["Price"], deps, onRow: (_r, done) => progress.push(done) });
    expect(rows).toHaveLength(8); expect(stats().peak).toBeGreaterThan(1); expect(stats().peak).toBeLessThanOrEqual(CONCURRENCY);
    expect(rows.find((r) => r.item === "bad")).toMatchObject({ ok: false }); expect(rows.filter((r) => r.ok)).toHaveLength(7); expect(progress.at(-1)).toBe(8);
    await expect(runWide({ items: ["", "  "], task: "x task" })).rejects.toThrow(/at least one item/);
    expect((await runWide({ items: Array.from({ length: 100 }, (_, i) => `i${i}`), task: "cap test", deps: mkDeps().deps })).length).toBe(MAX_ITEMS);
  });
  it("a sub-agent that never finishes stops at the step limit", async () => {
    const deps = { search: async () => [], fetch: async () => ({ url: "", title: "", text: "" }), complete: (async () => ({ text: "", toolCalls: [{ id: "x", name: "web_search", args: { query: "q" } }], reasoning: "" })) as any };
    const row = await researchItem("loop", "t", undefined, undefined, deps); expect(row).toMatchObject({ ok: false, steps: SUB_STEPS });
  });
  it("outputs: CSV + report deliverables with a synthesis that sees only the findings", async () => {
    const { deps } = mkDeps(); const rows = await runWide({ items: ["Alpha", "Beta"], task: "compare prices", columns: ["Price"], deps });
    let prompt = ""; const report = await synthesize("compare prices", rows, undefined, (async (o: any) => { prompt = o.messages[1].content; return { text: "Alpha leads.", toolCalls: [], reasoning: "" }; }) as any);
    expect(report).toBe("Alpha leads."); expect(prompt).toContain("Alpha is great"); expect(prompt).toContain("Price: $5");
    expect(await synthesize("x", [{ item: "a", summary: "", fields: {}, sources: [], ok: false, steps: 0 }])).toMatch(/nothing to synthesize/);
    const out = writeWideOutputs("r9", ws, "Compare prices!", rows, ["Price"], report);
    expect(fs.readFileSync(out.csv.path, "utf8").split("\n")[0]).toBe("item,Price,summary,sources"); expect(fs.readFileSync(out.md.path, "utf8")).toContain("Alpha leads."); expect(listDeliverables("r9")).toHaveLength(2);
  });
  it("a whole run through the real router/model client: steps per item, table + report deliverables, Inbox, live events", async () => {
    setStubHandler((req) => {
      const sys = req.messages[0]!.content;
      if (/You research ONE item/.test(sys)) { const item = req.messages[1]!.content.replace("Item: ", ""); const tools = req.messages.filter((m) => m.role === "tool").length; return tools === 0 ? { text: "", toolCalls: [{ id: "a", name: "web_search", args: { query: item } }] } : { text: "", toolCalls: [{ id: "b", name: "finish", args: { summary: `${item}: fine`, fields: { Rating: "5" }, sources: ["https://example.test/x"] } }] }; }
      if (/conclusion of a multi-item research study/.test(sys)) return "All items are fine.";
      return "ok";
    });
    setStubSearch((q) => [{ title: `Result for ${q}`, url: `https://example.test/${encodeURIComponent(q)}`, snippet: "s" }]);
    const id = startWide({ items: ["Tool A", "Tool B", "Tool C"], task: "rate each tool", columns: ["Rating"] }); const events: string[] = []; subscribe(id, (e) => events.push(e.type));
    await runFinished(id); const run = getRun(id);
    expect(run).toMatchObject({ status: "done", kind: "wide" }); expect(run.result).toContain("All items are fine."); expect(run.result).toContain("3/3");
    expect(runSteps(id).map((s) => s.tool)).toEqual(["research_item", "research_item", "research_item"]); expect(listDeliverables(id).map((d) => d.mime).sort()).toEqual(["text/csv", "text/markdown"]);
    expect(fs.readFileSync(listDeliverables(id).find((d) => d.mime === "text/csv")!.path, "utf8")).toContain("Tool B,5,Tool B: fine"); expect(listInbox()[0]!.ref).toBe(id); expect(events).toContain("wide");
  });
});

describe("autonomous long task (agent loop with the new tools)", () => {
  it("plans, writes code, runs it in the sandbox, builds a PDF and delivers it; long mode raises the step budget", async () => {
    const calls: [string, any][] = [
      ["plan_update", { items: [{ text: "Compute", status: "doing" }, { text: "Report", status: "pending" }] }],
      ["file_write", { path: "calc.py", content: "print('RESULT', sum(i*i for i in range(10)))\n" }],
      ["shell_run", { command: "python3 calc.py" }],
      ["make_pdf", { path: "result.pdf", title: "Result", markdown: "# Result\n\nThe sum of squares is 285." }],
      ["plan_update", { items: [{ text: "Compute", status: "done" }, { text: "Report", status: "done" }] }],
      ["finish", { summary: "Done: result.pdf delivered." }],
    ]; let i = 0; let sawOutput = false;
    setStubHandler((req) => { if (!req.tools?.length) return "ok"; const last = req.messages.at(-1); if (last?.role === "tool" && /RESULT 285/.test(last.content)) sawOutput = true; const c = calls[i++]; return c ? { text: "", toolCalls: [{ id: `c${i}`, name: c[0], args: c[1] }] } : "done"; });
    const id = startRun({ goal: "compute the sum of squares below 10 and give me a PDF", long: true }); const evs: string[] = []; subscribe(id, (e) => evs.push(e.type)); await runFinished(id);
    const run = getRun(id); expect(run).toMatchObject({ status: "done", max_steps: 60 }); expect(JSON.parse(run.plan).every((p: any) => p.status === "done")).toBe(true);
    expect(sawOutput).toBe(true); expect(fs.existsSync(path.join(runWorkspace(id), "calc.py"))).toBe(true); expect(fs.readFileSync(path.join(runWorkspace(id), "result.pdf")).subarray(0, 4).toString()).toBe("%PDF");
    expect(listDeliverables(id)).toHaveLength(1); expect(evs).toEqual(expect.arrayContaining(["plan", "terminal", "deliverable", "step", "done"]));
    expect(runSteps(id).map((s) => s.tool)).toEqual(calls.map((c) => c[0]));
  });
});
