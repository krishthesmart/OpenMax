import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { freshEnv } from "./helpers.js";
import { setStubHandler } from "../src/providers/stub.js";
import { MAX_ITERATIONS, applyEdits, cancelTask, createBranchInRepo, createTask, decidePlan, deleteTask, detectTestCommand, getTask, idle, pushTask, retryTask, validateEdits } from "../src/modules/codeagent/tasks.js";
import { runCommand, sanitizedEnv } from "../src/modules/codeagent/exec.js";
import { validateRemote } from "../src/modules/codeagent/git.js";
import { listInbox } from "../src/modules/inbox.js";

const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
let tmp: string, ws: string, repo: string;
const wait = async (f: () => any, ms = 8000) => { const t = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 10)); } };
const BUGGY = "function add(a, b) { return a - b; }\nmodule.exports = { add };\n";
const FIXED = "function add(a, b) { return a + b; }\nmodule.exports = { add };\n";
const TEST = "const { add } = require('./add');\nif (add(2, 3) !== 5) { console.error('FAIL add(2,3)=' + add(2, 3)); process.exit(1); }\nconsole.log('ok');\n";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "om-ct-")); ws = path.join(tmp, "ws"); repo = path.join(ws, "calc");
  fs.mkdirSync(repo, { recursive: true }); fs.writeFileSync(path.join(repo, "add.js"), BUGGY); fs.writeFileSync(path.join(repo, "test.js"), TEST);
  g(repo, "init", "-q", "-b", "main"); g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "init");
  freshEnv({ DATA_DIR: path.join(tmp, "data"), CODE_WORKSPACE: ws });
});
afterEach(async () => { await idle(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** A scripted "model": plan once, then a queue of edit responses. */
function model(edits: any[], planOver: any = {}) {
  const seen: string[] = []; let i = 0;
  setStubHandler((req) => {
    const sys = req.messages[0]!.content, user = req.messages.at(-1)!.content;
    if (/worth reading/.test(sys)) return '{"files":["add.js","test.js"]}';
    if (/planning a code change/.test(sys)) return JSON.stringify({ summary: "Fix add()", steps: ["Change - to +"], files_to_change: ["add.js"], test_command: "node test.js", risks: "none", ...planOver });
    if (/autonomous coding agent/.test(sys)) { seen.push(user); return JSON.stringify(edits[Math.min(i++, edits.length - 1)]); }
    return "{}";
  });
  return { seen };
}
const fix = { summary: "fix", edits: [{ path: "add.js", content: FIXED }] };
const start = async (over: any = {}) => { const t = createTask({ repo: "calc", instruction: "Fix the add function so add(2,3) is 5", ...over }); await wait(() => getTask(t.id)!.status === "awaiting_plan_approval"); return t.id; };

describe("happy path", () => {
  it("clones to a sandbox, waits for plan approval, edits, tests, commits a local branch with a diff — and never touches the original or pushes", async () => {
    const { seen } = model([fix]);
    const id = await start();
    let t = getTask(id)!;
    expect(t.plan.summary).toBe("Fix add()"); expect(t.test_cmd).toBe("node test.js");
    expect(fs.readFileSync(path.join(t.sandbox!, "add.js"), "utf8")).toBe(BUGGY); // no edits before approval
    expect(seen).toHaveLength(0);
    decidePlan(id, "approve"); await idle();
    t = getTask(id)!;
    expect(t.status).toBe("done"); expect(t.tests_passed).toBe(true); expect(t.iterations).toBe(1);
    expect(t.diff).toContain("-function add(a, b) { return a - b; }"); expect(t.diff).toContain("+function add(a, b) { return a + b; }");
    expect(g(t.sandbox!, "rev-parse", "--abbrev-ref", "HEAD")).toBe(t.branch); expect(t.branch).toMatch(/^openmax\/fix-the-add-function/);
    expect(g(t.sandbox!, "log", "-1", "--format=%s")).toContain("OpenMax:");
    expect(fs.readFileSync(path.join(repo, "add.js"), "utf8")).toBe(BUGGY); // original untouched
    expect(g(repo, "branch", "--list", t.branch!)).toBe(""); // not even a branch yet
    expect(listInbox().some((i) => i.kind === "code_task" && i.title.startsWith("✓"))).toBe(true);
  });
  it("detects test commands from project files", () => {
    const d = fs.mkdtempSync(path.join(tmp, "d-")); expect(detectTestCommand(d)).toBe("");
    fs.writeFileSync(path.join(d, "package.json"), '{"scripts":{"test":"vitest run"}}'); expect(detectTestCommand(d)).toBe("npm test --silent");
    fs.writeFileSync(path.join(d, "package.json"), '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}'); expect(detectTestCommand(d)).toBe("");
    fs.writeFileSync(path.join(d, "go.mod"), "module x"); expect(detectTestCommand(d)).toBe("go test ./...");
  });
});

describe("plan approval", () => {
  it("rejecting the plan stops everything: no edits, no model edit call", async () => {
    const { seen } = model([fix]); const id = await start();
    decidePlan(id, "reject"); await idle();
    expect(getTask(id)!.status).toBe("rejected"); expect(seen).toHaveLength(0); expect(fs.readFileSync(path.join(getTask(id)!.sandbox!, "add.js"), "utf8")).toBe(BUGGY);
    expect(() => decidePlan(id, "approve")).toThrow(/not waiting for plan approval/);
  });
  it("the human can edit the test command when approving; an empty command skips testing", async () => {
    model([fix]); const id = await start(); decidePlan(id, "approve", ""); await idle();
    const t = getTask(id)!; expect(t.status).toBe("done"); expect(t.tests_passed).toBeNull(); expect(t.summary).toMatch(/No tests were run/);
  });
});

describe("iteration", () => {
  it("feeds test failures back and succeeds on a later round", async () => {
    const { seen } = model([{ summary: "wrong", edits: [{ path: "add.js", content: "function add(a, b) { return a * b; }\nmodule.exports = { add };\n" }] }, fix]);
    const id = await start(); decidePlan(id, "approve"); await idle();
    const t = getTask(id)!; expect(t.iterations).toBe(2); expect(t.status).toBe("done");
    expect(seen[1]).toContain("The tests failed"); expect(seen[1]).toContain("FAIL add(2,3)=6");
  });
  it(`stops after ${MAX_ITERATIONS} failed rounds and hands back a branch marked needs_review`, async () => {
    model([{ summary: "nope", edits: [{ path: "add.js", content: "function add(a, b) { return 0; }\nmodule.exports = { add };\n" }] }]);
    const id = await start(); decidePlan(id, "approve"); await idle();
    const t = getTask(id)!; expect(t.iterations).toBe(MAX_ITERATIONS); expect(t.status).toBe("needs_review"); expect(t.tests_passed).toBe(false);
    expect(t.diff).toBeTruthy(); expect(t.summary).toMatch(/still failing/);
  });
  it("a hanging test command is killed at the timeout and reported to the model", async () => {
    const { seen } = model([fix, fix], { test_command: "sleep 30" });
    const id = await start({ timeoutSec: 10 });
    getDb().prepare("UPDATE code_tasks SET timeout_sec=1 WHERE id=?").run(id); // keep the test fast
    decidePlan(id, "approve", "sleep 30"); await wait(() => seen.length >= 2, 10000);
    expect(seen[1]).toContain("timed out"); cancelTask(id); await idle();
  }, 20000);
});

describe("edit safety", () => {
  it("rejects path escapes and .git edits, applies nothing, and tells the model why", async () => {
    const { seen } = model([{ edits: [{ path: "add.js", content: FIXED }, { path: "../../evil.txt", content: "x" }, { path: ".git/config", content: "x" }] }, fix]);
    const id = await start(); decidePlan(id, "approve"); await idle();
    expect(seen[1]).toContain("rejected"); expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false); expect(fs.existsSync(path.join(path.dirname(getTask(id)!.sandbox!), "evil.txt"))).toBe(false);
    expect(getTask(id)!.status).toBe("done");
  });
  it("validateEdits / applyEdits: patch ops, deletes, atomicity", () => {
    const d = fs.mkdtempSync(path.join(tmp, "e-")); fs.writeFileSync(path.join(d, "a.txt"), "hello world\n"); fs.writeFileSync(path.join(d, "b.txt"), "bye\n");
    const v = validateEdits(d, { edits: [{ path: "a.txt", ops: [{ op: "replace", find: "world", replace: "there" }] }, { path: "b.txt", delete: true }, { path: "c.txt", content: "new" }] });
    expect(v.errors).toEqual([]); const r = applyEdits(d, v.edits);
    expect(r.ok).toBe(true); expect(fs.readFileSync(path.join(d, "a.txt"), "utf8")).toBe("hello there\n"); expect(fs.existsSync(path.join(d, "b.txt"))).toBe(false); expect(fs.readFileSync(path.join(d, "c.txt"), "utf8")).toBe("new\n");
    fs.writeFileSync(path.join(d, "a.txt"), "hello world\n");
    const bad = applyEdits(d, validateEdits(d, { edits: [{ path: "a.txt", content: "CHANGED\n" }, { path: "a.txt", ops: [{ op: "replace", find: "nope", replace: "x" }] }] }).edits);
    expect(bad.ok).toBe(false); expect(fs.readFileSync(path.join(d, "a.txt"), "utf8")).toBe("hello world\n");
    expect(validateEdits(d, { edits: [] }).errors[0]).toMatch(/no edits/);
    expect(validateEdits(d, { edits: [{ path: "x.txt" }] }).errors[0]).toMatch(/needs content/);
  });
});

describe("inputs", () => {
  it("only accepts repos inside the workspace or plain https/ssh URLs", () => {
    expect(() => createTask({ repo: "../../etc", instruction: "do something please" })).toThrow();
    expect(() => createTask({ repo: "/etc", instruction: "do something please" })).toThrow();
    expect(() => createTask({ repo: "ext::sh -c 'touch /tmp/pwn'", instruction: "do something please" })).toThrow();
    expect(() => createTask({ repo: "https://", instruction: "do something please" })).toThrow(/git URL/);
    expect(validateRemote("https://github.com/owner/repo.git")).toBe(true); expect(validateRemote("git@github.com:owner/repo.git")).toBe(true);
    expect(validateRemote("file:///etc/passwd")).toBe(false); expect(validateRemote("--upload-pack=evil")).toBe(false); expect(validateRemote("ext::sh -c id")).toBe(false);
  });
  it("a plain (non-git) folder is snapshotted into a baseline commit", async () => {
    const plain = path.join(ws, "plain"); fs.mkdirSync(plain); fs.writeFileSync(path.join(plain, "add.js"), BUGGY); fs.writeFileSync(path.join(plain, "test.js"), TEST);
    model([fix]); const t = createTask({ repo: "plain", instruction: "fix the add function please" }); await wait(() => getTask(t.id)!.status === "awaiting_plan_approval");
    decidePlan(t.id, "approve"); await idle(); expect(getTask(t.id)!.status).toBe("done"); expect(fs.existsSync(path.join(plain, ".git"))).toBe(false);
  });
  it("a missing folder is refused up front with a fix-it message", () => {
    expect(() => createTask({ repo: "does-not-exist", instruction: "fix something in here" })).toThrow(/not a folder inside the code workspace/);
  });
});

describe("sandboxed command execution", () => {
  it("strips secrets from the environment", async () => {
    const env = sanitizedEnv({}, { PATH: "/bin", HOME: "/h", GROQ_API_KEY: "x", MY_TOKEN: "y", SMTP_PASS: "z", NVIDIA_API_KEY: "q", OPENMAX_PASSWORD: "p", FOO: "bar" });
    expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", FOO: "bar", CI: "1" }); for (const k of ["GROQ_API_KEY", "MY_TOKEN", "SMTP_PASS", "NVIDIA_API_KEY", "OPENMAX_PASSWORD"]) expect(env[k]).toBeUndefined();
    process.env.GROQ_API_KEY = "secret-xyz";
    const r = await runCommand("echo key=[$GROQ_API_KEY]", { cwd: tmp, timeoutMs: 5000 }); expect(r.output).toContain("key=[]"); delete process.env.GROQ_API_KEY;
  });
  it("kills the whole process group on timeout and on abort", async () => {
    const t = await runCommand("sleep 30 & sleep 30", { cwd: tmp, timeoutMs: 300 }); expect(t.timedOut).toBe(true); expect(t.ms).toBeLessThan(3000);
    const ac = new AbortController(); setTimeout(() => ac.abort(), 100);
    const a = await runCommand("sleep 30", { cwd: tmp, timeoutMs: 20000, signal: ac.signal }); expect(a.aborted).toBe(true);
    expect((await runCommand("exit 3", { cwd: tmp, timeoutMs: 2000 })).code).toBe(3);
  });
});

describe("parallel tasks", () => {
  it("runs several tasks at once in separate sandboxes without interference", async () => {
    model([fix]);
    const ids = [1, 2, 3, 4].map((n) => createTask({ repo: "calc", instruction: `Fix the add function variant ${n}` }).id);
    await wait(() => ids.every((i) => getTask(i)!.status === "awaiting_plan_approval"));
    const sandboxes = new Set(ids.map((i) => getTask(i)!.sandbox)); expect(sandboxes.size).toBe(4);
    ids.forEach((i) => decidePlan(i, "approve")); await idle();
    expect(ids.every((i) => getTask(i)!.status === "done")).toBe(true); expect(new Set(ids.map((i) => getTask(i)!.branch)).size).toBe(4);
  });
});

describe("push is human-only", () => {
  it("never pushes during a run; export + push need explicit confirmation, then work against a bare remote; no force", async () => {
    const bare = path.join(tmp, "remote.git"); g(tmp, "init", "-q", "--bare", bare);
    g(repo, "remote", "add", "origin", bare); g(repo, "push", "-q", "origin", "main");
    model([fix]); const id = await start(); decidePlan(id, "approve"); await idle();
    const t = getTask(id)!; expect(g(bare, "branch", "--list")).not.toContain("openmax"); // done, but nothing pushed
    await expect(pushTask(id, false)).rejects.toThrow(/explicit confirmation/);
    await expect(pushTask(id, true)).rejects.toThrow(/Create the branch in your repository first/);
    await expect(createBranchInRepo(id, false)).rejects.toThrow(/explicit confirmation/);
    await createBranchInRepo(id, true);
    expect(g(repo, "branch", "--list", t.branch!)).toContain(t.branch!); expect(g(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main"); expect(fs.readFileSync(path.join(repo, "add.js"), "utf8")).toBe(BUGGY);
    expect(g(bare, "branch", "--list")).not.toContain("openmax");
    await pushTask(id, true);
    expect(g(bare, "branch", "--list")).toContain(t.branch!); expect(getTask(id)!.pushed).toBe(true);
    await expect(pushTask(id, true)).rejects.toThrow(/already pushed/);
  });
  it("cannot push a task that is not finished", async () => {
    model([fix]); const id = await start();
    await expect(pushTask(id, true)).rejects.toThrow(/finished/);
  });
  it("source has exactly one push call site, inside pushTask", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/modules/codeagent/tasks.ts"), "utf8");
    expect(src.match(/\["push"/g)).toHaveLength(1);
    expect(src).not.toMatch(/--force|"-f"/);
  });
});

describe("cancel and retry", () => {
  it("cancelling a running test kills it; retry starts over; delete cleans the sandbox", async () => {
    model([fix], { test_command: "sleep 30" }); const id = await start(); decidePlan(id, "approve", "sleep 30");
    await wait(() => getTask(id)!.status === "testing"); cancelTask(id); await idle();
    expect(getTask(id)!.status).toBe("cancelled");
    const sb = path.dirname(getTask(id)!.sandbox!);
    retryTask(id); await wait(() => getTask(id)!.status === "awaiting_plan_approval"); expect(getTask(id)!.iterations).toBe(0);
    deleteTask(id); await idle(); expect(fs.existsSync(sb)).toBe(false); expect(getTask(id)).toBeUndefined();
  }, 20000);
});
import { getDb } from "../src/db.js";
