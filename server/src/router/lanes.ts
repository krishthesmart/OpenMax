import { cfg } from "../config.js";
import { getProvider, providerEnabled, refAllowed } from "../providers/registry.js";
import { cooldownRemaining } from "../providers/limits.js";
import { splitRef } from "../providers/types.js";
import { getRouterConfig, type Task } from "./config.js";
import { paidAllowed } from "./usage.js";
import { getCatalogFor, getRefStatuses } from "../providers/discovery.js";

export interface Candidate { ref: string; provider: string; tier: "paid" | "free" | "local"; note?: string }
export interface Selection { candidates: Candidate[]; skipped: { ref: string; reason: string }[]; lane: string[] }
export interface SelectInput { task: Task; mode: string; localOnly?: boolean; exclude?: string[]; forceRef?: string; preferTools?: boolean }

const tierOf = (provider: string): Candidate["tier"] => { const p = getProvider(provider); return p?.local ? "local" : p?.paid ? "paid" : "free"; };
const dedupe = (a: string[]) => [...new Set(a)];

export function selectCandidates(input: SelectInput): Selection {
  const rc = getRouterConfig();
  const skipped: Selection["skipped"] = [];
  const mode = input.mode || "auto";
  const exclude = new Set(input.exclude ?? []);
  const statuses = (() => { try { return getRefStatuses(); } catch { return {}; } })();

  let refs: string[];
  const lane = rc.lanes[input.task] ?? rc.lanes.reasoning ?? [];
  if (input.forceRef) refs = [input.forceRef];
  else if (mode.startsWith("manual:")) refs = [mode.slice("manual:".length)];
  else {
    const paid = rc.paidLanes[input.task] ?? [];
    if (paid.length && !paidAllowed()) paid.forEach((r) => skipped.push({ ref: r, reason: cfg.ENABLE_PAID ? "monthly budget reached" : "paid providers disabled" }));
    refs = dedupe([...(paidAllowed() ? paid : []), ...lane]);
    if (input.preferTools) {
      const good = refs.filter((r) => statuses[r]?.tools === true);
      refs = [...good, ...refs.filter((r) => !good.includes(r))];
    }
    if (mode === "cost-saver") {
      refs = refs.filter((r) => { const t = tierOf(splitRef(r).provider); if (t === "paid") { skipped.push({ ref: r, reason: "cost-saver mode" }); return false; } return true; });
      if (input.task === "quick" || input.task === "creative") refs = [...refs.filter((r) => tierOf(splitRef(r).provider) === "local"), ...refs.filter((r) => tierOf(splitRef(r).provider) !== "local")];
    }
    // Ollama is the fallback for everything: every lane ends with the local default (text lanes only; a text model cannot see images).
    if (rc.localDefault && getCatalogFor("ollama").length > 0 && input.task !== "vision" && input.task !== "multimodal" && !refs.some((r) => tierOf(splitRef(r).provider) === "local")) refs = [...refs, rc.localDefault];
    if (mode === "local-first") {
      const local = refs.filter((r) => tierOf(splitRef(r).provider) === "local");
      refs = dedupe([...(local.length ? local : rc.localDefault ? [rc.localDefault] : []), ...refs]);
    }
  }

  if (input.localOnly) {
    const local = refs.filter((r) => tierOf(splitRef(r).provider) === "local");
    refs.filter((r) => !local.includes(r)).forEach((r) => skipped.push({ ref: r, reason: "privacy: local only" }));
    refs = local.length ? local : rc.localDefault ? [rc.localDefault] : [];
  }

  const ok: Candidate[] = [], dead: Candidate[] = [];
  for (const ref of refs) {
    const { provider, model } = splitRef(ref);
    const p = getProvider(provider);
    if (exclude.has(ref)) { skipped.push({ ref, reason: "excluded" }); continue; }
    if (!p) { skipped.push({ ref, reason: "unknown provider" }); continue; }
    if (!providerEnabled(p)) { skipped.push({ ref, reason: p.paid && !cfg.ENABLE_PAID ? "paid providers disabled" : p.local ? "Ollama not available" : "no API key" }); continue; }
    if (!refAllowed(provider, model)) { skipped.push({ ref, reason: "paid OpenRouter model" }); continue; }
    const c: Candidate = { ref, provider, tier: tierOf(provider) };
    if (statuses[ref]?.ok === false && !input.forceRef && !mode.startsWith("manual:")) { c.note = "failed last test"; dead.push(c); } else ok.push(c);
  }
  return { candidates: [...ok, ...dead], skipped, lane };
}

export const coolingNote = (provider: string) => { const s = cooldownRemaining(provider); return s > 0 ? `${provider} cooling down ${s}s` : undefined; };
