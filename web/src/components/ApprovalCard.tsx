import { useState } from "react";
import { api } from "../lib/api";

const KIND: Record<string, [string, string]> = { send_message: ["✉️", "Send a message"], delete: ["🗑", "Delete"], payment: ["💳", "May spend money"], personal_data: ["🪪", "Personal data"], irreversible: ["⚠️", "Irreversible action"], question: ["❓", "The agent asks"], network_access: ["🌐", "Network access for code"], code_exec: ["⚙️", "Run code (not sandboxed)"] };

export function ApprovalCard({ a, onDone }: { a: any; onDone: () => void }) {
  const [answer, setAnswer] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const [icon, label] = KIND[a.kind] ?? ["⚠️", a.kind];
  const decide = async (decision: "approve" | "reject") => { setBusy(true); setErr(""); try { await api.post(`/api/approvals/${a.id}`, { decision, answer: answer || undefined }); onDone(); } catch (e: any) { setErr(e.message); } setBusy(false); };
  const p = a.payload ?? {};
  return (
    <div className="rounded-xl border border-warn/50 bg-warn/10 p-3 text-[13px]">
      <div className="flex items-center gap-2"><span>{icon}</span><b>{label}</b>{p.deferred && <span className="chip">queued from a scheduled run</span>}</div>
      <div className="mt-1.5">{a.summary}</div>
      {p.flags?.map((f: string) => <div key={f} className="mt-1 text-warn">⚑ {f}</div>)}
      {p.tool === "send_email" && p.args?.body && <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-bg p-2 text-[12px] text-dim">{p.args.body}</pre>}
      {a.kind === "question" && <input className="input mt-2" placeholder="Your answer…" value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus />}
      <div className="mt-2.5 flex items-center gap-2">
        <button className="btn btn-primary" disabled={busy || (a.kind === "question" && !answer)} onClick={() => decide("approve")}>{a.kind === "question" ? "Send answer" : "Approve"}</button>
        <button className="btn btn-danger" disabled={busy} onClick={() => decide("reject")}>{a.kind === "question" ? "Skip" : "Reject"}</button>
        {err && <span className="text-bad">{err}</span>}
      </div>
    </div>
  );
}
