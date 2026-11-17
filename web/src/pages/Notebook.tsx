import { useEffect, useRef, useState } from "react";
import { api, streamPost } from "../lib/api";
import { useFetch } from "../lib/hooks";
import { Markdown } from "../components/Markdown";
import { MindMap } from "../components/MindMap";

const GENS: [string, string, string][] = [["audio", "🎙", "Audio overview"], ["study_guide", "📘", "Study guide"], ["faq", "❓", "FAQ"], ["timeline", "🕒", "Timeline"], ["quiz", "📝", "Quiz"], ["flashcards", "🃏", "Flashcards"], ["mindmap", "🧠", "Mind map"], ["slides", "📊", "Slides (.pptx)"]];

function Output({ nid, id, onClose }: { nid: string; id: string; onClose: () => void }) {
  const { data } = useFetch<any>(`/api/notebooks/${nid}/outputs/${id}`, [id]);
  const o = data?.output; const audio = useRef<HTMLAudioElement>(null);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const cards = useFetch<any>(o?.kind === "flashcards" ? `/api/notebooks/${nid}/cards` : null, [o?.kind]);
  const [flip, setFlip] = useState(false);
  const due = cards.data?.cards.filter((c: any) => c.due <= Date.now()) ?? [];
  const fileUrl = `/api/notebooks/${nid}/outputs/${id}/file`;
  if (!o) return <div className="p-4 text-dim">Loading…</div>;
  const d = o.data;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2"><b className="truncate">{o.title}</b>{o.hasFile && o.kind === "slides" && <a className="btn btn-primary !py-0.5" href={fileUrl} download>Download .pptx</a>}<button className="btn btn-ghost ml-auto" onClick={onClose}>✕</button></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[13.5px]">
        {o.kind === "study_guide" && <Markdown text={d.markdown} />}
        {o.kind === "faq" && d.items.map((i: any, k: number) => <details key={k} className="mb-2 rounded-lg border border-line p-3"><summary className="cursor-pointer font-medium">{i.q}</summary><p className="mt-2 text-dim">{i.a}</p></details>)}
        {o.kind === "timeline" && <ol className="relative ml-2 border-l border-line pl-5">{d.events.map((e: any, k: number) => <li key={k} className="mb-4"><span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-accent" /><div className="text-[12px] font-semibold text-accent">{e.when}</div><div>{e.what}</div></li>)}</ol>}
        {o.kind === "quiz" && d.questions.map((q: any, k: number) => (
          <div key={k} className="mb-4"><div className="mb-1.5 font-medium">{k + 1}. {q.q}</div>
            {q.options.map((op: string, oi: number) => { const sel = picked[k]; const show = sel !== undefined; const cls = !show ? "hover:border-accent/60" : oi === q.answer ? "!border-good !bg-good/10" : sel === oi ? "!border-bad !bg-bad/10" : "opacity-60"; return <button key={oi} disabled={show} onClick={() => setPicked({ ...picked, [k]: oi })} className={`mb-1 block w-full rounded-lg border border-line px-3 py-1.5 text-left ${cls}`}>{String.fromCharCode(65 + oi)}. {op}</button>; })}
            {picked[k] !== undefined && q.explanation && <p className="mt-1 text-[12px] text-dim">{q.explanation}</p>}</div>
        ))}
        {o.kind === "quiz" && Object.keys(picked).length === d.questions.length && <div className="card p-3">Score: <b>{d.questions.filter((q: any, k: number) => picked[k] === q.answer).length}/{d.questions.length}</b></div>}
        {o.kind === "flashcards" && (
          <div>{due.length ? (<div><div className="mb-2 text-[12px] text-dim">{due.length} due · SM-2 spaced repetition</div>
            <button onClick={() => setFlip(!flip)} className="card grid min-h-40 w-full place-items-center p-6 text-center text-lg">{flip ? due[0].back : due[0].front}<span className="mt-3 text-[11px] text-faint">{flip ? "answer" : "click to reveal"}</span></button>
            {flip && <div className="mt-3 grid grid-cols-4 gap-2">{[["Again", 1], ["Hard", 3], ["Good", 4], ["Easy", 5]].map(([l, q]) => <button key={l as string} className="btn justify-center" onClick={async () => { await api.post(`/api/cards/${due[0].id}/review`, { quality: q }); setFlip(false); cards.reload(); }}>{l}</button>)}</div>}</div>)
            : <p className="text-dim">🎉 No cards due. {cards.data?.cards.length} cards total; the next one is due {cards.data?.cards[0] ? new Date(cards.data.cards[0].due).toLocaleString() : "—"}.</p>}</div>
        )}
        {o.kind === "mindmap" && <MindMap root={d} />}
        {o.kind === "slides" && d.slides.map((s: any, k: number) => <div key={k} className="card mb-2 p-3"><div className="font-semibold">{k + 1}. {s.title}</div><ul className="ml-4 list-disc text-dim">{s.bullets.map((b: string, i: number) => <li key={i}>{b}</li>)}</ul></div>)}
        {o.kind === "audio" && (
          <div><audio ref={audio} controls className="w-full" src={fileUrl} />
            <div className="label mb-1 mt-3">Chapters</div>
            {d.chapters.map((c: any, k: number) => <button key={k} className="mb-1 flex w-full items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-left hover:border-accent/60" onClick={() => { if (audio.current) { audio.current.currentTime = c.start; void audio.current.play(); } }}><span className="font-mono text-[11px] text-accent">{Math.floor(c.start / 60)}:{String(Math.floor(c.start % 60)).padStart(2, "0")}</span>{c.title}</button>)}
            <p className="mt-2 text-[11px] text-faint">Voice: {d.ttsBackend}· {d.encoder}</p>
            <details className="mt-3"><summary className="cursor-pointer text-dim">Script</summary>{d.script.chapters.map((c: any, k: number) => <div key={k} className="mt-2"><div className="font-medium">{c.title}</div>{c.lines.map((l: any, i: number) => <p key={i}><b className={l.speaker === "A" ? "text-accent" : "text-accent2"}>{l.speaker}:</b> {l.text}</p>)}</div>)}</details></div>
        )}
      </div>
    </div>
  );
}

export function Notebook() {
  const list = useFetch<any>("/api/notebooks");
  const [nid, setNid] = useState<string | null>(null);
  const book = useFetch<any>(nid ? `/api/notebooks/${nid}` : null, [nid]);
  const [url, setUrl] = useState(""); const [paste, setPaste] = useState(""); const [pasteName, setPasteName] = useState(""); const [adding, setAdding] = useState("");
  const [q, setQ] = useState(""); const [chat, setChat] = useState<any[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<any>();
  const [view, setView] = useState<{ sid: string; start?: number; end?: number } | null>(null);
  const src = useFetch<any>(nid && view ? `/api/notebooks/${nid}/sources/${view.sid}` : null, [view?.sid]);
  const [out, setOut] = useState<string | null>(null); const [gen, setGen] = useState(""); const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!nid && list.data?.notebooks[0]) setNid(list.data.notebooks[0].id); }, [list.data, nid]);
  useEffect(() => { setChat([]); setView(null); setOut(null); }, [nid]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [chat]);
  const b = book.data?.notebook;

  const create = async () => { const r = await api.post("/api/notebooks", { title: "Untitled notebook" }); list.reload(); setNid(r.notebook.id); };
  const addUrl = async () => { setAdding("Adding…"); setErr(undefined); try { await api.post(`/api/notebooks/${nid}/sources`, { kind: "url", url }); setUrl(""); book.reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } setAdding(""); };
  const addText = async () => { setAdding("Adding…"); setErr(undefined); try { await api.post(`/api/notebooks/${nid}/sources`, { kind: "text", text: paste, name: pasteName || "Pasted text" }); setPaste(""); setPasteName(""); book.reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } setAdding(""); };
  const addFile = async (f: File) => { setAdding(`Reading ${f.name}…`); setErr(undefined); try { const fd = new FormData(); fd.append("file", f); await api.upload(`/api/notebooks/${nid}/sources`, fd); book.reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } setAdding(""); };
  const ask = async (cloud = false, question = q) => {
    if (!question.trim() || busy) return; setQ(""); setBusy(true); setErr(undefined);
    const hist = chat.map((m) => ({ role: m.role, content: m.text }));
    setChat((c) => [...c, { role: "user", text: question }, { role: "assistant", text: "", citations: [] }]);
    try {
      await streamPost(`/api/notebooks/${nid}/chat`, { question, history: hist, allowCloud: cloud }, (ev, d) => {
        setChat((c) => { const m = [...c]; const last = { ...m[m.length - 1] };
          if (ev === "text") last.text += d.text; else if (ev === "sources") last.pool = d; else if (ev === "done") { last.text = d.text; last.citations = d.citations; last.grounded = d.grounded; last.refused = d.refused; } else if (ev === "error") last.error = d;
          m[m.length - 1] = last; return m; });
      });
    } catch (e: any) { setErr({ message: e.message, fix: e.fix }); }
    setBusy(false);
  };
  const generate = async (kind: string) => { setGen(kind); setErr(undefined); try { const r = await api.post(`/api/notebooks/${nid}/generate`, { kind }); await book.reload(); setOut(r.output.id); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } setGen(""); };
  const hl = (m: any, n: number) => { const c = m.citations?.find((x: any) => x.n === n); if (c) setView({ sid: c.sourceId, start: c.start, end: c.end }); };

  return (
    <div className="flex h-full">
      <aside className="flex w-72 shrink-0 flex-col border-r border-line max-lg:hidden">
        <div className="space-y-2 p-3">
          <div className="flex gap-2"><select className="input" value={nid ?? ""} onChange={(e) => setNid(e.target.value)}>{list.data?.notebooks.map((n: any) => <option key={n.id} value={n.id}>{n.private ? "🔒 " : ""}{n.title}</option>)}</select><button className="btn btn-primary" onClick={create}>＋</button></div>
          {b && <div className="flex items-center gap-2"><input className="input !py-1" defaultValue={b.title} key={b.id} onBlur={async (e) => { if (e.target.value !== b.title) { await api.patch(`/api/notebooks/${b.id}`, { title: e.target.value }); list.reload(); } }} />
            <label className="flex shrink-0 items-center gap-1 text-[11px] text-dim" title="Private notebooks use local models only"><input type="checkbox" checked={b.private} onChange={async (e) => { await api.patch(`/api/notebooks/${b.id}`, { private: e.target.checked }); book.reload(); list.reload(); }} />🔒</label>
            <button className="text-faint hover:text-bad" title="Delete notebook" onClick={async () => { if (confirm("Delete this notebook and its sources?")) { await api.del(`/api/notebooks/${b.id}`); setNid(null); list.reload(); } }}>🗑</button></div>}
        </div>
        {b && <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
          <div className="label">Sources ({book.data.sources.length})</div>
          {book.data.sources.map((s: any) => <div key={s.id} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] ${view?.sid === s.id ? "bg-panel2" : "hover:bg-panel"}`}><button className="min-w-0 flex-1 truncate text-left" onClick={() => setView({ sid: s.id })}>{s.kind === "pdf" ? "📄" : s.kind === "youtube" ? "▶️" : s.kind === "url" ? "🌐" : "📝"} {s.name}</button><button className="hidden text-faint hover:text-bad group-hover:block" onClick={async () => { await api.del(`/api/notebooks/${b.id}/sources/${s.id}`); book.reload(); if (view?.sid === s.id) setView(null); }}>✕</button></div>)}
          <label className="btn w-full cursor-pointer justify-center"><input type="file" className="hidden" accept=".pdf,.txt,.md,.csv,.json,.html" onChange={(e) => e.target.files?.[0] && addFile(e.target.files[0])} />＋ PDF / text file</label>
          <div className="flex gap-1"><input className="input !py-1" placeholder="Web or YouTube URL" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addUrl()} /><button className="btn" disabled={!url} onClick={addUrl}>Add</button></div>
          <details><summary className="cursor-pointer text-[12px] text-dim">Paste text / transcript</summary><input className="input mt-2 !py-1" placeholder="Name" value={pasteName} onChange={(e) => setPasteName(e.target.value)} /><textarea className="input mt-1 min-h-24" value={paste} onChange={(e) => setPaste(e.target.value)} /><button className="btn mt-1" disabled={paste.length < 20} onClick={addText}>Add text</button></details>
          {adding && <p className="text-[12px] text-accent">{adding}</p>}
        </div>}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {!b ? <div className="grid flex-1 place-items-center text-dim"><div className="text-center"><p>Create a notebook, add sources, then chat grounded in them.</p><button className="btn btn-primary mt-3" onClick={create}>＋ New notebook</button></div></div> : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto max-w-3xl space-y-5 px-5 py-6">
              {chat.length === 0 && <div className="pt-10 text-center text-dim">{book.data.sources.length ? "Ask a question. Answers use only your sources, with citations you can click." : "Add a source on the left to begin."}{book.data.sources.length > 0 && <div className="mt-4 flex flex-wrap justify-center gap-2">{["Summarize the main ideas", "What are the key terms?", "What questions are left unanswered?"].map((s) => <button key={s} className="btn" onClick={() => ask(false, s)}>{s}</button>)}</div>}</div>}
              {chat.map((m, i) => m.role === "user" ? <div key={i} className="flex justify-end"><div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5">{m.text}</div></div> : (
                <div key={i}>{m.error ? <div className="text-bad">{m.error.message}</div> : <Markdown text={m.text} sources={(m.citations?.length ? m.citations : m.pool)?.map((c: any) => ({ n: c.n, title: c.source, snippet: c.text }))} onCite={(n) => hl(m, n)} />}
                  {m.grounded === false && <p className="mt-1 text-[12px] text-warn">⚠ No citations: treat this answer as unverified.</p>}
                  {m.citations?.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{m.citations.map((c: any) => <button key={c.n} className="chip hover:border-accent/60" onClick={() => setView({ sid: c.sourceId, start: c.start, end: c.end })}><span className="text-accent">{c.n}</span> {c.source.slice(0, 32)}</button>)}</div>}</div>
              ))}
              {err && <div className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px]"><div className="text-bad">{err.message}</div>{err.fix && <div className="mt-1 text-dim">{err.fix}</div>}{err.fix?.includes("cloud") && <button className="btn mt-2" onClick={() => ask(true, chat.filter((m) => m.role === "user").at(-1)?.text)}>Allow cloud for this message</button>}</div>}
              <div ref={bottom} />
            </div></div>
            <div className="border-t border-line p-3"><div className="mx-auto flex max-w-3xl gap-2"><input className="input !py-2.5" placeholder={book.data.sources.length ? "Ask about your sources…" : "Add a source first"} disabled={!book.data.sources.length} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} /><button className="btn btn-primary" disabled={busy || !q.trim()} onClick={() => ask()}>Ask</button></div></div>
          </>
        )}
      </section>

      <aside className="flex w-[380px] shrink-0 flex-col border-l border-line max-xl:hidden">
        {view && src.data ? (
          <div className="flex h-full flex-col"><div className="flex items-center gap-2 border-b border-line px-3 py-2"><b className="truncate">{src.data.source.name}</b><button className="btn btn-ghost ml-auto" onClick={() => setView(null)}>✕</button></div>
            <div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap p-4 text-[13px] leading-relaxed">{view.start !== undefined && view.end !== undefined ? <><span className="text-dim">{src.data.source.text.slice(Math.max(0, view.start - 300), view.start)}</span><mark ref={(el) => el?.scrollIntoView({ block: "center" })} className="rounded bg-accent/30 px-0.5 text-ink">{src.data.source.text.slice(view.start, view.end)}</mark><span className="text-dim">{src.data.source.text.slice(view.end, view.end + 300)}</span></> : src.data.source.text.slice(0, 20000)}</div></div>
        ) : out && nid ? <Output nid={nid} id={out} onClose={() => setOut(null)} /> : (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <div className="label mb-2">Studio</div>
            <div className="grid grid-cols-2 gap-2">{GENS.map(([k, ic, l]) => <button key={k} disabled={!b || !book.data?.sources.length || !!gen} className="btn !h-16 flex-col justify-center" onClick={() => generate(k)}><span className="text-lg">{ic}</span><span className="text-[12px]">{gen === k ? "Working…" : l}</span></button>)}</div>
            <div className="label mb-1 mt-5">Saved outputs</div>
            {book.data?.outputs.map((o: any) => <div key={o.id} className="group flex items-center rounded-lg px-2 py-1.5 text-[13px] hover:bg-panel"><button className="min-w-0 flex-1 truncate text-left" onClick={() => setOut(o.id)}>{GENS.find((g) => g[0] === o.kind)?.[1]} {o.title}</button><button className="hidden text-faint hover:text-bad group-hover:block" onClick={async () => { await api.del(`/api/notebooks/${nid}/outputs/${o.id}`); book.reload(); }}>✕</button></div>)}
            {book.data?.outputs.length === 0 && <p className="text-[12px] text-faint">Generated study material appears here.</p>}
          </div>
        )}
      </aside>
    </div>
  );
}
