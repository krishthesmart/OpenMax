import { useEffect, useState } from "react";
import { api, streamPost } from "../lib/api";

const KEYS: [string, string, string][] = [
  ["NVIDIA_API_KEY", "NVIDIA", "build.nvidia.com"],
  ["GEMINI_API_KEY", "Google AI Studio", "aistudio.google.com"],
  ["OPENROUTER_API_KEY", "OpenRouter", "openrouter.ai/keys"],
  ["GROQ_API_KEY", "Groq", "console.groq.com"],
];
const STEPS = ["Welcome", "API keys", "Test providers", "Hardware & local models", "Search & media", "Done"];

export function Wizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [state, setState] = useState<any>();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [verify, setVerify] = useState<any[]>([]);
  const [test, setTest] = useState<any>();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [pull, setPull] = useState<Record<string, string>>({});
  const [applied, setApplied] = useState(false);
  const load = async () => setState(await api.get("/api/setup/state"));
  useEffect(() => { void load(); }, []);

  const saveKeys = async () => {
    setBusy("keys"); setErr("");
    try {
      const updates = Object.fromEntries(Object.entries(vals).filter(([, v]) => v.trim()));
      const r = Object.keys(updates).length ? await api.put("/api/setup/env", { updates }) : { providers: (await api.post("/api/providers/test")).providers };
      setVerify(r.providers); setVals({}); await load();
    } catch (e: any) { setErr(e.message); }
    setBusy("");
  };
  const runTest = async () => { setBusy("test"); setErr(""); try { setTest(await api.post("/api/providers/test")); } catch (e: any) { setErr(e.message); } setBusy(""); };
  const applySuggestions = async () => {
    const rc = await api.get("/api/router/config");
    const lanes = { ...rc.config.lanes };
    for (const [k, refs] of Object.entries(rc.suggestions as Record<string, string[]>)) lanes[k] = [...new Set([...(refs as string[]), ...(lanes[k] ?? [])])];
    await api.put("/api/router/config", { ...rc.config, lanes });
    setApplied(true);
  };
  const doPull = async (model: string) => {
    setPull((p) => ({ ...p, [model]: "starting…" }));
    try {
      await streamPost("/api/ollama/pull", { model }, (ev, d) => {
        if (ev === "progress") setPull((p) => ({ ...p, [model]: d.total ? Math.round((d.completed / d.total) * 100) + "% " + d.status : d.status }));
        if (ev === "done") setPull((p) => ({ ...p, [model]: "installed ✓" }));
        if (ev === "error") setPull((p) => ({ ...p, [model]: "✗ " + d.message + " " + (d.fix ?? "") }));
      });
    } catch (e: any) { setPull((p) => ({ ...p, [model]: "✗ " + e.message })); }
    void load();
  };
  const finish = async () => { await api.post("/api/setup/complete"); onClose(); };
  const s = state;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4">
      <div className="card flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <b>Set up OpenMax</b>
          <span className="text-[12px] text-faint">step {step + 1} of {STEPS.length} · {STEPS[step]}</span>
          <button className="btn btn-ghost ml-auto !py-0.5" onClick={finish}>Skip setup</button>
        </div>
        <div className="flex gap-1 px-5 pt-3">{STEPS.map((_, i) => <div key={i} className={"h-1 flex-1 rounded " + (i <= step ? "bg-accent" : "bg-line")} />)}</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 text-[13.5px]">
          {step === 0 && (
            <div className="space-y-3">
              <h2 className="text-xl font-semibold">Your AI workbench, at $0 a month</h2>
              <p className="text-dim">OpenMax routes every request to the strongest model available across free cloud tiers (NVIDIA, Google AI Studio, OpenRouter, Groq) and models running on this machine. This takes about two minutes, and every step is optional.</p>
              <ul className="ml-5 list-disc space-y-1 text-dim">
                <li>Add the free API keys you have (nothing leaves this machine except calls to those providers).</li>
                <li>Test that the models in your lanes actually respond.</li>
                <li>Pick local models that fit your hardware.</li>
              </ul>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-dim">Paste any keys you have. They are saved to your local <code>.env</code> (owner-only permissions) and never shown again.</p>
              {KEYS.map(([env, label, where]) => (
                <div key={env}>
                  <div className="mb-1 flex items-center gap-2"><span className="font-medium">{label}</span>{s?.keys[env] && <span className="chip !text-good">key set ✓</span>}<span className="text-[11px] text-faint">{where}</span></div>
                  <input className="input font-mono" type="password" autoComplete="off" placeholder={s?.keys[env] ? "•••••••• (leave blank to keep)" : "paste key"} value={vals[env] ?? ""} onChange={(e) => setVals({ ...vals, [env]: e.target.value })} />
                </div>
              ))}
              <button className="btn btn-primary" disabled={busy === "keys"} onClick={saveKeys}>{busy === "keys" ? "Verifying…" : "Save & verify"}</button>
              {verify.map((p) => (
                <div key={p.provider} className="text-[12px]">
                  <span className={p.ok ? "text-good" : p.enabled ? "text-bad" : "text-faint"}>●</span> {p.label}: {p.ok ? p.models + " models available" : p.error + (p.enabled ? " — " + p.fix : "")}
                </div>
              ))}
            </div>
          )}
          {step === 2 && (
            <div className="space-y-3">
              <p className="text-dim">Sends a one-token ping to every model in your lanes and reads each provider's model list.</p>
              <button className="btn btn-primary" disabled={busy === "test"} onClick={runTest}>{busy === "test" ? "Testing…" : "Test providers"}</button>
              {test && (
                <>
                  <div className="space-y-0.5 text-[12px]">{test.providers.map((p: any) => <div key={p.provider}><span className={p.ok ? "text-good" : "text-faint"}>●</span> {p.label}: {p.ok ? p.models + " models" : p.error}</div>)}</div>
                  <div className="max-h-44 overflow-y-auto rounded-lg border border-line p-2 font-mono text-[11.5px]">
                    {test.refs.filter((r: any) => !r.skipped).map((r: any) => <div key={r.ref}><span className={r.ok ? "text-good" : "text-bad"}>{r.ok ? "✓" : "✗"}</span> {r.ref} <span className="text-faint">{r.ms ? r.ms + "ms" : ""} {r.error ?? ""}</span></div>)}
                  </div>
                  {Object.keys(test.suggestions).length > 0 && (
                    <div>
                      <p className="text-dim">Suggested lane picks from your live model list:</p>
                      <div className="text-[12px] text-dim">{Object.entries(test.suggestions).map(([k, v]: any) => <div key={k}><b>{k}</b>: {v.join(", ")}</div>)}</div>
                      <button className="btn mt-2" disabled={applied} onClick={applySuggestions}>{applied ? "Applied ✓ (edit on the Router page)" : "Add suggestions to my lanes"}</button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {step === 3 && s && (
            <div className="space-y-3">
              <div className="card p-3">Detected: <b>{s.hardware.memoryGb} GB</b> {s.hardware.gpu.kind === "nvidia" ? "VRAM (" + s.hardware.gpu.name + ")" : s.hardware.gpu.kind === "apple" ? "unified memory (Apple silicon)" : "RAM (no GPU found)"} → tier <b>{s.tier.label}</b></div>
              {!s.ollama.running && <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-[12.5px]">Ollama is not running. Install it from ollama.com and run <code>ollama serve</code>, then reload this step. Local models are optional but give you a private fallback.</div>}
              {s.ollama.recommended.map((m: any) => (
                <div key={m.model} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                  <span className="chip">{m.kind}</span><code className="flex-1">{m.model}</code>
                  {m.installed || pull[m.model] === "installed ✓" ? <span className="text-good">installed ✓</span> : pull[m.model] ? <span className="text-[12px] text-dim">{pull[m.model]}</span> : <button className="btn !py-0.5" disabled={!s.ollama.running} onClick={() => doPull(m.model)}>ollama pull</button>}
                </div>
              ))}
              <p className="text-[11px] text-faint">Recommendations come from data/local-models.json. Models are large downloads; pull only what you want.</p>
            </div>
          )}
          {step === 4 && s && (
            <div className="space-y-2">
              <div className="card p-3"><b>Web search</b> ({s.search.backend}) <span className={s.search.ok ? "text-good" : "text-warn"}>● {s.search.ok ? "ready" : s.search.detail}</span>{!s.search.ok && <p className="mt-1 text-[12px] text-dim">Run <code>docker compose up -d searxng</code>, or set SEARCH_BACKEND=brave and BRAVE_API_KEY.</p>}</div>
              <div className="card p-3"><b>Image & video</b> ({s.media.backend}) <span className={s.media.ok ? "text-good" : "text-warn"}>● {s.media.ok ? "ready" : s.media.detail}</span><p className="mt-1 text-[12px] text-dim">Studio works with SVG placeholders (mock) out of the box. For real generation run ComfyUI and set MEDIA_PROVIDER=comfy (see README).</p></div>
            </div>
          )}
          {step === 5 && (
            <div className="space-y-3 text-center">
              <div className="text-4xl">🎉</div>
              <h2 className="text-xl font-semibold">You're set</h2>
              <p className="text-dim">Watch the dots in the header: green means a provider is ready, yellow means it is cooling down after a rate limit or near its free-tier cap. The Router page shows which model answered each request and why.</p>
            </div>
          )}
          {err && <p className="mt-3 text-bad">{err}</p>}
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          <span className="ml-auto" />
          {step < STEPS.length - 1 ? <button className="btn btn-primary" onClick={() => setStep(step + 1)}>{step === 0 ? "Start" : "Next"}</button> : <button className="btn btn-primary" onClick={finish}>Finish</button>}
        </div>
      </div>
    </div>
  );
}
