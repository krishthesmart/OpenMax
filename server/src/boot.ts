import { discoverAll, pingAll } from "./providers/discovery.js";
import { cfg } from "./config.js";
import { markInterruptedJobs } from "./modules/media/index.js";
import { markInterruptedRuns } from "./modules/agent/agent.js";
import { syncSchedules } from "./modules/agent/scheduler.js";

export async function bootTasks() {
  markInterruptedJobs();
  markInterruptedRuns();
  syncSchedules();
  if (cfg.OPENMAX_STUB) return;
  const providers = await discoverAll();
  const live = providers.filter((p) => p.ok).map((p) => `${p.provider}(${p.models})`).join(" ") || "none";
  console.log(`providers: ${live}`);
  pingAll().then((r) => console.log(`pinged ${r.length} refs, ${r.filter((x) => x.ok).length} alive`)).catch(() => {});
}
