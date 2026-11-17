import type { FastifyInstance } from "fastify";
import { cfg } from "../config.js";
import { allProviders, providerEnabled, visibleProviders } from "../providers/registry.js";
import { snapshot } from "../providers/limits.js";
import { discoverAll, pingAll, getRefStatuses, getCatalog, suggestLanes } from "../providers/discovery.js";
import { searchStatus } from "../modules/search.js";
import { detectHardware, loadedLocalModels, tierFor } from "../hardware.js";
import { getMcpStatuses } from "../modules/mcpState.js";
import { getRouterConfig } from "../router/config.js";
import { mediaStatus } from "../modules/mediaStatus.js";

let lastTest: { at: number; providers: unknown; refs: unknown } | undefined;

export async function healthPayload() {
  const providers = visibleProviders().map((p) => {
    const s = snapshot(p.id);
    return {
      id: p.id, label: p.label, paid: p.paid, local: p.local, enabled: providerEnabled(p), hasKey: p.local || p.apiKey().length > 0,
      cooldownSec: s.cooldownSec, count429: s.count429, models: (getCatalog()[p.id] ?? []).length, fix: providerEnabled(p) ? undefined : p.fixHint,
    };
  });
  const [search, local, media] = await Promise.all([searchStatus(), loadedLocalModels(), mediaStatus()]);
  const hw = detectHardware();
  return {
    ok: true, version: "0.1.0", stub: cfg.OPENMAX_STUB, paidEnabled: cfg.ENABLE_PAID, freeCloud: cfg.ALLOW_FREE_CLOUD,
    providers, search, media, gpu: hw.gpu, hardware: { ...hw, recommended: tierFor(hw.memoryGb) },
    localModels: local, mcp: getMcpStatuses(), lastTest: lastTest?.at ?? null,
    lanes: Object.keys(getRouterConfig().lanes).length,
  };
}

export function registerHealth(app: FastifyInstance) {
  app.get("/api/health", async () => healthPayload());
  app.post("/api/providers/test", async () => {
    const providers = await discoverAll();
    const refs = await pingAll();
    lastTest = { at: Date.now(), providers, refs };
    return { providers, refs, suggestions: suggestLanes(), statuses: getRefStatuses() };
  });
  app.get("/api/providers/models", async () => ({ catalog: getCatalog(), statuses: getRefStatuses(), all: allProviders().map((p) => p.id) }));
}
