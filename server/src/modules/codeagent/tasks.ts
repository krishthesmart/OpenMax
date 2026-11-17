import fs from "node:fs";
import path from "node:path";
import { cfg, dataPath } from "../../config.js";
import { getDb, now, uid } from "../../db.js";
import { routedJSON } from "../../router/router.js";
import { applyPatch, parseOps, type PatchOp } from "../../shared/patch.js";
import { addInbox } from "../inbox.js";
import { IGNORED, listTree, safeResolve, workspaceRoot } from "../workspace.js";
import { runCommand } from "./exec.js";
import { git, slug, validateRemote } from "./git.js";

export const MAX_ITERATIONS = 5;
export const MAX_PARALLEL = 3;
export type TaskStatus = "queued" | "cloning" | "planning" | "awaiting_plan_approval" | "working" | "testing" | "done" | "needs_review" | "failed" | "rejected" | "cancelled";
const ACTIVE: TaskStatus[] = ["queued", "cloning", "planning", "working", "testing"];

export interface CodeTask {
  id: string; repo: string; instruction: string; status: TaskStatus; plan: any | null; branch: string | null; diff: string | null; log: { ts: number; level: string; msg: string }[];
  iterations: number; sandbox: string | null; error: string | null; created_at: number; updated_at: number; test_cmd: string | null; pushed: boolean; base_sha: string | null;
  summary: string | null; test_output: string | null; tests_passed: boolean | null; local_only: boolean; timeout_sec: number; repo_branch_created: boolean;
}
const row = (r: any): CodeTask => ({ ...r, plan: r.plan ? JSON.parse(r.plan) : null, log: JSON.parse(r.log ?? "[]"), pushed: !!r.pushed, local_only: !!r.local_only, repo_branch_created: !!r.repo_branch_created, tests_passed: r.tests_passed == null ? null : !!r.tests_passed });
export const getTask = (id: string) => { const r = getDb().prepare("SELECT * FROM code_tasks WHERE id=?").get(id); return r ? row(r) : undefined; };
export const listTasks = () => (getDb().prepare("SELECT * FROM code_tasks ORDER BY created_at DESC LIMIT 100").all() as any[]).map((r) => { const t = row(r); return { ...t, diff: t.diff ? `${t.diff.split("\n").length} lines` : null, log: t.log.slice(-3) }; });
const sandboxRoot = () => { const d = dataPath("sandboxes"); fs.mkdirSync(d, { recursive: true }); return d; };
const set = (id: string, patch: Record<string, unknown>) => {
  const keys = Object.keys(patch);
  getDb().prepare(`UPDATE code_tasks SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=? WHERE id=?`).run(...keys.map((k) => (typeof patch[k] === "object" && patch[k] !== null ? JSON.stringify(patch[k]) : typeof patch[k] === "boolean" ? (patch[k] ? 1 : 0) : patch[k])), now(), id);
};
function log(id: string, msg: string, level = "info") {
  const t = getTask(id); if (!t) return;
  set(id, { log: [...t.log, { ts: now(), level, msg: msg.slice(0, 1500) }].slice(-300) });
}

const controllers = new Map<string, AbortController>();
const running = new Set<string>();
const waiting: string[] = [];
const pump = () => { while (running.size < MAX_PARALLEL && waiting.length) { const id = waiting.shift()!; running.add(id); void runTask(id).finally(() => { running.delete(id); pump(); }); } };
export const idle = async () => { while (running.size || waiting.length) await new Promise((r) => setTimeout(r, 10)); };
function schedule(id: string) { if (!running.has(id) && !waiting.includes(id)) { waiting.push(id); pump(); } }

export function createTask(o: { repo: string; instruction: string; localOnly?: boolean; timeoutSec?: number }): CodeTask {
  const repo = o.repo.trim();
  if (!repo) throw Object.assign(new Error("Enter a repository."), { status: 400 });
  if (!/^(https?:|git@|ssh:)/.test(repo)) {
    // local paths must be an existing folder inside CODE_WORKSPACE
    const abs = safeResolve(workspaceRoot(), repo);
    if (repo.includes("::") || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw Object.assign(new Error(`"${repo}" is not a folder inside the code workspace.`), { status: 400, fix: `Put the project under ${workspaceRoot()} (CODE_WORKSPACE) or use an https/ssh git URL.` });
  }
  else if (!validateRemote(repo)) throw Object.assign(new Error("That does not look like a plain https/ssh git URL."), { status: 400, fix: "Use https://host/owner/repo.git or git@host:owner/repo.git." });
  if (o.instruction.trim().length < 5) throw Object.assign(new Error("Describe what the task should do."), { status: 400 });
  const id = uid("ct_");
  getDb().prepare("INSERT INTO code_tasks(id,repo,instruction,status,log,created_at,updated_at,local_only,timeout_sec) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, repo, o.instruction.trim(), "queued", "[]", now(), now(), o.localOnly ? 1 : 0, Math.min(600, Math.max(10, o.timeoutSec ?? 120)));
  schedule(id);
  return getTask(id)!;
}

// ───────── stages ─────────
const COPY_SKIP = new Set([...IGNORED, ".venv", "venv"]);
function copyTree(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (COPY_SKIP.has(e.name) || e.isSymbolicLink()) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d);
  }
}

async function stageClone(t: CodeTask) {
  set(t.id, { status: "cloning" });
  const dir = path.join(sandboxRoot(), t.id); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const repoDir = path.join(dir, "repo");
  if (/^(https?:|git@|ssh:)/.test(t.repo)) { log(t.id, `Cloning ${t.repo}…`); await git(dir, ["clone", "--depth", "50", "--", t.repo, "repo"], { timeoutMs: 300_000 }); }
  else {
    const src = safeResolve(workspaceRoot(), t.repo);
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`"${t.repo}" is not a folder inside the code workspace.`);
    if (fs.existsSync(path.join(src, ".git"))) { log(t.id, "Cloning local repository (original is never modified)…"); await git(dir, ["clone", "--local", "--no-hardlinks", "--", src, "repo"]); }
    else { log(t.id, "Not a git repo: copying a snapshot and initialising git."); copyTree(src, repoDir); await git(repoDir, ["init", "-q", "-b", "main"]); await git(repoDir, ["add", "-A"]); await git(repoDir, ["commit", "-q", "--allow-empty", "-m", "Baseline snapshot"]); }
    const nm = path.join(src, "node_modules");
    if (fs.existsSync(nm) && !fs.existsSync(path.join(repoDir, "node_modules"))) { fs.symlinkSync(nm, path.join(repoDir, "node_modules"), "dir"); log(t.id, "Linked node_modules from the original project (read-only reuse)."); }
  }
  const base = (await git(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
  const branch = `openmax/${slug(t.instruction)}-${t.id.slice(-4)}`;
  await git(repoDir, ["checkout", "-q", "-b", branch]);
  set(t.id, { sandbox: repoDir, base_sha: base, branch });
}

export function detectTestCommand(repoDir: string): string {
  const has = (f: string) => fs.existsSync(path.join(repoDir, f));
  if (has("package.json")) { try { const s = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")).scripts?.test; if (s && !/no test specified/.test(s)) return "npm test --silent"; } catch { /* ignore */ } }
  if (has("pytest.ini") || has("pyproject.toml") || has("setup.cfg") || has("tox.ini")) return "python -m pytest -x -q";
  if (has("Cargo.toml")) return "cargo test --quiet";
  if (has("go.mod")) return "go test ./...";
  if (has("Makefile") && /^test:/m.test(fs.readFileSync(path.join(repoDir, "Makefile"), "utf8"))) return "make test";
  return "";
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);
function readFiles(repoDir: string, paths: string[], budget = 70_000): string {
  let left = budget; const out: string[] = [];
  for (const p of paths.slice(0, 20)) {
    try { const f = safeResolve(repoDir, p); if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue; const buf = fs.readFileSync(f); if (buf.includes(0)) continue; const txt = buf.toString("utf8").slice(0, Math.min(left, 30_000)); left -= txt.length; out.push(`--- ${p} ---\n${txt}`); if (left <= 0) break; } catch { /* skip unsafe/missing */ }
  }
  return out.join("\n\n");
}
const outlineOf = (repoDir: string) => { const lines: string[] = []; const walk = (ns: ReturnType<typeof listTree>, pad: string) => { for (const n of ns) { if (lines.length >= 120) return; lines.push(pad + (n.type === "dir" ? n.name + "/" : n.name)); if (n.children) walk(n.children, pad + "  "); } }; walk(listTree(repoDir, "", 4), ""); return lines.join("\n"); };

async function stagePlan(t: CodeTask, signal: AbortSignal) {
  set(t.id, { status: "planning" }); log(t.id, "Reading the project and planning…");
  const repoDir = t.sandbox!; const outline = outlineOf(repoDir); const detected = detectTestCommand(repoDir);
  const common = { task: "code" as const, private: t.local_only, signal, purpose: "code-task", temperature: 0.2 };
  const pick = await routedJSON<{ files?: string[] }>({ ...common, maxTokens: 400, messages: [{ role: "system", content: 'Given a repository outline and a task, list up to 12 file paths worth reading to do the task (source, tests, config). Reply with ONLY JSON {"files":["path",...]}.' }, { role: "user", content: `Task: ${t.instruction}\n\nOutline:\n${outline}` }] }).catch(() => ({ value: { files: [] as string[] } }));
  const files = (pick.value.files ?? []).filter((f) => typeof f === "string");
  const readme = ["README.md", "readme.md"].map((r) => (fs.existsSync(path.join(repoDir, r)) ? clip(fs.readFileSync(path.join(repoDir, r), "utf8"), 2500) : "")).find(Boolean) ?? "";
  const { value } = await routedJSON<any>({ ...common, maxTokens: 1500, messages: [
    { role: "system", content: `You are planning a code change that an autonomous agent will carry out in an isolated sandbox clone. A human reviews your plan before any edits. Reply with ONLY JSON: {"summary":"one sentence","steps":["concrete step",...],"files_to_change":["path"],"test_command":"the shell command that verifies the work (reuse the detected one if it fits; \\"\\" if none exists)","risks":"short note"}.` },
    { role: "user", content: `Task: ${t.instruction}\n\nDetected test command: ${detected || "(none)"}\n\nREADME:\n${readme}\n\nOutline:\n${outline}\n\nRelevant files:\n${readFiles(repoDir, files)}` },
  ] });
  const plan = { summary: String(value.summary ?? "").slice(0, 400), steps: (Array.isArray(value.steps) ? value.steps : []).map(String).slice(0, 12), files_to_change: (Array.isArray(value.files_to_change) ? value.files_to_change : []).map(String).slice(0, 30), test_command: String(value.test_command ?? detected ?? "").slice(0, 300), risks: String(value.risks ?? "").slice(0, 400), read: files };
  if (!plan.summary && !plan.steps.length) throw new Error("The model did not produce a usable plan. Retry the task.");
  set(t.id, { plan, test_cmd: plan.test_command, status: "awaiting_plan_approval" });
  log(t.id, "Plan ready. Waiting for your approval before any edits.");
  addInbox({ kind: "code_task", title: `Plan ready: ${t.instruction.slice(0, 70)}`, body: `${plan.summary}\n\n${plan.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\nTest command: ${plan.test_command || "(none)"}`, ref: t.id });
}

export interface FileEdit { path: string; content?: string; ops?: PatchOp[]; delete?: boolean }
export function validateEdits(repoDir: string, v: any): { edits: FileEdit[]; errors: string[] } {
  const raw: any[] = Array.isArray(v?.edits) ? v.edits : []; const edits: FileEdit[] = [], errors: string[] = [];
  if (!raw.length) errors.push("no edits returned");
  if (raw.length > 40) errors.push("too many files in one round (max 40)");
  for (const e of raw.slice(0, 40)) {
    const p = String(e?.path ?? "");
    try {
      if (!p || p.split(/[\\/]/).includes(".git") || /(^|[\\/])\.git($|[\\/])/.test(p)) throw new Error("not an editable path");
      safeResolve(repoDir, p);
      if (e.delete === true) edits.push({ path: p, delete: true });
      else if (typeof e.content === "string") { if (e.content.length > 300_000) throw new Error("file too large"); edits.push({ path: p, content: e.content.endsWith("\n") || e.content === "" ? e.content : e.content + "\n" }); }
      else if (Array.isArray(e.ops)) { const { ops, dropped } = parseOps(e.ops); if (dropped.length || !ops.length) throw new Error(`bad ops: ${dropped.join("; ") || "none"}`); edits.push({ path: p, ops }); }
      else throw new Error("needs content, ops or delete");
    } catch (err: any) { errors.push(`${p || "(no path)"}: ${err.message}`); }
  }
  return { edits, errors };
}
/** All-or-nothing: compute every new file first; write only if every edit applies. */
export function applyEdits(repoDir: string, edits: FileEdit[]): { ok: boolean; errors: string[]; changed: string[] } {
  const plan: { abs: string; content: string | null; rel: string }[] = []; const errors: string[] = [];
  for (const e of edits) {
    const abs = safeResolve(repoDir, e.path);
    if (e.delete) { if (!fs.existsSync(abs)) errors.push(`${e.path}: cannot delete, file not found`); else plan.push({ abs, content: null, rel: e.path }); continue; }
    if (e.ops) { if (!fs.existsSync(abs)) { errors.push(`${e.path}: cannot patch a file that does not exist`); continue; } const r = applyPatch(fs.readFileSync(abs, "utf8"), e.ops); if (!r.ok) errors.push(...r.errors.map((m) => `${e.path}: ${m}`)); else plan.push({ abs, content: r.content, rel: e.path }); continue; }
    plan.push({ abs, content: e.content ?? "", rel: e.path });
  }
  if (errors.length) return { ok: false, errors, changed: [] };
  for (const p of plan) { if (p.content === null) fs.rmSync(p.abs, { force: true }); else { fs.mkdirSync(path.dirname(p.abs), { recursive: true }); fs.writeFileSync(p.abs, p.content); } }
  return { ok: true, errors: [], changed: plan.map((p) => p.rel) };
}

const EDIT_SYSTEM = `You are an autonomous coding agent working in a sandbox clone. Implement the approved plan. Reply with ONLY JSON:
{"summary":"what you changed","edits":[{"path":"rel/path.ts","content":"COMPLETE new file contents"} | {"path":"rel/path.ts","ops":[{"op":"replace","find":"exact unique existing text","replace":"new text"}]} | {"path":"old.ts","delete":true}]}
Use "content" for new files or small files; use "ops" (replace/insert_after/insert_before/delete/replace_lines/append) for targeted edits to large files. "find" strings must match EXACTLY and be unique. Never touch .git. Do not edit files unrelated to the task.`;

async function stageWork(t0: CodeTask, signal: AbortSignal) {
  let t = getTask(t0.id)!; const repoDir = t.sandbox!; const plan = t.plan; const testCmd = (t.test_cmd ?? "").trim();
  let feedback = ""; let lastOutput = t.test_output ?? "";
  for (let iter = t.iterations + 1; iter <= MAX_ITERATIONS; iter++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    set(t.id, { status: "working", iterations: iter }); log(t.id, `Iteration ${iter}/${MAX_ITERATIONS}: writing changes…`);
    const changedNow = (await git(repoDir, ["diff", "--stat", "HEAD"], { allowFail: true })).stdout.trim();
    const filesToShow = [...new Set([...(plan.files_to_change ?? []), ...(plan.read ?? [])])];
    const { value } = await routedJSON<any>({ task: "code", private: t.local_only, signal, purpose: "code-task", temperature: 0.2, maxTokens: 8000, messages: [
      { role: "system", content: EDIT_SYSTEM },
      { role: "user", content: `Task: ${t.instruction}\n\nApproved plan:\n${plan.summary}\n${plan.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\nCurrent file contents:\n${readFiles(repoDir, filesToShow)}\n${changedNow ? `\nChanges already made (git diff --stat):\n${changedNow}\n` : ""}${feedback ? `\nPROBLEM TO FIX FROM THE LAST ROUND:\n${feedback}\n` : ""}` },
    ] });
    const { edits, errors } = validateEdits(repoDir, value);
    let problem = errors.length ? `Your edits were rejected: ${errors.join("; ")}` : "";
    if (!problem) { const r = applyEdits(repoDir, edits); if (!r.ok) problem = `Your edits could not be applied (nothing was changed): ${r.errors.join("; ")}`; else log(t.id, `Changed ${r.changed.length} file(s): ${r.changed.join(", ")}`); }
    if (problem) { log(t.id, problem, "warn"); feedback = problem; if (iter === MAX_ITERATIONS) break; continue; }
    if (!testCmd) { log(t.id, "No test command was approved, so changes are unverified."); return { passed: null as boolean | null }; }
    set(t.id, { status: "testing" }); log(t.id, `Running tests: ${testCmd} (timeout ${t.timeout_sec}s)`);
    const res = await runCommand(testCmd, { cwd: repoDir, timeoutMs: t.timeout_sec * 1000, signal });
    if (res.aborted) throw new DOMException("Aborted", "AbortError");
    lastOutput = clip(res.output, 8000); set(t.id, { test_output: lastOutput });
    if (res.code === 0 && !res.timedOut) { log(t.id, `Tests passed (${(res.ms / 1000).toFixed(1)}s).`); set(t.id, { tests_passed: true }); return { passed: true }; }
    log(t.id, res.timedOut ? `Tests timed out after ${t.timeout_sec}s.` : `Tests failed (exit ${res.code}).`, "warn");
    feedback = res.timedOut ? `The test command timed out after ${t.timeout_sec}s (possible infinite loop or hang). Partial output:\n${clip(res.output, 3000)}` : `The tests failed (exit ${res.code}). Output:\n${clip(res.output, 5000)}`;
  }
  set(t.id, { tests_passed: false }); return { passed: false };
}

async function stageFinish(t0: CodeTask, passed: boolean | null) {
  const t = getTask(t0.id)!; const repoDir = t.sandbox!;
  await git(repoDir, ["add", "-A"]); const status = (await git(repoDir, ["status", "--porcelain"])).stdout.trim();
  if (status) await git(repoDir, ["commit", "-q", "-m", `OpenMax: ${t.instruction.slice(0, 72)}\n\n${t.plan?.summary ?? ""}`]);
  const diff = clip((await git(repoDir, ["diff", `${t.base_sha}..HEAD`])).stdout, 400_000);
  const files = (await git(repoDir, ["diff", "--name-only", `${t.base_sha}..HEAD`])).stdout.trim().split("\n").filter(Boolean);
  const final: TaskStatus = passed === false || !diff ? "needs_review" : "done";
  const summary = !diff ? "The agent made no changes." : `${files.length} file(s) changed on branch ${t.branch}. ${passed === true ? "Tests pass." : passed === false ? `Tests still failing after ${t.iterations} iteration(s); review needed.` : "No tests were run."}`;
  set(t.id, { diff, summary, status: final });
  log(t.id, summary, passed === false ? "warn" : "info");
  addInbox({ kind: "code_task", title: `${final === "done" ? "✓" : "⚠"} ${t.instruction.slice(0, 80)}`, body: `${summary}\n\nBranch: ${t.branch}\n\nOpen Code Tasks to review the diff. Nothing has been pushed.`, ref: t.id });
}

async function runTask(id: string) {
  const ac = new AbortController(); controllers.set(id, ac);
  try {
    let t = getTask(id)!;
    if (t.status === "queued" || t.status === "cloning") { await stageClone(t); t = getTask(id)!; }
    if (t.status === "planning" || t.status === "cloning" || (t.status === "queued" && t.sandbox)) { await stagePlan(getTask(id)!, ac.signal); return; }
    if (t.status === "awaiting_plan_approval") return;
    if (t.status === "working" || t.status === "testing") { const r = await stageWork(getTask(id)!, ac.signal); await stageFinish(getTask(id)!, r.passed); }
  } catch (e: any) {
    if (e?.name === "AbortError" || ac.signal.aborted) { set(id, { status: "cancelled", error: "Cancelled." }); log(id, "Cancelled.", "warn"); }
    else { set(id, { status: "failed", error: `${e.message}${e.fix ? ` (${e.fix})` : ""}`.slice(0, 600) }); log(id, `Failed: ${e.message}`, "error"); addInbox({ kind: "code_task", title: `✗ ${getTask(id)?.instruction.slice(0, 80)}`, body: `The task failed: ${e.message}`, ref: id }); }
  } finally { controllers.delete(id); }
}

// ───────── human decisions ─────────
export function decidePlan(id: string, decision: "approve" | "reject", testCommand?: string): CodeTask {
  const t = getTask(id); if (!t) throw Object.assign(new Error("Task not found."), { status: 404 });
  if (t.status !== "awaiting_plan_approval") throw Object.assign(new Error(`This task is ${t.status}, not waiting for plan approval.`), { status: 409 });
  if (decision === "reject") { set(id, { status: "rejected" }); log(id, "Plan rejected. No changes were made."); return getTask(id)!; }
  if (testCommand !== undefined) set(id, { test_cmd: testCommand.slice(0, 300) });
  set(id, { status: "working" }); log(id, `Plan approved${testCommand !== undefined ? ` (test command: ${testCommand || "none"})` : ""}.`);
  schedule(id); return getTask(id)!;
}
export function cancelTask(id: string) { const c = controllers.get(id); if (c) { c.abort(); return true; } const t = getTask(id); if (t && (t.status === "awaiting_plan_approval" || t.status === "queued")) { set(id, { status: "cancelled" }); return true; } return false; }
export function retryTask(id: string): CodeTask {
  const t = getTask(id); if (!t) throw Object.assign(new Error("Task not found."), { status: 404 });
  if (ACTIVE.includes(t.status)) throw Object.assign(new Error("This task is still running."), { status: 409 });
  fs.rmSync(path.join(sandboxRoot(), id), { recursive: true, force: true });
  set(id, { status: "queued", plan: null, sandbox: null, branch: null, diff: null, iterations: 0, error: null, tests_passed: null, test_output: null, summary: null, base_sha: null, log: [] });
  schedule(id); return getTask(id)!;
}
export function deleteTask(id: string) { cancelTask(id); fs.rmSync(path.join(sandboxRoot(), id), { recursive: true, force: true }); getDb().prepare("DELETE FROM code_tasks WHERE id=?").run(id); }
export function markInterruptedTasks() { getDb().prepare("UPDATE code_tasks SET status='failed', error='Interrupted by a server restart. Use Retry.' WHERE status IN ('queued','cloning','planning','working','testing')").run(); }

/** Create the task's branch inside the user's own local repo (no checkout, no working-tree change). Explicit click only. */
export async function createBranchInRepo(id: string, confirm: boolean): Promise<{ branch: string; repo: string }> {
  if (confirm !== true) throw Object.assign(new Error("Creating a branch in your repository needs an explicit confirmation."), { status: 409 });
  const t = getTask(id); if (!t || !t.sandbox || !t.branch) throw Object.assign(new Error("Task has no branch yet."), { status: 409 });
  if (!(t.status === "done" || t.status === "needs_review")) throw Object.assign(new Error("Only finished tasks can be exported."), { status: 409 });
  if (/^(https?:|git@|ssh:)/.test(t.repo)) throw Object.assign(new Error("This task cloned a remote URL; push the branch instead."), { status: 400 });
  const src = safeResolve(workspaceRoot(), t.repo);
  if (!fs.existsSync(path.join(src, ".git"))) throw Object.assign(new Error("The original folder is not a git repository, so there is nowhere to create a branch."), { status: 400, fix: "Run `git init` there, or copy files from the diff." });
  await git(src, ["fetch", "--no-tags", t.sandbox, `${t.branch}:${t.branch}`]);
  set(id, { repo_branch_created: true }); log(id, `Created branch ${t.branch} in ${t.repo}.`);
  return { branch: t.branch, repo: t.repo };
}
/** The ONLY place that pushes. Called solely from the HTTP route after an explicit click; never from the agent loop. */
export async function pushTask(id: string, confirm: boolean, remote = "origin"): Promise<string> {
  if (confirm !== true) throw Object.assign(new Error("Pushing needs an explicit confirmation."), { status: 409, fix: "Click Push in the UI and confirm." });
  const t = getTask(id); if (!t || !t.branch || !t.sandbox) throw Object.assign(new Error("Task not found or has no branch."), { status: 404 });
  if (!(t.status === "done" || t.status === "needs_review")) throw Object.assign(new Error("Only finished tasks can be pushed."), { status: 409 });
  if (t.pushed) throw Object.assign(new Error("This branch was already pushed."), { status: 409 });
  if (!/^[\w.-]+$/.test(remote)) throw Object.assign(new Error("Invalid remote name."), { status: 400 });
  const cwd = /^(https?:|git@|ssh:)/.test(t.repo) ? t.sandbox : safeResolve(workspaceRoot(), t.repo);
  if (cwd !== t.sandbox && !t.repo_branch_created) throw Object.assign(new Error("Create the branch in your repository first, then push it."), { status: 409 });
  const remotes = (await git(cwd, ["remote"], { allowFail: true })).stdout.split("\n").filter(Boolean);
  if (!remotes.includes(remote)) throw Object.assign(new Error(`The repository has no remote named "${remote}".`), { status: 400, fix: "Add one with `git remote add origin <url>`." });
  const r = await git(cwd, ["push", "--set-upstream", remote, `${t.branch}:${t.branch}`], { timeoutMs: 300_000 }); // plain push only: history is never rewritten
  set(id, { pushed: true }); log(id, `Pushed ${t.branch} to ${remote}.`);
  return (r.stderr || r.stdout).trim().slice(-400);
}
void cfg; void waiting;
