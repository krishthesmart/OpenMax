import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useFetch } from "../lib/hooks";

const OP_LABEL: Record<string, string> = { t2i: "Text → Image", i2v: "Image → Video", t2v: "Text → Video", v2v: "Video → Video", edit: "Edit image" };
const SUB_LABEL: Record<string, string> = { restyle: "Restyle", extend: "Extend", replace_subject: "Replace subject", camera_move: "Add camera move" };

function Media({ o, className = "" }: { o: any; className?: string }) {
  if (o.mime?.startsWith("video/")) return <video src={o.url} className={className} controls loop muted autoPlay playsInline />;
  return <img src={o.url} className={className} alt="" />;
}

function Generate() {
  const be = useFetch<any>("/api/studio/backends");
  const pre = useFetch<any>("/api/studio/presets");
  const jobs = useFetch<any>("/api/studio/jobs", [], 1500);
  const [backend, setBackend] = useState(""); const [op, setOp] = useState("t2i"); const [subop, setSubop] = useState("restyle");
  const [prompt, setPrompt] = useState(""); const [negative, setNegative] = useState(""); const [aspect, setAspect] = useState("16:9");
  const [duration, setDuration] = useState(4); const [count, setCount] = useState(1); const [seed, setSeed] = useState<number | "">("");
  const [chosen, setChosen] = useState<string[]>([]); const [input, setInput] = useState<any>(); const [err, setErr] = useState<any>(); const [busy, setBusy] = useState(false); const [view, setView] = useState<any>();
  useEffect(() => { if (be.data && !backend) setBackend(be.data.backends.find((b: any) => b.default)?.id ?? be.data.backends[0]?.id); }, [be.data, backend]);
  const cur = be.data?.backends.find((b: any) => b.id === backend);
  const ops = cur?.ops ?? {};
  const video = op === "i2v" || op === "t2v" || op === "v2v";
  const needsInput = op === "i2v" || op === "v2v" || op === "edit";
  useEffect(() => { if (cur && ops[op] && !ops[op].supported) { const first = Object.keys(ops).find((k) => ops[k].supported); if (first) setOp(first); } }, [backend]); // eslint-disable-line

  const submit = async () => {
    setBusy(true); setErr(undefined);
    try { await api.post("/api/studio/jobs", { op, subop: op === "v2v" ? subop : undefined, prompt, negative: negative || undefined, aspect, duration: video ? duration : undefined, count, seed: seed === "" ? undefined : Number(seed), presets: chosen, inputAttachmentId: input?.id, backend }); jobs.reload(); }
    catch (e: any) { setErr({ message: e.message, fix: e.fix }); } finally { setBusy(false); }
  };
  const enhance = async () => { try { setPrompt((await api.post("/api/studio/enhance", { prompt, op })).prompt); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  const upload = async (f: File) => { const fd = new FormData(); fd.append("file", f); try { setInput((await api.upload("/api/attachments", fd)).attachment); } catch (e: any) { setErr({ message: e.message }); } };
  const remix = (j: any) => { const p = j.params; setBackend(p.backend); setOp(p.op); if (p.subop) setSubop(p.subop); setPrompt(p.prompt); setNegative(p.negative ?? ""); setAspect(p.aspect); setDuration(p.duration ?? 4); setCount(p.count); setSeed(j.outputs[0]?.seed ?? ""); setChosen(p.presets); setView(undefined); };
  const del = async (id: string) => { await api.del(`/api/studio/jobs/${id}`); setView(undefined); jobs.reload(); };
  const presets: any[] = pre.data?.presets ?? [];
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const opHint = ops[op] && !ops[op].supported ? ops[op].reason : undefined;
  const aspects: string[] = be.data?.aspects ?? [];

  return (
    <div className="flex h-full">
      <div className="w-[380px] shrink-0 space-y-4 overflow-y-auto border-r border-line p-4 max-md:w-full">
        <div><div className="label mb-1">Backend</div>
          <select className="input" value={backend} onChange={(e) => setBackend(e.target.value)}>{be.data?.backends.map((b: any) => <option key={b.id} value={b.id}>{b.label}{b.status.ok ? "" : " (unavailable)"}</option>)}</select>
          {cur && !cur.status.ok && <p className="mt-1 text-[12px] text-warn">{cur.status.detail}</p>}
          {cur?.id === "mock" && <p className="mt-1 text-[12px] text-faint">Mock draws SVG placeholders so you can try the whole flow without a GPU. Set MEDIA_PROVIDER=comfy for real output.</p>}
        </div>
        <div><div className="label mb-1">Operation</div>
          <div className="flex flex-wrap gap-1.5">{Object.keys(OP_LABEL).map((k) => { const s = ops[k]; const off = s && !s.supported; return <button key={k} title={off ? s.reason : ""} disabled={off} onClick={() => setOp(k)} className={`btn !py-1 ${op === k ? "btn-primary" : ""}`}>{OP_LABEL[k]}</button>; })}</div>
          {Object.entries(ops).filter(([, s]: any) => !s.supported).map(([k, s]: any) => <p key={k} className="mt-1 text-[11px] text-faint">⊘ {OP_LABEL[k]}: {s.reason}</p>)}
          {opHint && <p className="mt-1 text-[12px] text-warn">{opHint}</p>}
        </div>
        {op === "v2v" && <div><div className="label mb-1">Video edit</div><div className="flex flex-wrap gap-1.5">{Object.entries(SUB_LABEL).map(([k, l]) => <button key={k} onClick={() => setSubop(k)} className={`btn !py-1 ${subop === k ? "btn-primary" : ""}`}>{l}</button>)}</div></div>}
        {needsInput && <div><div className="label mb-1">Input {op === "v2v" ? "video" : "image"}</div>{input ? <div className="chip">📎 {input.name}<button className="ml-1 text-faint hover:text-bad" onClick={() => setInput(undefined)}>✕</button></div> : <label className="btn cursor-pointer"><input type="file" className="hidden" accept={op === "v2v" ? "video/*" : "image/*"} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />Upload…</label>}</div>}
        <div><div className="mb-1 flex items-center"><span className="label">Prompt</span><button className="btn btn-ghost ml-auto !py-0 text-[11px] text-accent" disabled={prompt.length < 2} onClick={enhance}>✨ enhance</button></div>
          <textarea className="input min-h-24" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe what you want to see…" /></div>
        <div><div className="label mb-1">Negative (optional)</div><input className="input" value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="blurry, text, watermark" /></div>
        <div><div className="label mb-1">Presets</div>
          {(["motion", "style"] as const).map((kind) => (video || kind === "style") && <div key={kind} className="mb-2"><div className="mb-1 text-[11px] text-faint">{kind === "motion" ? "Camera & motion" : "Look"}</div><div className="flex flex-wrap gap-1">{presets.filter((p) => p.kind === kind).map((p) => <button key={p.id} title={p.prompt} onClick={() => toggle(p.id)} className={`chip cursor-pointer ${chosen.includes(p.id) ? "!border-accent !bg-accent/20 !text-accent" : "hover:border-accent/50"}`}>{p.label}</button>)}</div></div>)}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><div className="label mb-1">Aspect</div><select className="input" value={aspect} onChange={(e) => setAspect(e.target.value)}>{aspects.map((a) => <option key={a}>{a}</option>)}</select></div>
          <div><div className="label mb-1">Count</div><select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))}>{[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></div>
          {video && <div className="col-span-2"><div className="label mb-1">Duration · {duration}s</div><input type="range" min={1} max={10} value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="w-full" /></div>}
          <div className="col-span-2"><div className="label mb-1">Seed</div><div className="flex gap-2"><input className="input" type="number" placeholder="random" value={seed} onChange={(e) => setSeed(e.target.value === "" ? "" : Number(e.target.value))} /><button className="btn" onClick={() => setSeed(Math.floor(Math.random() * 1e9))}>🎲</button></div></div>
        </div>
        {err && <div className="rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px]"><div className="text-bad">{err.message}</div>{err.fix && <div className="mt-1 text-dim">{err.fix}</div>}</div>}
        <button className="btn btn-primary w-full justify-center !py-2.5" disabled={busy || !!opHint || (!prompt.trim() && !(op === "v2v" && subop === "extend")) || (needsInput && !input)} onClick={submit}>Generate</button>
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {jobs.data?.jobs.length === 0 && <p className="mt-20 text-center text-dim">Your generations appear here.</p>}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {jobs.data?.jobs.map((j: any) => (
            <div key={j.id} className="card overflow-hidden">
              {j.status === "done" && j.outputs[0] ? <button className="block w-full" onClick={() => setView(j)}><Media o={j.outputs[0]} className="aspect-video w-full bg-black object-contain" /></button>
                : <div className="grid aspect-video place-items-center bg-bg p-3 text-center text-[12px]">{j.status === "error" ? <span className="text-bad">{j.error}</span> : j.status === "cancelled" ? "cancelled" : <div className="w-full"><div className="mb-2 text-dim">{j.status === "queued" ? "Queued…" : j.note ?? "Generating…"}</div><div className="h-1.5 overflow-hidden rounded bg-line"><div className="h-full bg-accent transition-all" style={{ width: `${Math.max(5, j.progress * 100)}%` }} /></div></div>}</div>}
              <div className="flex items-center gap-1 px-2.5 py-2 text-[12px]"><span className="chip">{j.params.op}</span><span className="min-w-0 flex-1 truncate text-dim" title={j.params.prompt}>{j.params.prompt}</span>{j.outputs.length > 1 && <span className="chip">×{j.outputs.length}</span>}</div>
            </div>
          ))}
        </div>
      </div>

      {view && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/85 p-6" onClick={() => setView(undefined)}>
          <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-3" onClick={(e) => e.stopPropagation()}>
            <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-2 overflow-y-auto">{view.outputs.map((o: any) => <div key={o.url} className="relative min-h-[200px]"><Media o={o} className="h-full w-full rounded-lg bg-black object-contain" /><a className="btn absolute bottom-2 right-2 !py-0.5" href={o.url} download>↓</a><span className="chip absolute left-2 top-2">seed {o.seed}</span></div>)}</div>
            <div className="card flex items-center gap-2 p-3 text-[13px]"><span className="min-w-0 flex-1 truncate text-dim">{view.params.prompt}</span><button className="btn btn-primary" onClick={() => remix(view)}>Remix</button><button className="btn btn-danger" onClick={() => del(view.id)}>Delete</button><button className="btn" onClick={() => setView(undefined)}>Close</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function Storybook() {
  const be = useFetch<any>("/api/studio/backends");
  const list = useFetch<any>("/api/studio/story", [], 2500);
  const [premise, setPremise] = useState(""); const [style, setStyle] = useState(""); const [backend, setBackend] = useState(""); const [sel, setSel] = useState<string | null>(null); const [err, setErr] = useState<any>();
  const story = useFetch<any>(sel ? `/api/studio/story/${sel}` : null, [sel], 2000);
  const s = story.data?.story;
  const usable = useMemo(() => be.data?.backends.filter((b: any) => b.ops.t2i.supported) ?? [], [be.data]);
  const start = async () => { setErr(undefined); try { const r = await api.post("/api/studio/story", { premise, style: style || undefined, backend: backend || undefined }); setSel(r.id); list.reload(); } catch (e: any) { setErr({ message: e.message, fix: e.fix }); } };
  return (
    <div className="flex h-full">
      <aside className="w-72 shrink-0 space-y-3 overflow-y-auto border-r border-line p-4">
        <div className="label">New storybook (10 pages)</div>
        <textarea className="input min-h-24" placeholder="A shy mouse who wants to visit the moon…" value={premise} onChange={(e) => setPremise(e.target.value)} />
        <input className="input" placeholder="Art style (optional)" value={style} onChange={(e) => setStyle(e.target.value)} />
        <select className="input" value={backend} onChange={(e) => setBackend(e.target.value)}><option value="">Default image backend</option>{usable.map((b: any) => <option key={b.id} value={b.id}>{b.label}</option>)}</select>
        {err && <p className="text-[12px] text-bad">{err.message}</p>}
        <button className="btn btn-primary w-full justify-center" disabled={premise.length < 5} onClick={start}>Write & illustrate</button>
        <div className="label pt-2">Your stories</div>
        {list.data?.stories.map((x: any) => <button key={x.id} onClick={() => setSel(x.id)} className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] ${sel === x.id ? "bg-panel2" : "hover:bg-panel"}`}><span className="min-w-0 flex-1 truncate">{x.title}</span><span className="chip">{x.status === "done" ? "ready" : x.status === "error" ? "failed" : `${Math.round(x.progress * 100)}%`}</span></button>)}
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {!s ? <p className="mt-20 text-center text-dim">Pick or create a story. Characters keep one fixed description on every page so they look the same throughout.</p> : (
          <div className="mx-auto max-w-4xl">
            <div className="mb-4 flex items-center gap-3"><h2 className="text-xl font-semibold">{s.title}</h2><span className="chip">{s.status}</span>
              {s.status === "done" && <a className="btn btn-primary ml-auto" href={`/api/studio/story/${s.id}/pdf`}>Download PDF</a>}
              <button className="btn btn-danger" onClick={async () => { await api.del(`/api/studio/story/${s.id}`); setSel(null); list.reload(); }}>Delete</button></div>
            {s.status !== "done" && s.status !== "error" && <div className="mb-4"><div className="mb-1 text-[12px] text-dim">{s.status}…</div><div className="h-1.5 overflow-hidden rounded bg-line"><div className="h-full bg-accent transition-all" style={{ width: `${s.progress * 100}%` }} /></div></div>}
            {s.error && <div className="mb-4 rounded-xl border border-bad/40 bg-bad/10 p-3 text-[13px] text-bad">{s.error}</div>}
            {s.characters?.length > 0 && <div className="card mb-4 p-3 text-[12px]"><div className="label mb-1">Cast (kept identical on every page)</div>{s.characters.map((c: any) => <div key={c.name}><b>{c.name}</b> — <span className="text-dim">{c.look}</span></div>)}</div>}
            <div className="grid gap-4 md:grid-cols-2">{s.pages.map((p: any, i: number) => <div key={i} className="card overflow-hidden">{p.image ? <img className="aspect-[4/3] w-full bg-black object-cover" src={`/api/media/story-${s.id}/${p.image}`} alt="" /> : <div className="grid aspect-[4/3] place-items-center bg-bg text-[12px] text-faint">{p.error ?? "illustrating…"}</div>}<div className="p-3 text-[14px]"><span className="mr-1 text-faint">{i + 1}.</span>{p.text}</div></div>)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Studio() {
  const [tab, setTab] = useState<"gen" | "story">("gen");
  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-line px-4 py-2">{([["gen", "Generate"], ["story", "Storybook"]] as const).map(([k, l]) => <button key={k} className={`btn !py-1 ${tab === k ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="min-h-0 flex-1">{tab === "gen" ? <Generate /> : <Storybook />}</div>
    </div>
  );
}
