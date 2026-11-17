import { useCallback, useEffect, useState } from "react";
import { api, subscribeSSE } from "../lib/api";
import { useFetch } from "../lib/hooks";
import { ApprovalCard } from "../components/ApprovalCard";
import { Markdown } from "../components/Markdown";

const EXAMPLES = ["Find the three most recent posts on the Hacker News front page about open-source AI and save a summary to notes.txt", "Look up the weather forecast for Lisbon this weekend and create a calendar event for the best day for a picnic", "Draft an email to team@example.com summarizing today's top tech news (I will approve before it sends)"];
const STATUS: Record<string, string> = { ok: "text-good", error: "text-bad", blocked: "text-bad", rejected: "text-warn", pending_approval: "text-warn" };

function RunView({ id }: { id: string }) {
  const [d, setD] = useState<any>(); const [live, setLive] = useState(""); const [thought, setThought] = useState(""); const [shot, setShot] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api.get(`/api/agent/runs/${id}`)); } catch { /* ignore */ } }, [id]);
  useEffect(() => {
    setD(undefined); setLive(""); setThought(""); void load();
    return subscribeSSE(`/api/agent/runs/${id}/events`, (ev, data) => {
      if (ev === "status") setLive(data.text); else if (ev === "thought") setThought(data.text);
      if (["step", "approval", "done", "error", "snapshot"].includes(ev)) { setLive(""); void load(); }
    });
  }, [id, load]);
  if (!d) return <div className="p-6 text-dim">Loading…</div>;
  const { run, steps, approvals } = d; const pending = approvals.filter((a: any) => a.status === "pending");
  const running = run.status === "running";
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-5">
      <div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="label">Goal</div><div className="text-[15px]">{run.goal}</div></div>
        <span className={`chip ${run.status === "done" ? "!text-good" : run.status === "error" ? "!text-bad" : ""}`}>{run.unattended ? "scheduled · " : ""}{run.status}</span>
        {running && <button className="btn btn-danger" onClick={async () => { await api.post(`/api/agent/runs/${id}/stop`); void load(); }}>■ Stop</button>}</div>
      {pending.map((a: any) => <ApprovalCard key={a.id} a={a} onDone={load} />)}
      <div className="space-y-2">
        {steps.map((s: any) => (
          <div key={s.id} className="card p-3 text-[13px]">
            <div className="flex items-center gap-2"><span className="w-5 text-faint">{s.n}</span><code className="rounded bg-panel2 px-1.5 py-0.5 text-accent">{s.tool}</code><span className={`chip ${STATUS[s.status] ?? ""}`}>{s.status.replace("_", " ")}</span>
              <span className="min-w-0 flex-1 truncate text-dim" title={JSON.stringify(s.args)}>{Object.values(s.args).map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" · ").slice(0, 120)}</span></div>
            {s.result && s.tool !== "finish" && <details className="mt-1.5"><summary className="cursor-pointer text-[12px] text-faint">result</summary><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap text-[12px] text-dim">{s.result}</pre></details>}
            {s.screenshot && <button className="mt-2 block" onClick={() => setShot(`/api/agent/shots/${id}/${s.screenshot}`)}><img src={`/api/agent/shots/${id}/${s.screenshot}`} alt="screenshot" className="h-24 rounded-lg border border-line" /></button>}
          </div>
        ))}
        {running && !pending.length && <div className="animate-pulse px-1 text-[13px] text-dim">{live || "Working…"}{thought && <div className="mt-1 text-faint">💭 {thought}</div>}</div>}
      </div>
      {!running && run.result && <div className="card p-4"><div className="label mb-1">Result</div><Markdown text={run.result} /></div>}
      {shot && <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-6" onClick={() => setShot(null)}><img src={shot} alt="" className="max-h-full max-w-full rounded-lg" /></div>}
    </div>
  );
}

function Schedules() {
  const { data, reload } = useFetch<any>("/api/schedules", [], 8000);
  const [f, setF] = useState({ name: "", cron: "0 8 * * 1-5", goal: "" }); const [err, setErr] = useState<any>();
  const save = async () => { setErr(undefined); try { await api.post("/api/schedules", f); setF({ name: "", cron: "0 8 * * 1-5", goal: "" }); reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-5">
      <div className="card space-y-2 p-4">
        <div className="label">New schedule</div>
        <input className="input" placeholder="Name (e.g. Morning brief)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="flex gap-2"><input className="input !w-48 font-mono" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} /><span className="self-center text-[12px] text-dim">min hour day month weekday</span></div>
        <textarea className="input min-h-20" placeholder="What should the agent do each time?" value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} />
        {err && <p className="text-[12px] text-bad">{err.message} {err.fix}</p>}
        <button className="btn btn-primary" disabled={!f.name || !f.goal} onClick={save}>Save schedule</button>
        <p className="text-[12px] text-faint">Scheduled runs are unattended: emails and deletions are queued in your Inbox and only happen after you approve them there. Browser actions that need approval are refused.</p>
      </div>
      {data?.schedules.map((s: any) => (
        <div key={s.id} className="card flex items-center gap-3 p-3 text-[13px]">
          <input type="checkbox" checked={s.enabled} onChange={async (e) => { await api.post("/api/schedules", { ...s, enabled: e.target.checked }); reload(); }} title="Enabled" />
          <div className="min-w-0 flex-1"><div className="font-medium">{s.name} <code className="ml-1 text-[11px] text-faint">{s.cron}</code></div><div className="truncate text-dim">{s.goal}</div>{s.last_run && <div className="text-[11px] text-faint">last run {new Date(s.last_run).toLocaleString()}</div>}</div>
          <button className="btn" onClick={async () => { await api.post(`/api/schedules/${s.id}/run`); }}>Run now</button>
          <button className="btn btn-danger" onClick={async () => { await api.del(`/api/schedules/${s.id}`); reload(); }}>Delete</button>
        </div>
      ))}
    </div>
  );
}

export function Agent() {
  const runs = useFetch<any>("/api/agent/runs", [], 4000);
  const [tab, setTab] = useState<"run" | "sched">("run"); const [goal, setGoal] = useState(""); const [sel, setSel] = useState<string | null>(null); const [err, setErr] = useState<any>();
  const start = async (g = goal) => { setErr(undefined); try { const r = await api.post("/api/agent/runs", { goal: g }); setGoal(""); setSel(r.id); setTab("run"); runs.reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-line max-lg:hidden">
        <div className="flex gap-1 p-3">{([["run", "Runs"], ["sched", "Schedules"]] as const).map(([k, l]) => <button key={k} className={`btn flex-1 justify-center !py-1 ${tab === k ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(k)}>{l}</button>)}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <button className="btn mb-2 w-full justify-center" onClick={() => { setSel(null); setTab("run"); }}>＋ New task</button>
          {runs.data?.runs.map((r: any) => <button key={r.id} onClick={() => { setSel(r.id); setTab("run"); }} className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] ${sel === r.id ? "bg-panel2" : "hover:bg-panel"}`}><span className={`dot ${r.status === "running" ? "animate-pulse bg-accent" : r.status === "done" ? "bg-good" : r.status === "error" ? "bg-bad" : "bg-faint"}`} /><span className="truncate">{r.goal}</span></button>)}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        {tab === "sched" ? <Schedules /> : sel ? <RunView id={sel} /> : (
          <div className="mx-auto max-w-2xl p-8">
            <h1 className="text-2xl font-semibold tracking-tight">What should the agent do?</h1>
            <p className="mt-1 text-dim">It searches, reads, browses in an isolated browser, works in a sandbox folder, and can email or schedule. Anything irreversible (sending, buying, deleting, submitting personal data) pauses for your click.</p>
            <textarea className="input mt-5 min-h-28 !text-[15px]" placeholder="Describe the goal…" value={goal} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && goal.trim().length > 2) void start(); }} />
            {err && <p className="mt-2 text-[13px] text-bad">{err.message} {err.fix}</p>}
            <div className="mt-3 flex items-center gap-2"><button className="btn btn-primary" disabled={goal.trim().length < 3} onClick={() => start()}>Run agent ⌘↵</button></div>
            <div className="mt-8 space-y-2"><div className="label">Try</div>{EXAMPLES.map((e) => <button key={e} className="btn block w-full !whitespace-normal text-left" onClick={() => setGoal(e)}>{e}</button>)}</div>
          </div>
        )}
      </section>
    </div>
  );
}
