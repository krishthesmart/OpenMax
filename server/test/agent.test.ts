import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshEnv } from "./helpers.js";
import { setConfigForTest } from "../src/config.js";
import { getDb } from "../src/db.js";
import { setStubHandler } from "./fake.js";
import { ProviderError } from "../src/providers/types.js";
import { TOOLS, executeTool, type ToolContext } from "../src/modules/agent/tools.js";
import { decide, getApproval, listApprovals } from "../src/modules/agent/approvals.js";
import { parseAction, runFinished, runSteps, setBrowserFactory, startRun, stopRun, getRun } from "../src/modules/agent/agent.js";
import { setMailTransportForTest } from "../src/modules/agent/mail.js";
import { deleteSchedule, listSchedules, saveSchedule, trigger, validateCron } from "../src/modules/agent/scheduler.js";
import { listInbox } from "../src/modules/inbox.js";
import type { BrowserDriver, PageView } from "../src/modules/agent/browser.js";
import type { ElementInfo } from "../src/modules/agent/gates.js";

class FakeBrowser implements BrowserDriver {
  log: string[] = []; url = "";
  els: ElementInfo[] = [
    { ref: 1, tag: "input", name: "email", label: "Email", inForm: true }, { ref: 2, tag: "input", name: "q", inForm: false },
    { ref: 3, tag: "button", text: "Place order", type: "submit", inForm: true }, { ref: 4, tag: "a", text: "About" }, { ref: 5, tag: "input", type: "password", name: "pw", inForm: true },
  ];
  view(): PageView { return { url: this.url, title: "Shop", text: "Welcome to the shop", elements: this.els }; }
  async open(u: string) { this.log.push(`open ${u}`); this.url = u; return this.view(); }
  async click(r: number) { this.log.push(`click ${r}`); return this.view(); }
  async type(r: number, t: string) { this.log.push(`type ${r} ${t}`); return this.view(); }
  async select(r: number, v: string) { this.log.push(`select ${r} ${v}`); return this.view(); }
  async read() { return this.view(); }
  async describe(r: number) { return this.els.find((e) => e.ref === r); }
  currentUrl() { return this.url; }
  async screenshot() { return Buffer.from("PNG"); }
  async close() { this.log.push("close"); }
}

let tmp: string, sandbox: string, browser: FakeBrowser;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "om-agent-")); sandbox = path.join(tmp, "sandbox");
  freshEnv({ DATA_DIR: tmp, AGENT_SANDBOX: sandbox });
  browser = new FakeBrowser(); setBrowserFactory(() => browser); setMailTransportForTest(undefined);
});
afterEach(() => { setBrowserFactory(undefined); setMailTransportForTest(undefined); fs.rmSync(tmp, { recursive: true, force: true }); });

const wait = async (f: () => any, ms = 4000) => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
const ctx = (over: Partial<ToolContext> = {}): ToolContext => { fs.mkdirSync(sandbox, { recursive: true }); return { runId: "r1", sandbox: fs.realpathSync(sandbox), signal: new AbortController().signal, browser: () => browser, unattended: false, ...over }; };
/** A scripted "model": each turn returns the next tool call. */
const script = (calls: ([string, any] | string)[]) => { let i = 0; setStubHandler((req) => { if (!req.tools?.length) return "ok"; const c = calls[i++]; if (c === undefined) return { text: "", toolCalls: [{ id: `c${i}`, name: "finish", args: { summary: "done (script ended)" } }] }; if (typeof c === "string") return c; return { text: "", toolCalls: [{ id: `c${i}`, name: c[0], args: c[1] }] }; }); };

describe("executor enforces gates in code", () => {
  it("a gated side effect does NOT run until a human approves that approval", async () => {
    let sent = 0; setMailTransportForTest({ sendMail: async () => { sent++; return { messageId: "m1" }; } });
    const p = executeTool("send_email", { to: ["a@b.com"], subject: "Hi", body: "Hello" }, ctx());
    const ap = await wait(() => listApprovals("pending")[0]);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toBe(0); expect(ap.kind).toBe("send_message");
    await decide(ap.id, "approve");
    const out = await p;
    expect(out.status).toBe("ok"); expect(sent).toBe(1);
  });
  it("rejection means the side effect never happens and the model is told not to retry", async () => {
    let sent = 0; setMailTransportForTest({ sendMail: async () => { sent++; return {}; } });
    const p = executeTool("send_email", { to: ["a@b.com"], subject: "Hi", body: "Hello" }, ctx());
    await decide((await wait(() => listApprovals("pending")[0])).id, "reject");
    const out = await p;
    expect(out.status).toBe("rejected"); expect(out.message).toMatch(/Do not retry/); expect(sent).toBe(0);
  });
  it("an unconfigured SMTP fails fast WITHOUT asking for approval", async () => {
    const out = await executeTool("send_email", { to: ["a@b.com"], subject: "Hi", body: "x" }, ctx());
    expect(out.status).toBe("error"); expect(out.message).toMatch(/SMTP_HOST/); expect(listApprovals().length).toBe(0);
  });
  it("aborting while waiting cancels the approval", async () => {
    setMailTransportForTest({ sendMail: async () => ({}) });
    const ac = new AbortController(); const p = executeTool("send_email", { to: ["a@b.com"], subject: "s", body: "b" }, ctx({ signal: ac.signal }));
    const ap = await wait(() => listApprovals("pending")[0]); ac.abort();
    await expect(p).rejects.toThrow(); expect(getApproval(ap.id)!.status).toBe("cancelled");
  });
  it("an approval can only be decided once", async () => {
    setMailTransportForTest({ sendMail: async () => ({}) });
    const p = executeTool("send_email", { to: ["a@b.com"], subject: "s", body: "b" }, ctx());
    const ap = await wait(() => listApprovals("pending")[0]); await decide(ap.id, "reject"); await p;
    await expect(decide(ap.id, "approve")).rejects.toThrow(/already rejected/);
  });
  it("browser: the click handler is not invoked before approval; typing a password is blocked outright", async () => {
    await executeTool("browser_open", { url: "https://shop.test/cart" }, ctx());
    const p = executeTool("browser_click", { ref: 3 }, ctx());
    const ap = await wait(() => listApprovals("pending")[0]);
    expect(ap.kind).toBe("payment"); expect(browser.log).toEqual(["open https://shop.test/cart"]);
    await decide(ap.id, "approve"); expect((await p).status).toBe("ok"); expect(browser.log).toContain("click 3");
    const blocked = await executeTool("browser_type", { ref: 5, text: "hunter2" }, ctx());
    expect(blocked.status).toBe("blocked"); expect(browser.log.some((l) => l.startsWith("type 5"))).toBe(false); expect(listApprovals("pending").length).toBe(0);
  });
  it("ungated actions run immediately; bad arguments and unknown tools are reported, not thrown", async () => {
    expect((await executeTool("browser_click", { ref: 4 }, ctx())).status).toBe("ok");
    expect((await executeTool("file_write", { path: "n.txt", content: "hi" }, ctx())).status).toBe("ok");
    expect((await executeTool("file_write", { path: 5 }, ctx())).message).toMatch(/Invalid arguments/);
    expect((await executeTool("rm_rf", {}, ctx())).message).toMatch(/Unknown tool/);
  });
  it("sandbox path escapes are refused; file deletes are gated; cards are redacted before storage", async () => {
    expect((await executeTool("file_write", { path: "../evil.txt", content: "x" }, ctx())).status).toBe("error");
    expect((await executeTool("file_write", { path: "/etc/x", content: "x" }, ctx())).status).toBe("error");
    expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false);
    await executeTool("file_write", { path: "keep.txt", content: "card 4242 4242 4242 4242 end" }, ctx());
    expect(fs.readFileSync(path.join(sandbox, "keep.txt"), "utf8")).toContain("[card number redacted]");
    const p = executeTool("file_delete", { path: "keep.txt" }, ctx());
    const ap = await wait(() => listApprovals("pending")[0]); expect(fs.existsSync(path.join(sandbox, "keep.txt"))).toBe(true);
    await decide(ap.id, "approve"); await p; expect(fs.existsSync(path.join(sandbox, "keep.txt"))).toBe(false);
  });
  it("calendar_add writes a valid .ics into the sandbox and rejects bad dates", async () => {
    const ok = await executeTool("calendar_add", { title: "Dentist", start: "2026-03-14T15:00:00Z" }, ctx());
    expect(ok.status).toBe("ok");
    const f = fs.readdirSync(path.join(sandbox, "calendar"))[0]!; expect(fs.readFileSync(path.join(sandbox, "calendar", f), "utf8")).toContain("SUMMARY:Dentist");
    expect((await executeTool("calendar_add", { title: "x", start: "next tuesday-ish" }, ctx())).message).toMatch(/ISO 8601/);
  });
  it("ask_user waits for a typed answer", async () => {
    const p = executeTool("ask_user", { question: "Which day?" }, ctx());
    const ap = await wait(() => listApprovals("pending")[0]); expect(ap.kind).toBe("question");
    await decide(ap.id, "approve", "Friday"); expect((await p).message).toContain("Friday");
  });
  it("there is no tool that can approve anything", () => { expect([...TOOLS.keys()].some((k) => /approve|decide|confirm/.test(k))).toBe(false); });
});

describe("agent loop", () => {
  it("runs a tool loop to finish, logs every step, redacts, and posts the result to the Inbox", async () => {
    script([["web_search", { query: "weather" }], ["file_write", { path: "notes.txt", content: "card 4242424242424242" }], ["finish", { summary: "All done" }]]);
    const id = startRun({ goal: "research the weather and save notes" }); await runFinished(id);
    const run = getRun(id); expect(run).toMatchObject({ status: "done", result: "All done" });
    expect(runSteps(id).map((s) => s.tool)).toEqual(["web_search", "file_write", "finish"]);
    expect(JSON.stringify(runSteps(id))).not.toContain("4242424242424242");
    expect(listInbox()[0]).toMatchObject({ kind: "agent_result", ref: id }); expect(listInbox()[0]!.title).toContain("✓");
  });
  it("pauses for approval mid-run and resumes after the click; the browser closes at the end", async () => {
    script([["browser_open", { url: "https://shop.test" }], ["browser_click", { ref: 3 }], ["finish", { summary: "ordered" }]]);
    const id = startRun({ goal: "buy the thing" });
    const ap = await wait(() => listApprovals("pending")[0]);
    expect(browser.log).not.toContain("click 3"); expect(getRun(id).status).toBe("running");
    await decide(ap.id, "approve"); await runFinished(id);
    expect(browser.log).toContain("click 3"); expect(browser.log.at(-1)).toBe("close"); expect(getRun(id).status).toBe("done");
    expect(runSteps(id).find((s) => s.tool === "browser_click")!.screenshot).toMatch(/step-2\.png/);
  });
  it("a rejected action is reported to the model and the run continues without performing it", async () => {
    let told = ""; let i = 0;
    setStubHandler((req) => { if (!req.tools?.length) return "ok"; i++; if (i === 1) return { text: "", toolCalls: [{ id: "a", name: "browser_open", args: { url: "https://shop.test" } }] }; if (i === 2) return { text: "", toolCalls: [{ id: "b", name: "browser_click", args: { ref: 3 } }] }; told = req.messages.at(-1)!.content; return { text: "", toolCalls: [{ id: "c", name: "finish", args: { summary: "gave up" } }] }; });
    const id = startRun({ goal: "buy" }); await decide((await wait(() => listApprovals("pending")[0])).id, "reject"); await runFinished(id);
    expect(told).toMatch(/\[rejected\]/); expect(browser.log).not.toContain("click 3"); expect(getRun(id).result).toBe("gave up");
  });
  it("stop aborts the run, cancels pending approvals and records the stop", async () => {
    script([["browser_open", { url: "https://shop.test" }], ["browser_click", { ref: 3 }]]);
    const id = startRun({ goal: "buy" }); const ap = await wait(() => listApprovals("pending")[0]);
    expect(stopRun(id)).toBe(true); await runFinished(id);
    expect(getRun(id).status).toBe("stopped"); expect(getApproval(ap.id)!.status).toBe("cancelled"); expect(browser.log).not.toContain("click 3");
  });
  it("is capped at the step limit", async () => {
    let n = 0; setStubHandler((req) => (req.tools?.length ? { text: "", toolCalls: [{ id: `x${n}`, name: "file_list", args: { path: `d${n++}` } }] } : "ok"));
    const id = startRun({ goal: "loop forever", maxSteps: 5 }); await runFinished(id);
    expect(getRun(id).status).toBe("stopped"); expect(getRun(id).result).toMatch(/5 steps/); expect(runSteps(id)).toHaveLength(5);
  });
  it("defaults to 25 steps", async () => { const m = await import("../src/modules/agent/agent.js"); expect(m.MAX_STEPS).toBe(25); });
  it("breaks identical repeated calls", async () => {
    script(Array.from({ length: 4 }, () => ["file_list", {}] as [string, any]).concat([["finish", { summary: "ok" }]]));
    const id = startRun({ goal: "g" }); await runFinished(id);
    expect(runSteps(id).filter((s) => s.status === "error")).toHaveLength(2);
  });
  it("falls back to the JSON action protocol when the model has no tool calling, and parses prose-wrapped JSON", async () => {
    let jsonTurns = 0;
    setStubHandler((req) => {
      if (req.tools?.length) throw new ProviderError("this model does not support tool calling", "x", 400);
      jsonTurns++;
      return jsonTurns === 1 ? 'Sure! ```json\n{"thought":"list","tool":"file_list","args":{}}\n```' : '{"tool":"finish","args":{"summary":"via json"}}';
    });
    const id = startRun({ goal: "g" }); await runFinished(id);
    expect(getRun(id)).toMatchObject({ status: "done", result: "via json" }); expect(runSteps(id).map((s) => s.tool)).toEqual(["file_list", "finish"]);
  });
  it("parseAction accepts common shapes", () => {
    expect(parseAction('{"tool":"a","args":{"x":1}}')).toMatchObject({ name: "a", args: { x: 1 } });
    expect(parseAction('{"name":"a","arguments":"{\\"x\\":2}"}')).toMatchObject({ name: "a", args: { x: 2 } });
    expect(parseAction('{"action":"a"}')).toMatchObject({ name: "a", args: {} });
    expect(parseAction("no json")).toBeUndefined();
  });
  it("a model that never calls a tool is nudged once, then its text becomes the result", async () => {
    setStubHandler(() => "I think the answer is 42.");
    const id = startRun({ goal: "what is the answer" }); await runFinished(id);
    expect(getRun(id)).toMatchObject({ status: "done", result: "I think the answer is 42." });
  });
  it("a provider failure ends the run with a clear error and an Inbox entry", async () => {
    setStubHandler(() => { throw new ProviderError("provider exploded", "x", 500); });
    const id = startRun({ goal: "g" }); await runFinished(id);
    expect(getRun(id).status).toBe("error"); expect(listInbox()[0]!.title).toContain("✗");
  });
});

describe("unattended (scheduled) runs", () => {
  it("queue deferrable actions to the Inbox instead of blocking, and execute them only after approval", async () => {
    let sent: any[] = []; setMailTransportForTest({ sendMail: async (m) => { sent.push(m); return { messageId: "x" }; } });
    script([["send_email", { to: ["boss@x.com"], subject: "Report", body: "Done" }], ["finish", { summary: "queued the email" }]]);
    const id = startRun({ goal: "email the report", unattended: true }); await runFinished(id);
    expect(getRun(id).status).toBe("done"); expect(sent).toHaveLength(0);
    const ap = listApprovals("pending")[0]!; expect(ap.kind).toBe("send_message"); expect(ap.payload.deferred).toBe(true);
    expect(runSteps(id)[0]!.status).toBe("pending_approval");
    await decide(ap.id, "approve"); expect(sent).toHaveLength(1); expect(sent[0].to).toEqual(["boss@x.com"]);
  });
  it("rejecting a deferred action sends nothing", async () => {
    let sent = 0; setMailTransportForTest({ sendMail: async () => { sent++; return {}; } });
    script([["send_email", { to: ["a@b.com"], subject: "s", body: "b" }], ["finish", { summary: "ok" }]]);
    const id = startRun({ goal: "g", unattended: true }); await runFinished(id);
    await decide(listApprovals("pending")[0]!.id, "reject"); expect(sent).toBe(0);
  });
  it("non-deferrable gated actions (browser clicks) are refused in unattended runs", async () => {
    script([["browser_open", { url: "https://shop.test" }], ["browser_click", { ref: 3 }], ["finish", { summary: "ok" }]]);
    const id = startRun({ goal: "g", unattended: true }); await runFinished(id);
    expect(runSteps(id)[1]!.status).toBe("blocked"); expect(browser.log).not.toContain("click 3"); expect(listApprovals("pending")).toHaveLength(0);
  });
});

describe("scheduler", () => {
  it("validates cron, persists, fires an unattended run, and deletes", async () => {
    expect(validateCron("0 8 * * 1-5")).toBe(true); expect(validateCron("not cron")).toBe(false);
    expect(() => saveSchedule({ name: "x", cron: "nope", goal: "goal here" })).toThrow(/valid cron/);
    const s = saveSchedule({ name: "Morning brief", cron: "0 8 * * *", goal: "summarize the news" });
    expect(listSchedules()).toHaveLength(1);
    script([["finish", { summary: "brief" }]]);
    const rid = trigger(s.id)!; await runFinished(rid);
    expect(getRun(rid)).toMatchObject({ status: "done", schedule_id: s.id, unattended: 1 });
    expect(listSchedules()[0]!.last_run).toBeGreaterThan(0);
    deleteSchedule(s.id); expect(listSchedules()).toHaveLength(0);
  });
});
void getDb; void setConfigForTest;
