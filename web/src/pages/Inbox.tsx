import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useFetch } from "../lib/hooks";
import { ApprovalCard } from "../components/ApprovalCard";
import { Markdown } from "../components/Markdown";

export function Inbox() {
  const inbox = useFetch<any>("/api/inbox", [], 5000);
  const ap = useFetch<any>("/api/approvals?status=pending", [], 5000);
  const nav = useNavigate(); const [open, setOpen] = useState<string | null>(null);
  const refresh = () => { inbox.reload(); ap.reload(); };
  return (
    <div className="h-full overflow-y-auto p-6"><div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-lg font-semibold">Inbox</h1>
      {ap.data?.approvals.length > 0 && <section className="space-y-2"><div className="label">Waiting for your approval ({ap.data.approvals.length})</div>{ap.data.approvals.map((a: any) => <ApprovalCard key={a.id} a={a} onDone={refresh} />)}</section>}
      <section className="space-y-2">
        <div className="label">Results & notifications</div>
        {inbox.data?.items.map((i: any) => (
          <div key={i.id} className={`card p-3 ${i.read ? "opacity-70" : ""}`}>
            <div className="flex items-center gap-2"><button className="min-w-0 flex-1 truncate text-left font-medium" onClick={async () => { setOpen(open === i.id ? null : i.id); if (!i.read) { await api.post(`/api/inbox/${i.id}/read`); refresh(); } }}>{!i.read && <span className="mr-1.5 text-accent">●</span>}{i.title}</button>
              <span className="text-[11px] text-faint">{new Date(i.created_at).toLocaleString()}</span>
              {i.kind === "agent_result" && i.ref && <button className="btn !py-0.5" onClick={() => nav("/agent")} title="Open the Agent page and select the run">Open</button>}
              <button className="text-faint hover:text-bad" onClick={async () => { await api.del(`/api/inbox/${i.id}`); refresh(); }}>✕</button></div>
            {open === i.id && <div className="mt-2 border-t border-line pt-2 text-[13px]"><Markdown text={i.body} /></div>}
          </div>
        ))}
        {inbox.data?.items.length === 0 && <p className="text-dim">Nothing here yet. Agent results, finished code tasks and approval requests land here.</p>}
      </section>
    </div></div>
  );
}
