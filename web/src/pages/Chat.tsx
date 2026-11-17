import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, streamPost } from "../lib/api";
import { useFetch } from "../lib/hooks";
import { usePrefs } from "../lib/store";
import { deepest, pathFromLeaf, siblingsOf, type Msg } from "../lib/chatTree";
import { parseArtifacts, artifactsOf, type ParsedArtifact } from "../../../server/src/shared/artifacts";
import { Markdown, type CiteSource } from "../components/Markdown";
import { ArtifactView } from "../components/ArtifactView";
import { Recorder, Speaker, transcribeBlob } from "../lib/voice";

interface Stream { text: string; reasoning: string; route?: any; sources?: CiteSource[]; status?: string; think?: any; error?: { message: string; fix?: string; needsCloudOverride?: boolean }; lastBody?: any }
interface Att { id: string; name: string; kind: string; note?: string; uploading?: boolean }

function RouteChip({ info, task, onPick }: { info: any; task: string; onPick: (ref: string) => void }) {
  const [open, setOpen] = useState(false);
  const cfg = useFetch<any>(open ? "/api/router/config" : null);
  const alts: string[] = cfg.data?.config.lanes[task] ?? [];
  return (
    <span className="relative">
      <button className="chip hover:border-accent/60 hover:text-ink" onClick={() => setOpen(!open)} title={info.reason}>
        {info.localOnly ? "🔒" : "⚡"} {task} → {info.model} · {info.source} {info.confidence}
        {info.fallbacksTried?.length > 0 && <span className="text-warn">· {info.fallbacksTried.length} fallback{info.fallbacksTried.length > 1 ? "s" : ""}</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-20 w-80 rounded-lg border border-line bg-panel p-2 shadow-xl">
          <div className="label px-1 pb-1">Re-run with another model</div>
          {alts.map((r) => <button key={r} className="block w-full truncate rounded px-2 py-1 text-left font-mono text-[12px] hover:bg-panel2" onClick={() => { setOpen(false); onPick(r); }}>{r}{r === info.model ? "  ✓" : ""}</button>)}
          {info.fallbacksTried?.length > 0 && <div className="mt-2 border-t border-line px-1 pt-2 text-[11px] text-faint">Tried first: {info.fallbacksTried.map((f: any) => `${f.ref} (${f.error.slice(0, 50)})`).join("; ")}</div>}
        </div>
      )}
    </span>
  );
}

function ThinkPanel({ think }: { think: any }) {
  if (!think?.candidates?.length) return null;
  return (
    <details className="mb-2 rounded-lg border border-line bg-panel2/50 px-3 py-2 text-[12px]">
      <summary className="cursor-pointer text-dim">🧠 Considered approaches ({think.candidates.length}) · judged by {think.judge?.ref ?? "—"}</summary>
      <div className="mt-2 space-y-2">
        {think.candidates.map((c: any, i: number) => (
          <div key={i} className={`rounded border p-2 ${think.chosen === c.ref ? "border-accent/60" : "border-line"}`}>
            <div className="mb-1 font-mono text-[11px] text-dim">{c.ref} {think.chosen === c.ref && <span className="text-accent">· chosen</span>} {c.error && <span className="text-bad">· {c.error}</span>}</div>
            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap text-dim">{c.text?.slice(0, 1200)}</div>
          </div>
        ))}
        {think.judge?.verdict && <div className="text-dim">Judge: {think.judge.verdict}</div>}
      </div>
    </details>
  );
}

function Bubble({ m, sources, onOpenArtifact, onEdit, onRegen, onPick, onRate, onSibling, sibs, speaking }: any) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const segs = useMemo(() => (m.role === "assistant" ? parseArtifacts(m.content) : []), [m.content, m.role]);
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]">
          {m.meta?.attachments?.length > 0 && <div className="mb-1 flex flex-wrap justify-end gap-1">{m.meta.attachments.map((a: any) => <span key={a.id} className="chip">📎 {a.name}</span>)}</div>}
          {editing ? (
            <div className="space-y-2"><textarea className="input min-h-24" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
              <div className="flex justify-end gap-2"><button className="btn" onClick={() => setEditing(false)}>Cancel</button><button className="btn btn-primary" onClick={() => { setEditing(false); onEdit(m, draft); }}>Send as new branch</button></div></div>
          ) : (
            <div className="group relative rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 whitespace-pre-wrap">{m.content}
              <button className="absolute -left-14 top-1 hidden text-[11px] text-faint hover:text-ink group-hover:block" onClick={() => { setDraft(m.content); setEditing(true); }}>edit</button></div>
          )}
          {sibs.length > 1 && <Sib sibs={sibs} cur={m} onSibling={onSibling} />}
        </div>
      </div>
    );
  }
  const info = m.meta?.route;
  return (
    <div className="max-w-full">
      <div className="mb-1 flex flex-wrap items-center gap-2">{info && <RouteChip info={info} task={info.task} onPick={(r) => onPick(m, r)} />}{sibs.length > 1 && <Sib sibs={sibs} cur={m} onSibling={onSibling} />}</div>
      <ThinkPanel think={m.meta?.think} />
      {m.meta?.reasoning && <details className="mb-2 text-[12px] text-faint"><summary className="cursor-pointer">Reasoning</summary><div className="mt-1 whitespace-pre-wrap">{m.meta.reasoning}</div></details>}
      {segs.map((s, i) => s.type === "text" ? <Markdown key={i} text={s.text} sources={sources} /> : (
        <button key={i} onClick={() => onOpenArtifact(s.artifact.key)} className="my-2 flex w-full items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-left hover:border-accent/60">
          <span className="text-lg">{s.artifact.kind === "html" || s.artifact.kind === "react" ? "🌐" : s.artifact.kind === "svg" ? "🎨" : s.artifact.kind === "markdown" ? "📄" : "💻"}</span>
          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{s.artifact.title}</span><span className="text-[12px] text-dim">{s.artifact.kind}{s.artifact.complete ? "" : " · writing…"} · click to open</span></span>
        </button>
      ))}
      {m.meta?.citations?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">{m.meta.citations.map((c: any) => <a key={c.n} href={c.url} target="_blank" rel="noreferrer" title={c.snippet} className="chip hover:border-accent/60"><span className="text-accent">{c.n}</span> {c.title.slice(0, 40)}</a>)}</div>
      )}
      {m.id && !m.id.startsWith("tmp") && (
        <div className="mt-1.5 flex items-center gap-1 text-[12px] text-faint">
          <button className="btn btn-ghost !px-1.5 !py-0.5" onClick={() => navigator.clipboard.writeText(m.content)}>copy</button>
          <button className="btn btn-ghost !px-1.5 !py-0.5" onClick={() => onRegen(m)}>↻ regenerate</button>
          <button className="btn btn-ghost !px-1.5 !py-0.5" onClick={() => onRate(m, 1)}>👍</button>
          <button className="btn btn-ghost !px-1.5 !py-0.5" onClick={() => onRate(m, -1)}>👎</button>
          {m.meta?.tps ? <span>{m.meta.tps} tok/s</span> : null}{speaking}
        </div>
      )}
    </div>
  );
}
function Sib({ sibs, cur, onSibling }: any) {
  const i = sibs.findIndex((s: Msg) => s.id === cur.id);
  return <span className="inline-flex items-center gap-1 text-[12px] text-dim"><button disabled={i <= 0} onClick={() => onSibling(sibs[i - 1])} className="px-1 disabled:opacity-30">‹</button>{i + 1}/{sibs.length}<button disabled={i >= sibs.length - 1} onClick={() => onSibling(sibs[i + 1])} className="px-1 disabled:opacity-30">›</button></span>;
}

export function Chat() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { mode, think } = usePrefs();
  const [q, setQ] = useState("");
  const list = useFetch<any>(`/api/conversations?q=${encodeURIComponent(q)}`, [q]);
  const gems = useFetch<any>("/api/gems");
  const [conv, setConv] = useState<any>();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [leaf, setLeaf] = useState<string | null>(null);
  const [stream, setStream] = useState<Stream | null>(null);
  const [input, setInput] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [artKey, setArtKey] = useState<string | null>(null);
  const [voice, setVoice] = useState(false);
  const [recording, setRecording] = useState(false);
  const [drag, setDrag] = useState(false);
  const acRef = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const rec = useRef(new Recorder());
  const speaker = useRef<Speaker | null>(null);
  const gemId = sp.get("gem") ?? undefined;
  const est = useFetch<any>(think ? `/api/think/estimate?short=${input.length < 600 ? 1 : 0}&private=${conv?.private ? 1 : 0}&attachments=${atts.length ? 1 : 0}` : null, [think, atts.length, conv?.private]);
  const gem = gems.data?.gems.find((g: any) => g.id === (conv?.gem_id ?? gemId));

  const load = useCallback(async (cid: string, keepLeaf = false) => {
    const d = await api.get(`/api/conversations/${cid}`);
    setConv(d.conversation); setMsgs(d.messages);
    setLeaf((cur) => (keepLeaf && cur && d.messages.some((m: Msg) => m.id === cur) ? cur : d.conversation.leaf_id));
  }, []);
  useEffect(() => { if (id) void load(id); else { setConv(undefined); setMsgs([]); setLeaf(null); setArtKey(null); } }, [id, load]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [msgs, leaf, stream?.text]);

  const path = useMemo(() => pathFromLeaf(msgs, leaf), [msgs, leaf]);
  const sourcesFor = (m: Msg): CiteSource[] | undefined => m.meta?.citations;
  const arts = useMemo(() => {
    const map = new Map<string, { key: string; title: string; kind: ParsedArtifact["kind"]; lang?: string; versions: string[]; streaming: boolean }>();
    const texts = [...path.filter((m) => m.role === "assistant").map((m) => m.content), ...(stream ? [stream.text] : [])];
    texts.forEach((t, ti) => artifactsOf(t).forEach((a) => {
      const e = map.get(a.key) ?? { key: a.key, title: a.title, kind: a.kind, lang: a.lang, versions: [], streaming: false };
      const isStream = !!stream && ti === texts.length - 1 && !a.complete;
      if (!isStream && e.versions[e.versions.length - 1] !== a.content) e.versions.push(a.content);
      if (isStream) { e.streaming = true; if (!e.versions.length) e.versions.push(a.content); else e.versions[e.versions.length - 1] = a.content; }
      e.title = a.title; e.kind = a.kind; e.lang = a.lang ?? e.lang; map.set(a.key, e);
    }));
    return [...map.values()];
  }, [path, stream]);
  useEffect(() => { const s = arts.find((a) => a.streaming); if (s) setArtKey(s.key); }, [arts]);
  const openArt = arts.find((a) => a.key === artKey);

  const send = useCallback(async (o: { text?: string; parentId?: string | null; regenerateOf?: string; forceRef?: string; allowCloud?: boolean; attachmentIds?: string[]; speak?: boolean }) => {
    const body = { conversationId: id, gemId, text: o.text ?? "", parentId: o.parentId, regenerateOf: o.regenerateOf, forceRef: o.forceRef, allowCloud: o.allowCloud, attachmentIds: o.attachmentIds, mode, think };
    const ac = new AbortController(); acRef.current = ac;
    setStream({ text: "", reasoning: "", lastBody: body });
    const sp2 = o.speak ? (speaker.current = new Speaker()) : null;
    let cid = id;
    try {
      await streamPost("/api/chat/send", body, (ev, d) => {
        if (ev === "start") {
          cid = d.conversationId;
          if (!id) nav(`/chat/${cid}`, { replace: true });
          if (!o.regenerateOf) setMsgs((m) => [...m, { id: "tmp-u", parent_id: o.parentId === undefined ? leaf : o.parentId, role: "user", content: o.text ?? "", meta: { attachments: atts }, created_at: Date.now() }]);
        }
        else if (ev === "route") setStream((s) => s && { ...s, route: d, status: undefined });
        else if (ev === "status") setStream((s) => s && { ...s, status: d.text });
        else if (ev === "sources") setStream((s) => s && { ...s, sources: d });
        else if (ev === "think") setStream((s) => s && { ...s, think: d });
        else if (ev === "text") { setStream((s) => s && { ...s, text: s.text + d.text }); sp2?.push(d.text); }
        else if (ev === "reasoning") setStream((s) => s && { ...s, reasoning: s.reasoning + d.text });
        else if (ev === "error") setStream((s) => s && { ...s, error: d });
        else if (ev === "title") list.reload();
      }, ac.signal);
    } catch (e: any) { if (e.name !== "AbortError") setStream((s) => s && { ...s, error: { message: e.message, fix: e.fix } }); }
    sp2?.flush();
    acRef.current = null;
    if (cid) { await load(cid); list.reload(); }
    setStream((s) => (s?.error ? { ...s, text: "", route: undefined } : null));
  }, [id, gemId, mode, think, leaf, atts, nav, load, list]);

  const stop = () => { acRef.current?.abort(); speaker.current?.stop(); };
  const submit = (speak = false, text = input) => {
    if (!text.trim() && !atts.length) return;
    const ids = atts.filter((a) => !a.uploading).map((a) => a.id);
    setInput(""); setAtts([]);
    void send({ text, attachmentIds: ids, speak });
  };
  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      const tmp: Att = { id: `up-${Math.random()}`, name: f.name, kind: "file", uploading: true };
      setAtts((a) => [...a, tmp]);
      try { const fd = new FormData(); fd.append("file", f); const r = await api.upload("/api/attachments", fd); setAtts((a) => a.map((x) => (x.id === tmp.id ? r.attachment : x))); }
      catch (e: any) { setAtts((a) => a.filter((x) => x.id !== tmp.id)); setStream({ text: "", reasoning: "", error: { message: e.message, fix: e.fix } }); }
    }
  };
  const pttDown = async () => { try { speaker.current?.stop(); await rec.current.start(); setRecording(true); } catch { setStream({ text: "", reasoning: "", error: { message: "Microphone access was denied.", fix: "Allow the microphone for this site in your browser settings." } }); } };
  const pttUp = async () => {
    if (!recording) return; setRecording(false);
    const blob = await rec.current.stop();
    try { const t = await transcribeBlob(blob); if (t.trim()) { setInput(""); void send({ text: t, speak: true }); } }
    catch (e: any) { setStream({ text: "", reasoning: "", error: { message: e.message, fix: e.fix } }); }
  };

  const onEdit = (m: Msg, text: string) => void send({ text, parentId: m.parent_id });
  const onRegen = (m: Msg, forceRef?: string) => void send({ regenerateOf: m.id, forceRef });
  const onRate = (m: Msg, r: number) => m.meta?.logId && api.post("/api/router/rate", { id: m.meta.logId, rating: r });
  const onSibling = (s: Msg) => setLeaf(deepest(msgs, s.id));
  const newChat = () => nav(gemId ? `/chat?gem=${gemId}` : "/chat");
  const del = async (cid: string) => { await api.del(`/api/conversations/${cid}`); list.reload(); if (cid === id) nav("/chat"); };
  const togglePrivate = async () => { if (!conv) return; await api.patch(`/api/conversations/${conv.id}`, { private: !conv.private }); await load(conv.id, true); };
  const lastUser = [...path].reverse().find((m) => m.role === "user");

  return (
    <div className="flex h-full" onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}>
      <aside className="flex w-64 shrink-0 flex-col border-r border-line max-lg:hidden">
        <div className="space-y-2 p-3">
          <button className="btn btn-primary w-full justify-center" onClick={newChat}>＋ New chat</button>
          <input className="input" placeholder="Search history…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" value={gemId ?? ""} onChange={(e) => nav(e.target.value ? `/chat?gem=${e.target.value}` : "/chat")}>
            <option value="">No Gem</option>{gems.data?.gems.map((g: any) => <option key={g.id} value={g.id}>{g.icon} {g.name}{g.private ? " 🔒" : ""}</option>)}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {list.data?.conversations.map((c: any) => (
            <div key={c.id} className={`group flex items-center rounded-lg px-2.5 py-2 text-[13px] ${c.id === id ? "bg-panel2" : "hover:bg-panel"}`}>
              <button className="min-w-0 flex-1 text-left" onClick={() => nav(`/chat/${c.id}`)}><div className="truncate">{c.private ? "🔒 " : ""}{c.title}</div>{c.snippet && <div className="truncate text-[11px] text-faint">…{c.snippet}</div>}</button>
              <button className="hidden text-faint hover:text-bad group-hover:block" onClick={() => del(c.id)} aria-label="Delete conversation">✕</button>
            </div>
          ))}
          {list.data?.conversations.length === 0 && <p className="px-3 py-4 text-[12px] text-faint">No conversations yet.</p>}
        </div>
      </aside>

      <section className="relative flex min-w-0 flex-1 flex-col">
        {drag && <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-bg/80 text-accent">Drop files to attach</div>}
        {(conv || gem) && (
          <div className="flex items-center gap-2 border-b border-line px-5 py-2 text-[13px]">
            <span className="truncate font-medium">{gem ? `${gem.icon} ${gem.name} · ` : ""}{conv?.title ?? "New chat"}</span>
            {conv && <button className={`chip ${conv.private ? "!border-accent/60 !text-accent" : ""}`} onClick={togglePrivate} title="Private chats never leave this machine">{conv.private ? "🔒 private (local only)" : "🔓 cloud allowed"}</button>}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-6 px-5 py-6">
            {path.length === 0 && !stream && (
              <div className="grid place-items-center pt-[12vh] text-center">
                <div className="text-3xl font-semibold tracking-tight">{gem ? `${gem.icon} ${gem.name}` : "What are we working on?"}</div>
                <p className="mt-2 max-w-md text-dim">{gem?.instructions ? gem.instructions.slice(0, 140) : "Ask anything. OpenMax picks the strongest available model for each message and shows you which one it used."}</p>
                <div className="mt-6 flex max-w-xl flex-wrap justify-center gap-2">
                  {(gem?.starters?.length ? gem.starters : ["Explain how a hash map works, with a TypeScript implementation", "What happened in tech news today?", "Write a haiku about debugging", "Compare Postgres and SQLite for a small SaaS"]).map((s: string) => <button key={s} className="btn" onClick={() => submit(false, s)}>{s}</button>)}
                </div>
              </div>
            )}
            {path.map((m) => <Bubble key={m.id} m={m} sources={sourcesFor(m)} sibs={siblingsOf(msgs, m)} onOpenArtifact={setArtKey} onEdit={onEdit} onRegen={onRegen} onPick={(mm: Msg, r: string) => onRegen(mm, r)} onRate={onRate} onSibling={onSibling} />)}
            {stream && !stream.error && (
              <Bubble m={{ id: "tmp-a", role: "assistant", content: stream.text, meta: { route: stream.route, think: stream.think } }} sources={stream.sources} sibs={[]} onOpenArtifact={setArtKey} onEdit={() => {}} onRegen={() => {}} onPick={() => {}} onRate={() => {}} onSibling={() => {}} />
            )}
            {stream && !stream.error && !stream.text && <div className="text-dim">{stream.status ?? (stream.route ? "Thinking…" : "Routing…")}<span className="animate-pulse"> ●</span></div>}
            {stream?.error && (
              <div className="rounded-xl border border-bad/40 bg-bad/10 p-4 text-[13px]">
                <div className="font-medium text-bad">{stream.error.message}</div>
                {stream.error.fix && <div className="mt-1 text-dim">{stream.error.fix}</div>}
                <div className="mt-3 flex gap-2">
                  {stream.error.needsCloudOverride && lastUser && <button className="btn btn-primary" onClick={() => void send({ text: lastUser.content, parentId: lastUser.parent_id, allowCloud: true })}>Send to cloud for this message</button>}
                  <button className="btn" onClick={() => setStream(null)}>Dismiss</button>
                </div>
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="border-t border-line bg-bg px-5 py-3">
          <div className="mx-auto max-w-3xl">
            {atts.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5">{atts.map((a) => <span key={a.id} className="chip" title={a.note}>{a.uploading ? "⏳" : "📎"} {a.name}<button onClick={() => setAtts(atts.filter((x) => x.id !== a.id))} className="ml-1 text-faint hover:text-bad">✕</button></span>)}</div>}
            {atts.length > 0 && <p className="mb-1 text-[11px] text-faint">🔒 Attachments are processed by local models only unless you choose "send to cloud" when asked.</p>}
            <div className="flex items-end gap-2 rounded-2xl border border-line bg-panel p-2 focus-within:border-accent/60">
              <label className="btn btn-ghost !px-2 cursor-pointer" title="Attach files"><input type="file" multiple className="hidden" onChange={(e) => e.target.files && upload(e.target.files)} />📎</label>
              <textarea className="max-h-48 min-h-[40px] flex-1 resize-none bg-transparent px-1 py-2 outline-none placeholder:text-faint" rows={1} placeholder={think ? "Think mode: several models draft, one judges…" : "Message OpenMax…"} value={input}
                onChange={(e) => { setInput(e.target.value); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!stream) submit(voice); } if (e.key === "Escape") stop(); }}
                onPaste={(e) => { const f = e.clipboardData.files; if (f.length) { e.preventDefault(); void upload(f); } }} />
              <button className={`btn !px-2 ${recording ? "btn-danger" : voice ? "btn-primary" : ""}`} title="Hold to talk; replies are spoken" onPointerDown={pttDown} onPointerUp={pttUp} onPointerLeave={() => recording && pttUp()}>{recording ? "● rec" : "🎙"}</button>
              {stream ? <button className="btn btn-danger" onClick={stop}>■ Stop</button> : <button className="btn btn-primary" disabled={!input.trim() && !atts.length} onClick={() => submit(voice)}>Send ↵</button>}
            </div>
            <div className="mt-1.5 flex items-center gap-3 text-[11px] text-faint">
              <label className="flex cursor-pointer items-center gap-1"><input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />speak replies</label>
              <span>Enter to send · Shift+Enter newline · Esc stops</span>
              {think && est.data && <span className="text-accent">🧠 Think: {est.data.drafts} drafts + judge, about {est.data.seconds}s</span>}
            </div>
          </div>
        </div>
      </section>

      {openArt && (
        <aside className="flex w-[46%] min-w-[340px] shrink-0 flex-col border-l border-line bg-panel max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-20 max-xl:w-[88%] max-xl:shadow-2xl">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
            <select className="input !w-auto !py-1" value={openArt.key} onChange={(e) => setArtKey(e.target.value)}>{arts.map((a) => <option key={a.key} value={a.key}>{a.title}</option>)}</select>
            <button className="btn btn-ghost ml-auto" onClick={() => setArtKey(null)}>✕</button>
          </div>
          <div className="min-h-0 flex-1"><ArtifactView key={openArt.key} versions={openArt.versions} title={openArt.title} kind={openArt.kind} lang={openArt.lang} streaming={openArt.streaming} onCanvas={async (c) => { const r = await api.post("/api/canvas", { title: openArt.title, kind: openArt.kind, content: c }); nav(`/canvas?open=${r.canvas.id}`); }} /></div>
        </aside>
      )}
    </div>
  );
}
