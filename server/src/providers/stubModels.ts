import type { DiscoveredModel } from "./discovery.js";
const mk = (id: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel => ({ id, kind: "chat", ...extra });
export const STUB_CATALOG: Record<string, DiscoveredModel[]> = {};
export function listStubModels(provider: string): DiscoveredModel[] {
  return STUB_CATALOG[provider] ?? [mk("stub-model", { ctx: 128000, vision: true, tools: true })];
}
