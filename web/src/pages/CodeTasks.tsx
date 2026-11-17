import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/hooks";

const STATUS_STYLE: Record<string, string> = { done: "text-good", needs_review: "text-warn", failed: "text-bad", cancelled: "text-faint", rejected: "text-faint", awaiting_plan_approval: "text-accent" };
const LABEL: Record<string, string> = { awaiting_plan_approval: "plan ready", needs_review: "needs review" };
const busy = (s: string) => ["queued", "cloning", "planning", "working", "testing"].includes(s);

function Diff({ text }: { text: string }) {
  return <pre className="max-h-[480px] overflow-auto rounded-lg border border-line bg-bg p-3 font-mono text-[12px] leading-relaxed">{text.split("\n").map((l, i) => <div key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "bg-good/10 text-good" : l.startsWith("-") && !l.startsWith("---") ? "bg-bad/10 text-bad" : l.startsWith("@@") ? "text-accent" : l.startsWith("diff ") ? "mt-2 font-semibold text-ink" : "text-dim"}>{l || " "}</div>)}</pre>;
}

function Detail({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, reload } = useFetch<any>(`/api/code-tasks/${id}`, [id], 1500);
  const [cmd, setCmd] = useState<string | null>(null); const [msg, setMsg] = useState<any>();
  const t = data?.task;
  useEffect(() => { setCmd(null); setMsg(undefined); }, [id]);
  if (!t) return <div className="p-6 text-dim">Loading…</div>;
  const act = async (fn: () => Promise<any>, ok?: string) => { setMsg(undefined); try { const r = await fn(); if (ok) setMsg({ ok: `${ok}${r?.output ? `\n${r.output}` : ""}` }); reload(); onChange(); } catch (e: any) { setMsg({ err: e.message, fix: e.fix }); } };
  const remote = /^(https?:|git@|ssh:)/.test(t.repo);
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5">
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="label">Task · {t.repo}</div><div className="text-[15px]">{t.instruction}</div></div><span className={`chip ${STATUS_STYLE[t.status] ?? ""}`}>{LABEL[t.status] ?? t.status}</span>
        {busy(t.status) && <button className="btn btn-danger" onClick={() => act(() => api.post(`/api/code-tasks/${id}/cancel`))}>■ Cancel</button>}
        {!busy(t.status) && t.status !== "awaiting_plan_approval" && <button className="btn" onClick={() => act(() => api.post(`/api/code-tasks/${id}/retry`))}>Retry</button>}</div>
      {t.error && <div className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px] text-bad">{t.error}</div>}

      {t.status === "awaiting_plan_approval" && t.plan && (
        <div className="card space-y-3 border-accent/40 p-4">
          <div className="label">Review the plan. Nothing has been changed yet.</div>
          <div className="text-[15px] font-medium">{t.plan.summary}</div>
          <ol className="ml-5 list-decimal space-y-1 text-[13px]">{t.plan.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
          {t.plan.files_to_change.length > 0 && <div className="text-[12px] text-dim">Files: {t.plan.files_to_change.map((f: string) => <code key={f} className="mr-1.5 rounded bg-panel2 px-1">{f}</code>)}</div>}
          {t.plan.risks && <div className="text-[12px] text-warn">⚑ {t.plan.risks}</div>}
          <div><div className="label mb-1">Test command (runs inside the sandbox clone, with secrets removed from the environment)</div><input className="input font-mono" value={cmd ?? t.test_cmd ?? ""} onChange={(e) => setCmd(e.target.value)} placeholder="empty = skip tests" /><p className="mt-1 text-[11px] text-faint">This executes commands from the repository on your machine. Only approve for code you trust.</p></div>
          <div className="flex gap-2"><button className="btn btn-primary" onClick={() => act(() => api.post(`/api/code-tasks/${id}/plan`, { decision: "approve", testCommand: cmd ?? undefined }))}>Approve plan & start</button><button className="btn btn-danger" onClick={() => act(() => api.post(`/api/code-tasks/${id}/plan`, { decision: "reject" }))}>Reject</button></div>
        </div>
      )}

      {t.summary && <div className="card p-3 text-[13px]"><b>{t.summary}</b>{t.tests_passed !== null && <span className={`chip ml-2 ${t.tests_passed ? "!text-good" : "!text-bad"}`}>tests {t.tests_passed ? "pass" : "fail"}</span>}<span className="chip ml-1">{t.iterations} iteration{t.iterations === 1 ? "" : "s"}</span></div>}
      {t.diff && <div><div className="label mb-1">Diff against {t.base_sha?.slice(0, 7)}</div><Diff text={t.diff} /></div>}
      {(t.status === "done" || t.status === "needs_review") && t.branch && (
        <div className="card space-y-2 p-4"><div className="label">Next steps (nothing is pushed unless you click)</div>
          <div className="text-[13px]">Branch <code className="rounded bg-panel2 px-1">{t.branch}</code> exists in the sandbox clone.</div>
          <div className="flex flex-wrap items-center gap-2">
            {!remote && <button className="btn" disabled={t.repo_branch_created} onClick={() => { if (confirm(`Create branch ${t.branch} in your repository? Your working tree and current branch are not touched.`)) void act(() => api.post(`/api/code-tasks/${id}/branch`, { confirm: true }), "Branch created in your repository."); }}>{t.repo_branch_created ? "✓ Branch in your repo" : "Create branch in my repo"}</button>}
            <button className="btn btn-primary" disabled={t.pushed || (!remote && !t.repo_branch_created)} title={!remote && !t.repo_branch_created ? "Create the branch in your repo first" : ""} onClick={() => { if (confirm(`Push ${t.branch} to origin? This publishes the branch to the remote.`)) void act(() => api.post(`/api/code-tasks/${id}/push`, { confirm: true }), "Pushed."); }}>{t.pushed ? "✓ Pushed" : "Push to origin…"}</button>
          </div>
          {msg?.ok && <pre className="whitespace-pre-wrap text-[12px] text-good">{msg.ok}</pre>}
        </div>
      )}
      {msg?.err && <div className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px]"><div className="text-bad">{msg.err}</div>{msg.fix && <div className="mt-1 text-dim">{msg.fix}</div>}</div>}
      {t.test_output && <details><summary className="cursor-pointer text-[12px] text-dim">Last test output</summary><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg p-3 text-[12px]">{t.test_output}</pre></details>}
      <details open={busy(t.status)}><summary className="cursor-pointer text-[12px] text-dim">Activity log</summary><div className="mt-1 space-y-0.5 text-[12px]">{t.log.map((l: any, i: number) => <div key={i} className={l.level === "error" ? "text-bad" : l.level === "warn" ? "text-warn" : "text-dim"}><span className="mr-2 text-faint">{new Date(l.ts).toLocaleTimeString()}</span>{l.msg}</div>)}</div></details>
      <div><button className="btn btn-ghost text-faint" onClick={() => { if (confirm("Delete this task and its sandbox?")) void act(() => api.del(`/api/code-tasks/${id}`)); }}>Delete task</button></div>
    </div>
  );
}

export function CodeTasks() {
  const list = useFetch<any>("/api/code-tasks", [], 2000);
  const tree = useFetch<any>("/api/code/tree");
  const [repo, setRepo] = useState(""); const [instruction, setInstruction] = useState(""); const [localOnly, setLocalOnly] = useState(false); const [sel, setSel] = useState<string | null>(null); const [err, setErr] = useState<any>();
  const dirs: string[] = (tree.data?.tree ?? []).filter((n: any) => n.type === "dir").map((n: any) => n.path);
  const create = async () => { setErr(undefined); try { const r = await api.post("/api/code-tasks", { repo, instruction, localOnly }); setInstruction(""); setSel(r.task.id); list.reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-line max-lg:hidden">
        <div className="space-y-2 border-b border-line p-3">
          <div className="label">New async task</div>
          <input className="input" list="repos" placeholder="Project folder in workspace, or https git URL" value={repo} onChange={(e) => setRepo(e.target.value)} /><datalist id="repos">{dirs.map((d) => <option key={d} value={d} />)}</datalist>
          <textarea className="input min-h-20" placeholder="What should be done? e.g. Fix the failing date parser and add tests" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <label className="flex items-center gap-1.5 text-[12px] text-dim"><input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />local models only (private code)</label>
          {err && <p className="text-[12px] text-bad">{err.message} {err.fix}</p>}
          <button className="btn btn-primary w-full justify-center" disabled={!repo || instruction.length < 5} onClick={create}>Start (clone → plan)</button>
          <p className="text-[11px] text-faint">Works on a sandbox copy. You approve the plan, review the diff, and decide about any push.</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {list.data?.tasks.map((t: any) => <button key={t.id} onClick={() => setSel(t.id)} className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] ${sel === t.id ? "bg-panel2" : "hover:bg-panel"}`}><span className={`dot ${busy(t.status) ? "animate-pulse bg-accent" : t.status === "done" ? "bg-good" : t.status === "awaiting_plan_approval" ? "bg-warn" : t.status === "needs_review" ? "bg-warn" : t.status === "failed" ? "bg-bad" : "bg-faint"}`} /><span className="min-w-0 flex-1"><span className="block truncate">{t.instruction}</span><span className="text-[11px] text-faint">{t.repo} · {LABEL[t.status] ?? t.status}</span></span></button>)}
          {list.data?.tasks.length === 0 && <p className="px-2 text-[12px] text-faint">Run several tasks in parallel; results land in your Inbox.</p>}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">{sel ? <Detail id={sel} onChange={list.reload} /> : <div className="grid h-full place-items-center p-8 text-center text-dim"><div><p className="text-lg text-ink">Hand off a coding task</p><p className="mt-1 max-w-md">OpenMax clones the project into a sandbox, plans, waits for your approval, edits, runs your tests, iterates up to five times, and leaves you a local branch and diff.</p></div></div>}</section>
    </div>
  );
}
