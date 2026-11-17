import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import "../lib/monaco";
import { langFor } from "../lib/monaco";
import { api, streamPost } from "../lib/api";
import { usePrefs } from "../lib/store";
import { Markdown } from "../components/Markdown";

interface Node { name: string; path: string; type: "dir" | "file"; children?: Node[] }
const ACTIONS: [string, string][] = [["explain", "Explain"], ["fix", "Fix"], ["refactor", "Refactor"], ["tests", "Tests"], ["docs", "Docs"], ["custom", "Custom…"]];

function Tree({ nodes, open, onOpen, cur, depth = 0 }: { nodes: Node[]; open: Set<string>; onOpen: (n: Node) => void; cur?: string; depth?: number }) {
  return <>{nodes.map((n) => (
    <div key={n.path}>
      <button onClick={() => onOpen(n)} className={`flex w-full items-center gap-1.5 truncate rounded px-2 py-[3px] text-left text-[12.5px] ${cur === n.path ? "bg-accent/15 text-accent" : "text-dim hover:bg-panel2"}`} style={{ paddingLeft: 8 + depth * 12 }}>
        <span className="w-3 text-faint">{n.type === "dir" ? (open.has(n.path) ? "▾" : "▸") : ""}</span>{n.name}
      </button>
      {n.type === "dir" && open.has(n.path) && n.children && <Tree nodes={n.children} open={open} onOpen={onOpen} cur={cur} depth={depth + 1} />}
    </div>
  ))}</>;
}

export function Code() {
  const { mode } = usePrefs();
  const [tree, setTree] = useState<Node[]>([]); const [root, setRoot] = useState("");
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [path, setPath] = useState<string>(); const [content, setContent] = useState(""); const [saved, setSaved] = useState("");
  const [instr, setInstr] = useState(""); const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ prose: string; text: string; route?: any; file?: { path: string; content: string } | null; original?: string; action?: string } | null>(null);
  const [err, setErr] = useState<any>(); const [newName, setNewName] = useState(""); const [localOnly, setLocalOnly] = useState(false);
  const sel = useRef<() => string>(() => ""); const ac = useRef<AbortController | null>(null);

  const loadTree = useCallback(async () => { try { const t = await api.get("/api/code/tree"); setTree(t.tree); setRoot(t.root); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } }, []);
  useEffect(() => { void loadTree(); }, [loadTree]);
  const openFile = async (p: string) => { try { const f = await api.get(`/api/code/file?path=${encodeURIComponent(p)}`); setPath(p); setContent(f.content); setSaved(f.content); setOut(null); setErr(undefined); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  const save = useCallback(async () => { if (!path) return; await api.put("/api/code/file", { path, content }); setSaved(content); void loadTree(); }, [path, content, loadTree]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save(); } }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [save]);

  const run = async (action: string) => {
    if (!path || busy) return;
    if (action === "custom" && !instr.trim()) { setErr({ message: "Type an instruction for the custom action." }); return; }
    setBusy(true); setErr(undefined); setOut({ prose: "", text: "", action });
    ac.current = new AbortController();
    try {
      await streamPost("/api/code/action", { action, path, content, instruction: instr || undefined, selection: sel.current() || undefined, mode, localOnly }, (ev, d) => {
        if (ev === "route") setOut((o) => o && { ...o, route: d });
        else if (ev === "text") setOut((o) => o && { ...o, text: o.text + d.text });
        else if (ev === "result") setOut((o) => o && { ...o, prose: d.prose, file: d.file, original: d.original });
        else if (ev === "error") setErr(d);
      }, ac.current.signal);
    } catch (e: any) { if (e.name !== "AbortError") setErr({ message: e.message, fix: e.fix }); }
    setBusy(false);
  };
  const apply = async () => {
    if (!out?.file) return;
    const target = out.file.path;
    await api.put("/api/code/file", { path: target, content: out.file.content });
    if (target === path) { setContent(out.file.content); setSaved(out.file.content); } else await openFile(target);
    setOut(null); void loadTree();
  };
  const create = async () => { if (!newName.trim()) return; await api.put("/api/code/file", { path: newName.trim(), content: "" }); setNewName(""); await loadTree(); await openFile(newName.trim()); };
  const remove = async () => { if (!path || !window.confirm(`Permanently delete ${path}? This cannot be undone.`)) return; await api.post("/api/code/delete", { path, confirm: true }); setPath(undefined); setContent(""); await loadTree(); };
  const toggle = (n: Node) => { if (n.type === "file") return void openFile(n.path); setOpenDirs((s) => { const x = new Set(s); x.has(n.path) ? x.delete(n.path) : x.add(n.path); return x; }); };
  const showDiff = !!out?.file && out.file.content !== out.original;

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-2"><div className="label mb-1">Workspace</div><div className="truncate text-[11px] text-faint" title={root}>{root}</div>
          <div className="mt-2 flex gap-1"><input className="input !py-1 text-[12px]" placeholder="new/file.ts" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} /><button className="btn !px-2" onClick={create}>＋</button></div></div>
        <div className="min-h-0 flex-1 overflow-y-auto py-1"><Tree nodes={tree} open={openDirs} onOpen={toggle} cur={path} />{tree.length === 0 && <p className="px-3 py-3 text-[12px] text-faint">Empty workspace. Create a file above, or put a project in the folder shown (CODE_WORKSPACE).</p>}</div>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
          <span className="mr-2 truncate text-[13px]">{path ?? "No file open"}{content !== saved && <span className="ml-1 text-warn">●</span>}</span>
          {ACTIONS.map(([a, l]) => <button key={a} className="btn !py-1" disabled={!path || busy} onClick={() => run(a)}>{l}</button>)}
          <input className="input !w-56 !py-1 text-[12px]" placeholder="Instruction (optional; required for Custom)" value={instr} onChange={(e) => setInstr(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run("custom")} />
          <label className="flex items-center gap-1 text-[11px] text-dim"><input type="checkbox" checked={localOnly} onChange={(e) => setLocalOnly(e.target.checked)} />local only</label>
          {busy && <button className="btn btn-danger !py-1" onClick={() => ac.current?.abort()}>■</button>}
          <span className="ml-auto flex gap-1"><button className="btn !py-1" disabled={!path || content === saved} onClick={save}>Save ⌘S</button><button className="btn btn-danger !py-1" disabled={!path} onClick={remove}>Delete</button></span>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {showDiff ? (
              <div className="flex h-full flex-col">
                <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5 text-[13px]">
                  <span>Proposed change to <b>{out!.file!.path}</b></span>{out!.route && <span className="chip">{out!.route.model}</span>}
                  <span className="ml-auto flex gap-2"><button className="btn btn-primary" onClick={apply}>Apply</button><button className="btn" onClick={() => setOut(null)}>Reject</button></span>
                </div>
                <div className="min-h-0 flex-1"><DiffEditor theme="openmax" language={langFor(out!.file!.path)} original={out!.original ?? ""} modified={out!.file!.content} options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 13, automaticLayout: true }} /></div>
              </div>
            ) : path ? (
              <Editor theme="openmax" path={path} language={langFor(path)} value={content} onChange={(v) => setContent(v ?? "")} options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true, scrollBeyondLastLine: false, tabSize: 2 }}
                onMount={(ed) => { sel.current = () => { const s = ed.getSelection(); return s && !s.isEmpty() ? ed.getModel()?.getValueInRange(s) ?? "" : ""; }; }} />
            ) : <div className="grid h-full place-items-center text-dim">Open a file from the tree to start.</div>}
          </div>
          {(out || err) && !showDiff && (
            <aside className="w-[38%] min-w-[280px] overflow-y-auto border-l border-line p-4">
              {err && <div className="mb-3 rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px]"><div className="text-bad">{err.message}</div>{err.fix && <div className="mt-1 text-dim">{err.fix}</div>}</div>}
              {out && <>{out.route && <div className="mb-2"><span className="chip">⚡ {out.route.task} → {out.route.model}</span></div>}
                {out.file && !showDiff && <p className="mb-2 text-[13px] text-dim">The model returned the file unchanged.</p>}
                <Markdown text={out.prose || out.text} />{busy && <span className="animate-pulse text-dim">●</span>}</>}
              {out && <button className="btn mt-3" onClick={() => setOut(null)}>Close</button>}
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
