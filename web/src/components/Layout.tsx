import { NavLink, Outlet } from "react-router-dom";
import { useState } from "react";
import { useFetch, useHotkeys } from "../lib/hooks";
import { setPrefs, usePrefs } from "../lib/store";
import { NAV } from "../nav";

function HealthDots() {
  const { data } = useFetch<any>("/api/health", [], 5000);
  if (!data) return <span className="text-faint text-xs">connecting…</span>;
  return (
    <div className="flex items-center gap-2.5" aria-label="provider health">
      {data.providers.filter((p: any) => p.enabled || !p.paid).map((p: any) => {
        const cool = p.cooldownSec > 0;
        const color = cool ? "bg-warn" : p.enabled ? "bg-good" : "bg-faint";
        const title = cool ? `${p.label} cooling down ${p.cooldownSec}s` : p.enabled ? `${p.label} ready` : `${p.label}: ${p.fix ?? "disabled"}`;
        return (
          <span key={p.id} title={title} className="flex items-center gap-1 text-[11px] text-dim">
            <span className={`dot ${color}`} />{p.id}{cool && <span className="text-warn">{p.cooldownSec}s</span>}
          </span>
        );
      })}
    </div>
  );
}

export function ModePicker() {
  const { mode } = usePrefs();
  const { data } = useFetch<any>("/api/router/config");
  const refs: string[] = data ? [...new Set(Object.values(data.config.lanes as Record<string, string[]>).flat())] : [];
  return (
    <select className="input !w-auto !py-1" value={mode} onChange={(e) => setPrefs({ mode: e.target.value })} title="Routing mode">
      <option value="auto">Auto</option>
      <option value="local-first">Local-first</option>
      <option value="cost-saver">Cost-saver</option>
      <optgroup label="Pin a model (manual)">
        {refs.map((r) => <option key={r} value={`manual:${r}`}>{r}</option>)}
      </optgroup>
    </select>
  );
}

export function Layout() {
  const { sidebarOpen, think } = usePrefs();
  const counts = useFetch<any>("/api/inbox/count", [], 5000);
  const [help, setHelp] = useState(false);
  useHotkeys({
    "mod+b": () => setPrefs({ sidebarOpen: !sidebarOpen }),
    "mod+shift+t": () => setPrefs({ think: !think }),
    "?": (e) => { if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) setHelp((h) => !h); },
  });
  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel max-md:absolute max-md:z-30 max-md:h-full max-md:shadow-2xl">
          <div className="flex items-center gap-2 px-4 py-4">
            <svg width="22" height="22" viewBox="0 0 32 32"><path d="M6 24 16 6l10 18" stroke="#7c9cff" strokeWidth="3.2" fill="none" strokeLinejoin="round" strokeLinecap="round" /><circle cx="16" cy="19" r="2.4" fill="#b48cff" /></svg>
            <span className="text-[15px] font-semibold tracking-tight">OpenMax</span>
          </div>
          <nav className="flex-1 overflow-y-auto px-2 pb-3">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === "/"} className={({ isActive }) => `mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] ${isActive ? "bg-accent/15 text-accent" : "text-dim hover:bg-panel2 hover:text-ink"}`}>
                <span className="w-4 text-center">{n.icon}</span>{n.label}{n.to === "/inbox" && counts.data && (counts.data.unread + counts.data.pendingApprovals > 0) && <span className={`ml-auto rounded-full px-1.5 text-[10px] font-semibold ${counts.data.pendingApprovals ? "bg-warn text-black" : "bg-accent text-black"}`}>{counts.data.pendingApprovals || counts.data.unread}</span>}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-line px-4 py-3 text-[11px] text-faint">⌘B sidebar · ⌘⇧T think · ? help</div>
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-panel/60 px-4 py-2 backdrop-blur">
          <button className="btn btn-ghost !px-2" onClick={() => setPrefs({ sidebarOpen: !sidebarOpen })} aria-label="Toggle sidebar">☰</button>
          <ModePicker />
          <button className={`btn ${think ? "btn-primary" : ""}`} onClick={() => setPrefs({ think: !think })} title="Think mode: several models draft, one judges (⌘⇧T)">🧠 Think</button>
          <div className="ml-auto max-md:hidden"><HealthDots /></div>
        </header>
        <main className="min-h-0 flex-1 overflow-hidden"><Outlet /></main>
      </div>
      {help && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={() => setHelp(false)}>
          <div className="card w-96 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-3 font-semibold">Keyboard shortcuts</h3>
            {[["⌘/Ctrl B", "Toggle sidebar"], ["⌘/Ctrl ⇧ T", "Toggle Think mode"], ["Enter", "Send message"], ["⇧ Enter", "New line"], ["Esc", "Stop generating"], ["?", "This help"]].map(([k, v]) => (
              <div key={k} className="flex justify-between py-1 text-[13px]"><kbd className="chip">{k}</kbd><span className="text-dim">{v}</span></div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
