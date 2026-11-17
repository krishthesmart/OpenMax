import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useFetch } from "../lib/hooks";

const EMPTY = { name: "", icon: "✨", instructions: "", pinned_model: "", lane: "", starters: [] as string[], private: false };
export function Gems() {
  const { data, reload } = useFetch<any>("/api/gems");
  const router = useFetch<any>("/api/router/config");
  const nav = useNavigate();
  const [sel, setSel] = useState<any>(null);
  const [src, setSrc] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const loadSrc = async (id: string) => setSrc((await api.get(`/api/gems/${id}/knowledge`)).sources);
  useEffect(() => { if (sel?.id) void loadSrc(sel.id); else setSrc([]); }, [sel?.id]);
  const save = async () => { const r = await api.post("/api/gems", { ...sel, pinned_model: sel.pinned_model || null, lane: sel.lane || null }); setSel(r.gem); setMsg("Saved."); reload(); };
  const addFile = async (f: File) => { setMsg(`Indexing ${f.name}…`); try { const fd = new FormData(); fd.append("file", f); await api.upload(`/api/gems/${sel.id}/knowledge`, fd); setMsg("Indexed."); await loadSrc(sel.id); } catch (e: any) { setMsg(e.message + (e.fix ? ` — ${e.fix}` : "")); } };
  const tasks: string[] = router.data?.tasks ?? [];
  return (
    <div className="flex h-full">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-line p-3">
        <button className="btn btn-primary mb-3 w-full justify-center" onClick={() => setSel({ ...EMPTY })}>＋ New Gem</button>
        {data?.gems.map((g: any) => <button key={g.id} onClick={() => setSel(g)} className={`mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left ${sel?.id === g.id ? "bg-panel2" : "hover:bg-panel"}`}><span className="text-lg">{g.icon}</span><span className="truncate">{g.name}</span>{g.private && <span>🔒</span>}</button>)}
        {data?.gems.length === 0 && <p className="px-2 text-[12px] text-faint">Gems are reusable assistants: instructions, a pinned model or lane, and a private knowledge base.</p>}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {!sel ? <p className="text-dim">Select or create a Gem.</p> : (
          <div className="mx-auto max-w-2xl space-y-4">
            <div className="flex gap-2"><input className="input !w-16 text-center text-lg" value={sel.icon} onChange={(e) => setSel({ ...sel, icon: e.target.value })} /><input className="input" placeholder="Name" value={sel.name} onChange={(e) => setSel({ ...sel, name: e.target.value })} /></div>
            <div><div className="label mb-1">Instructions</div><textarea className="input min-h-40" placeholder="How should this Gem behave?" value={sel.instructions} onChange={(e) => setSel({ ...sel, instructions: e.target.value })} /></div>
            <div className="grid gap-3 md:grid-cols-2">
              <div><div className="label mb-1">Pinned model (optional)</div><input className="input font-mono text-[12px]" placeholder="provider:model" value={sel.pinned_model ?? ""} onChange={(e) => setSel({ ...sel, pinned_model: e.target.value })} /></div>
              <div><div className="label mb-1">Lane override (optional)</div><select className="input" value={sel.lane ?? ""} onChange={(e) => setSel({ ...sel, lane: e.target.value })}><option value="">Auto-classify</option>{tasks.map((t) => <option key={t}>{t}</option>)}</select></div>
            </div>
            <div><div className="label mb-1">Starter prompts (one per line)</div><textarea className="input min-h-20" value={(sel.starters ?? []).join("\n")} onChange={(e) => setSel({ ...sel, starters: e.target.value.split("\n").filter(Boolean) })} /></div>
            <label className="flex items-center gap-2"><input type="checkbox" checked={!!sel.private} onChange={(e) => setSel({ ...sel, private: e.target.checked })} />Private: chats with this Gem and its knowledge use local models only</label>
            <div className="flex items-center gap-2"><button className="btn btn-primary" disabled={!sel.name} onClick={save}>Save</button>
              {sel.id && <><button className="btn" onClick={() => nav(`/chat?gem=${sel.id}`)}>Chat with this Gem</button><button className="btn btn-danger ml-auto" onClick={async () => { await api.del(`/api/gems/${sel.id}`); setSel(null); reload(); }}>Delete</button></>}
              <span className="text-[12px] text-dim">{msg}</span></div>
            {sel.id && (
              <div className="card p-4">
                <div className="label mb-2">Knowledge files</div>
                {src.map((s) => <div key={s.id} className="flex items-center gap-2 py-1 text-[13px]">📄 {s.name}<span className="chip">{s.chunks} chunks</span><button className="ml-auto text-faint hover:text-bad" onClick={async () => setSrc((await api.del(`/api/gems/${sel.id}/knowledge/${s.id}`)).sources)}>remove</button></div>)}
                <label className="btn mt-2 cursor-pointer"><input type="file" className="hidden" accept=".pdf,.txt,.md,.csv,.json,.html" onChange={(e) => e.target.files?.[0] && addFile(e.target.files[0])} />Add file (PDF, text, markdown)</label>
                <p className="mt-2 text-[12px] text-faint">Files are chunked, embedded and retrieved per message; answers cite them as [n].</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
