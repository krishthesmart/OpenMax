import { useState } from "react";
import { useFetch } from "../lib/hooks";

const money = (n: number) => "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));
const num = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));

function Meter({ label, value, pct, note }: { label: string; value: string; pct?: number; note?: string }) {
  const color = pct === undefined ? "bg-faint" : pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-good";
  return (
    <div>
      <div className="mb-1 flex justify-between text-[12px]">
        <span className="text-dim">{label}</span>
        <span>{value}{pct !== undefined && <span className={"ml-2 " + (pct >= 80 ? "text-warn" : "text-faint")}>{pct}%</span>}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-line"><div className={"h-full " + color} style={{ width: Math.min(100, pct ?? 0) + "%" }} /></div>
      {note && <div className="mt-0.5 text-[11px] text-faint">{note}</div>}
    </div>
  );
}

export function Usage() {
  const [range, setRange] = useState<"day" | "month" | "all">("month");
  const { data: d } = useFetch<any>("/api/usage?range=" + range, [range], 8000);
  if (!d) return <div className="p-6 text-dim">Loading…</div>;
  const days: string[] = [...new Set<string>(d.days.map((x: any) => x.d))];
  const provs: string[] = [...new Set<string>(d.days.map((x: any) => x.provider))];
  const colors = ["#7c9cff", "#b48cff", "#4ade80", "#fbbf24", "#f87171", "#38bdf8", "#fb923c"];
  const maxDay = Math.max(1, ...days.map((day) => d.days.filter((x: any) => x.d === day).reduce((n: number, x: any) => n + x.n, 0)));
  const c = d.comparison;
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Usage</h1>
          <div className="ml-auto flex gap-1">
            {(["day", "month", "all"] as const).map((r) => (
              <button key={r} className={"btn !py-1 " + (range === r ? "btn-primary" : "btn-ghost")} onClick={() => setRange(r)}>{r === "day" ? "Today" : r === "month" ? "This month" : "All time"}</button>
            ))}
          </div>
        </div>

        {d.budget.enabled && (
          <section className={"card p-4 " + (d.budget.exceeded ? "!border-bad/60" : d.budget.warn ? "!border-warn/60" : "")}>
            <Meter label="Paid spend this month" value={money(d.budget.spent) + " of " + money(d.budget.cap)} pct={d.budget.pct} />
            {d.budget.exceeded ? (
              <p className="mt-2 text-[13px] text-bad">Budget reached: paid models are switched off and everything routes to free cloud and local models until next month (or raise MONTHLY_BUDGET_USD).</p>
            ) : d.budget.warn ? (
              <p className="mt-2 text-[13px] text-warn">Over 80% of your monthly cap. At 100% OpenMax automatically falls back to free and local models.</p>
            ) : null}
          </section>
        )}

        <section className="grid gap-4 md:grid-cols-2">
          <div className="card space-y-3 p-4">
            <div className="label">Free-tier daily caps (today)</div>
            {d.freeCaps.map((f: any) => (
              <div key={f.provider} className="space-y-1.5">
                <div className="text-[13px] font-medium">{f.provider} {f.warn && <span className="chip !text-warn">{f.exceeded ? "cap reached" : "near cap"}</span>}</div>
                <Meter label="requests" value={f.requestsToday + (f.caps.requestsPerDay ? " / " + f.caps.requestsPerDay : "")} pct={f.requestPct} />
                <Meter label="tokens" value={num(f.tokensToday) + (f.caps.tokensPerDay ? " / " + num(f.caps.tokensPerDay) : "")} pct={f.tokenPct} />
              </div>
            ))}
            <p className="text-[11px] text-faint">Caps are approximate defaults from data/prices.json. Provider limits change; check each dashboard.</p>
          </div>
          <div className="card space-y-3 p-4">
            <div className="label">Local compute</div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div><div className="text-xl font-semibold">{d.local.gpuHours}</div><div className="text-[11px] text-faint">GPU hours</div></div>
              <div><div className="text-xl font-semibold">{money(d.local.electricityUsd)}</div><div className="text-[11px] text-faint">electricity</div></div>
              <div><div className="text-xl font-semibold">{d.local.watts} W</div><div className="text-[11px] text-faint">@ ${d.local.usdPerKwh}/kWh</div></div>
            </div>
            <p className="text-[11px] text-faint">Ollama generation time plus ComfyUI jobs × GPU_WATTS × USD_PER_KWH. An estimate, not a measurement.</p>
            <div className="label pt-2">Requests per day (14 days)</div>
            <div className="flex h-24 items-end gap-1">
              {days.map((day) => (
                <div key={day} className="flex max-w-[28px] flex-1 flex-col-reverse" title={day}>
                  {provs.map((p, i) => {
                    const n = d.days.find((x: any) => x.d === day && x.provider === p)?.n ?? 0;
                    return n ? <div key={p} style={{ height: (n / maxDay) * 96 + "px", background: colors[i % colors.length] }} title={p + ": " + n} /> : null;
                  })}
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 text-[11px] text-dim">
              {provs.map((p, i) => <span key={p}><span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: colors[i % colors.length] }} />{p}</span>)}
            </div>
          </div>
        </section>

        <section className="card overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-faint"><tr>{["Provider", "Model", "Requests", "Tokens in", "Tokens out", "tok/s", "429s", "Cost"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {d.models.map((m: any) => (
                <tr key={m.provider + m.model} className="border-t border-line">
                  <td className="px-3 py-1.5">{m.provider}{m.local && <span className="chip ml-1">local</span>}</td>
                  <td className="px-3 font-mono text-[12px]">{m.model}</td>
                  <td className="px-3">{m.requests}</td><td className="px-3">{num(m.tokensIn)}</td><td className="px-3">{num(m.tokensOut)}</td>
                  <td className="px-3">{m.tps || "—"}</td><td className="px-3">{m.r429 || "—"}</td><td className="px-3">{m.costUsd ? money(m.costUsd) : "free"}</td>
                </tr>
              ))}
              {d.models.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-dim">No usage recorded in this range yet.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="card p-4">
          <div className="label mb-2">What you would pay for subscriptions vs what you spend</div>
          <div className="grid gap-4 md:grid-cols-3">
            <div><div className="text-3xl font-semibold text-good">{money(Math.max(0, c.savedMonthly))}</div><div className="text-[12px] text-dim">saved per month</div></div>
            <div><div className="text-xl font-semibold">{money(c.actualMonthly)}</div><div className="text-[12px] text-dim">your actual month: {money(c.paidSpendMonthly)} paid APIs + {money(c.electricityMonthly)} electricity</div></div>
            <div><div className="text-xl font-semibold">{money(c.subscriptionsMonthly)}</div><div className="text-[12px] text-dim">the {c.subscriptions.length} top-tier plans combined</div></div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">{c.subscriptions.map((s: any) => <span key={s.name} className="chip">{s.name} ${s.monthly}</span>)}</div>
          <p className="mt-2 text-[11px] text-faint">{c.note} OpenMax is not a drop-in replacement for every feature of those products; see the README's "what to expect".</p>
        </section>
      </div>
    </div>
  );
}
