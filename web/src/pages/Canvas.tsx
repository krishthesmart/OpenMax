import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import "../lib/monaco";
import { api } from "../lib/api";
import { useFetch } from "../lib/hooks";
import { Markdown } from "../components/Markdown";
import { previewDoc } from "../components/ArtifactView";

const LANG: Record<string, string> = { markdown: "markdown", html: "html", react: "javascript", svg: "xml", code: "plaintext" };
const TONES = ["formal", "casual", "friendly", "persuasive", "technical", "concise"];
const store = (id: string) => `om.canvas.chat.${id}`;

export function Canvas() {
  const [sp, setSp] = useSearchParams();
  const list = useFetch<any>("/api/canvas");
  const [id, setId] = useState<string | null>(sp.get("open"));
  const [cv, setCv] = useState<any>(); const [versions, setVersions] = useState<any[]>([]);
  const [content, setContent] = useState(""); const [saved, setSaved] = useState("");
  const [chat, setChat] = useState<{ role: string; text: string }[]>([]); const [input, setInput] = useState("");
  const [busy, setBusy] = useState(""); const [err, setErr] = useState<any>(); const [sugs, setSugs] = useState<any[]>([]);
  const [preview, setPreview] = useState(true); const [localOnly, setLocalOnly] = useState(false); const [kind, setKind] = useState("markdown");
  const sel = useRef<() => string>(() => ""); const timer = useRef<any>(undefined);

  const apply = useCallback((c: any, v?: any[]) => { setCv(c); setContent(c.content); setSaved(c.content); if (v) setVersions(v); }, []);
  const load = useCallback(async (cid: string) => { try { const d = await api.get(`/api/canvas/${cid}`); apply(d.canvas, d.versions); setSugs([]); try { setChat(JSON.parse(localStorage.getItem(store(cid)) ?? "[]")); } catch { setChat([]); } } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } }, [apply]);
  useEffect(() => { if (id) void load(id); }, [id, load]);
  useEffect(() => { if (!id && list.data?.canvases[0] && !sp.get("open")) setId(list.data.canvases[0].id); }, [list.data, id, sp]);
  useEffect(() => { if (id) try { localStorage.setItem(store(id), JSON.stringify(chat.slice(-60))); } catch { /* ignore */ } }, [chat, id]);

  // debounced autosave of manual edits
  useEffect(() => {
    if (!id || !cv || content === saved) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => { try { const r = await api.put(`/api/canvas/${id}`, { content }); setSaved(content); setVersions(r.versions); setCv(r.canvas); } catch (e: any) { setErr({ message: e.message }); } }, 1800);
    return () => clearTimeout(timer.current);
  }, [content, saved, id, cv]);

  const create = async () => { const r = await api.post("/api/canvas", { title: "Untitled", kind, content: "" }); list.reload(); setSp({}); setId(r.canvas.id); };
  const run = async (label: string, fn: () => Promise<void>) => { setBusy(label); setErr(undefined); try { await fn(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } setBusy(""); };
  const edit = () => run("edit", async () => {
    const instruction = input; setInput(""); setChat((c) => [...c, { role: "user", text: instruction }]);
    const r = await api.post(`/api/canvas/${id}/edit`, { instruction, selection: sel.current() || undefined, localOnly });
    apply(r.canvas, r.versions); setChat((c) => [...c, { role: "assistant", text: r.changed ? `✓ ${r.summary}${r.attempts > 1 ? " (fixed on retry)" : ""}` : r.summary }]);
  });
  const xf = (body: any) => run("transform", async () => { const r = await api.post(`/api/canvas/${id}/transform`, { ...body, selection: sel.current() || undefined, localOnly }); apply(r.canvas, r.versions); setChat((c) => [...c, { role: "assistant", text: `✓ ${r.versions[0]?.note}` }]); });
  const suggest = () => run("suggest", async () => { const r = await api.post(`/api/canvas/${id}/suggest`, { instruction: input, selection: sel.current() || undefined, localOnly }); setSugs(r.suggestions); if (!r.suggestions.length) setChat((c) => [...c, { role: "assistant", text: "No suggestions: it already reads well." }]); });
  const accept = (s: any) => run("accept", async () => { const r = await api.post(`/api/canvas/${id}/patch`, { ops: [{ op: "replace", find: s.find, replace: s.replace }], note: `Accepted: ${s.why || "suggestion"}` }); apply(r.canvas, r.versions); setSugs((x) => x.filter((y) => y !== s)); });
  const restore = (v: number) => run("restore", async () => { const r = await api.post(`/api/canvas/${id}/restore`, { version: v }); apply(r.canvas, r.versions); });
  const del = async () => { if (!confirm("Delete this canvas and all its versions?")) return; await api.del(`/api/canvas/${id}`); setId(null); setCv(undefined); list.reload(); };

  const doc = useMemo(() => (cv && (cv.kind === "html" || cv.kind === "react" || cv.kind === "svg") ? previewDoc({ kind: cv.kind, content }) : undefined), [cv, content]);
  const canPreview = cv && (cv.kind === "markdown" || doc !== undefined);

  return (
    <div className="flex h-full">
      <aside className="flex w-[360px] shrink-0 flex-col border-r border-line max-lg:hidden">
        <div className="space-y-2 border-b border-line p-3">
          <div className="flex gap-2"><select className="input" value={id ?? ""} onChange={(e) => setId(e.target.value)}>{list.data?.canvases.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}{!list.data?.canvases.length && <option value="">No canvases yet</option>}</select></div>
          <div className="flex gap-2"><select className="input !w-auto" value={kind} onChange={(e) => setKind(e.target.value)}>{["markdown", "code", "html", "react", "svg"].map((k) => <option key={k}>{k}</option>)}</select><button className="btn btn-primary flex-1 justify-center" onClick={create}>＋ New canvas</button></div>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {chat.length === 0 && <p className="text-[12px] text-faint">Tell the model what to change. Select text in the editor to target it. Edits are structured patches, saved as versions you can restore.</p>}
          {chat.map((m, i) => <div key={i} className={m.role === "user" ? "ml-6 rounded-xl bg-accent/15 px-3 py-2 text-[13px]" : "mr-6 text-[13px] text-dim"}>{m.text}</div>)}
          {busy && <div className="animate-pulse text-[13px] text-dim">Working…</div>}
          {err && <div className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-[12px]"><div className="text-bad">{err.message}</div>{err.fix && <div className="mt-1 text-dim">{err.fix}</div>}</div>}
          {sugs.length > 0 && <div><div className="label mb-1">Suggestions</div>{sugs.map((s, i) => <div key={i} className="mb-2 rounded-lg border border-line p-2 text-[12px]"><div className="text-bad line-through">{s.find}</div><div className="text-good">{s.replace}</div>{s.why && <div className="mt-1 text-faint">{s.why}</div>}<div className="mt-1.5 flex gap-1"><button className="btn !py-0.5" onClick={() => accept(s)}>Accept</button><button className="btn btn-ghost !py-0.5" onClick={() => setSugs(sugs.filter((x) => x !== s))}>Reject</button></div></div>)}</div>}
        </div>
        <div className="space-y-2 border-t border-line p-3">
          <textarea className="input min-h-16" disabled={!id} placeholder="e.g. Make the intro punchier and add a summary table" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && input.trim()) void edit(); }} />
          <div className="flex gap-2"><button className="btn btn-primary flex-1 justify-center" disabled={!id || !input.trim() || !!busy} onClick={edit}>Edit ⌘↵</button><button className="btn" disabled={!id || !!busy} onClick={suggest} title="Propose inline suggestions without applying them">Suggest</button></div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!cv ? <div className="grid flex-1 place-items-center text-dim"><div className="text-center"><p>A Canvas is a document or program you and the model edit together.</p><button className="btn btn-primary mt-3" onClick={create}>＋ New canvas</button></div></div> : (
          <>
            <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
              <input className="input !w-56 !py-1" key={cv.id} defaultValue={cv.title} onBlur={async (e) => { if (e.target.value !== cv.title) { await api.patch(`/api/canvas/${cv.id}`, { title: e.target.value }); list.reload(); } }} />
              <span className="chip">{cv.kind}</span>
              <span className="mx-1 text-line">|</span>
              <button className="btn !py-1" disabled={!!busy} onClick={() => xf({ kind: "shorter" })}>Shorter</button>
              <button className="btn !py-1" disabled={!!busy} onClick={() => xf({ kind: "longer" })}>Longer</button>
              <select className="input !w-auto !py-1" value="" disabled={!!busy} onChange={(e) => e.target.value && xf({ kind: "tone", tone: e.target.value })}><option value="">Tone…</option>{TONES.map((t) => <option key={t}>{t}</option>)}</select>
              <select className="input !w-auto !py-1" value="" disabled={!!busy} onChange={(e) => e.target.value && xf({ kind: "reading_level", level: e.target.value })}><option value="">Reading level…</option>{["elementary school", "high school", "college", "expert"].map((t) => <option key={t}>{t}</option>)}</select>
              <label className="flex items-center gap-1 text-[11px] text-dim"><input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />local only</label>
              <span className="ml-auto flex items-center gap-1.5">
                {content !== saved && <span className="text-[11px] text-warn">saving…</span>}
                <select className="input !w-auto !py-1" value="" onChange={(e) => e.target.value && restore(Number(e.target.value))} title="Version history; choosing one restores it as a new version"><option value="">v{cv.version} · history</option>{versions.map((v) => <option key={v.version} value={v.version}>v{v.version} · {v.note} · {new Date(v.created_at).toLocaleTimeString()}</option>)}</select>
                {canPreview && <button className={`btn !py-1 ${preview ? "btn-primary" : ""}`} onClick={() => setPreview(!preview)}>Preview</button>}
                <button className="btn btn-danger !py-1" onClick={del}>Delete</button>
              </span>
            </div>
            <div className="flex min-h-0 flex-1">
              <div className={`min-w-0 ${canPreview && preview ? "w-1/2" : "flex-1"}`}>
                <Editor theme="openmax" path={`canvas-${cv.id}.${cv.kind}`} language={LANG[cv.kind] ?? "plaintext"} value={content} onChange={(v) => setContent(v ?? "")} options={{ minimap: { enabled: false }, fontSize: 13, wordWrap: "on", automaticLayout: true, scrollBeyondLastLine: false, padding: { top: 12 } }}
                  onMount={(ed) => { sel.current = () => { const s = ed.getSelection(); return s && !s.isEmpty() ? ed.getModel()?.getValueInRange(s) ?? "" : ""; }; }} />
              </div>
              {canPreview && preview && <div className="w-1/2 min-w-0 overflow-auto border-l border-line bg-bg">{cv.kind === "markdown" ? <div className="p-6"><Markdown text={content} /></div> : <iframe title="preview" className="h-full w-full bg-white" sandbox="allow-scripts" srcDoc={doc} />}</div>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
