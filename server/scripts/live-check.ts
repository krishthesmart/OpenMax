/**
 * Live check: pings your REAL providers (the four free clouds + local Ollama, plus paid ones if ENABLE_PAID=true) using the keys in .env,
 * then prints which model refs are alive and which lane resolves to which model.
 *
 *   npm run live-check            (add --strict to exit non-zero when any lane cannot resolve)
 */
import { cfg } from "../src/config.js";
import { allProviders, providerEnabled } from "../src/providers/registry.js";
import { discoverAll, getCatalogFor, getRefStatuses, pingAll, suggestLanes } from "../src/providers/discovery.js";
import { getRouterConfig, TASKS } from "../src/router/config.js";
import { selectCandidates } from "../src/router/lanes.js";
import { thinkCandidates } from "../src/modules/think.js";
import { openDb } from "../src/db.js";

openDb();
const strict = process.argv.includes("--strict");
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`, green = (s: string) => `\x1b[32m${s}\x1b[0m`, red = (s: string) => `\x1b[31m${s}\x1b[0m`, yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

console.log(`OpenMax live check  (free cloud: ${cfg.ALLOW_FREE_CLOUD ? "on" : "off"}, paid: ${cfg.ENABLE_PAID ? "ON" : "off"})\n`);
console.log("Providers");
for (const p of allProviders().filter((x) => !x.paid || cfg.ENABLE_PAID)) console.log(`  ${providerEnabled(p) ? green("●") : dim("○")} ${p.label.padEnd(18)} ${providerEnabled(p) ? "" : dim(p.local ? "not running" : `no key (${p.keyEnv})`)}`);

console.log("\nDiscovering models…");
const disc = await discoverAll();
for (const d of disc) console.log(`  ${d.ok ? green("✓") : d.enabled ? red("✗") : dim("-")} ${d.label.padEnd(18)} ${d.ok ? `${d.models} models` : dim(d.error ?? "")}${!d.ok && d.enabled && d.fix ? "  " + yellow(d.fix) : ""}`);

console.log("\nPinging every ref in data/router.json (1 token each)…");
const pings = await pingAll();
const ok = pings.filter((p) => p.ok), dead = pings.filter((p) => !p.ok && !p.skipped), skipped = pings.filter((p) => p.skipped);
for (const p of pings.filter((x) => !x.skipped)) console.log(`  ${p.ok ? green("✓") : red("✗")} ${p.ref.padEnd(58)} ${p.ms ? dim(p.ms + "ms") : ""} ${p.tools ? green("tools") : ""} ${p.ok ? "" : dim((p.error ?? "").slice(0, 70))} ${p.ok && p.listed === false ? yellow("not in /models list") : ""}`);
console.log(dim(`  ${ok.length} alive, ${dead.length} dead, ${skipped.length} skipped (provider disabled)`));

console.log("\nLanes (first live candidate wins; paid flagships sit on top when enabled)");
const st = getRefStatuses(); let unresolved = 0;
for (const task of TASKS) {
  const sel = selectCandidates({ task, mode: "auto" });
  const live = sel.candidates.filter((c) => st[c.ref]?.ok !== false && (st[c.ref]?.ok || c.tier === "local") && st[c.ref]);
  const first = live[0];
  if (!first) unresolved++;
  console.log(`  ${first ? green("✓") : red("✗")} ${task.padEnd(13)} ${first ? first.ref : red("no live model")}${live.length > 1 ? dim(`   (+${live.length - 1} fallback${live.length > 2 ? "s" : ""})`) : ""}${!first && sel.skipped.length ? "\n      " + dim("skipped: " + sel.skipped.slice(0, 3).map((s) => `${s.ref} (${s.reason})`).join(", ")) : ""}`);
}

const rc = getRouterConfig();
const role = (label: string, refs: string[]) => { const first = refs.find((r) => st[r]?.ok); console.log(`  ${first ? green("✓") : red("✗")} ${label.padEnd(12)} ${first ?? red("none alive")}`); };
console.log("\nSupport roles");
role("classifier", rc.classifier); role("judge", rc.judge); role("titles", rc.titles); role("embeddings", rc.embeddings); role("speech-to-text", rc.stt);
const tools = Object.entries(st).filter(([, v]) => v.tools).map(([k]) => k);
console.log(`  ${tools.length ? green("✓") : yellow("!")} tool calling  ${tools.length ? tools.join(", ") : "no model verified (the Agent will use the JSON-action fallback)"}`);
const think = thinkCandidates({});
console.log(`  ${think.length >= 2 ? green("✓") : yellow("!")} think drafts  ${think.length} alive: ${think.join(", ") || "none"}`);

const sugg = suggestLanes();
if (Object.keys(sugg).length) { console.log("\nSuggested lane picks from your live catalog (not applied; confirm on the /router page)"); for (const [k, v] of Object.entries(sugg)) console.log(`  ${k.padEnd(13)} ${v.join(", ")}`); }
const lists = ["nvidia", "google", "openrouter", "groq", "ollama"].map((p) => `${p}:${getCatalogFor(p).length}`).join("  ");
console.log(dim(`\nCatalog sizes  ${lists}`));
console.log(`\n${TASKS.length - unresolved}/${TASKS.length} lanes resolve to a live model.${unresolved ? yellow(" Add keys in the setup wizard (Settings), start Ollama, or edit the lane on /router.") : ""}`);
console.log(dim("Model IDs and free-tier terms change; re-run this after editing data/router.json."));
process.exit(strict && unresolved ? 1 : 0);
