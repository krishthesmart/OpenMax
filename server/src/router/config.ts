import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataPath, readJson } from "../config.js";

export const TASKS = ["code", "reasoning", "research", "realtime", "creative", "vision", "multimodal", "long-context", "agentic", "quick"] as const;
export type Task = (typeof TASKS)[number];

const refs = z.array(z.string().regex(/^[a-z0-9]+:.+/i, "ref must look like provider:model"));
export const RouterConfigSchema = z.object({
  version: z.number().default(1),
  note: z.string().optional(),
  classifier: refs, judge: refs, titles: refs, embeddings: refs, stt: refs.default([]), toolProbe: refs,
  lanes: z.record(z.string(), refs),
  paidLanes: z.record(z.string(), refs).default({}),
  think: z.object({ candidates: refs, shortExtra: refs.default([]), paidExtra: refs.default([]) }),
  image: z.array(z.string()).default(["mock"]),
  localDefault: z.string(),
});
export type RouterConfig = z.infer<typeof RouterConfigSchema>;

const file = () => dataPath("router.json");
let cached: RouterConfig | undefined;

export function getRouterConfig(): RouterConfig {
  if (cached) return cached;
  cached = RouterConfigSchema.parse(readJson(file(), {}));
  return cached;
}
export function setRouterConfig(next: unknown): RouterConfig {
  const parsed = RouterConfigSchema.parse(next);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(parsed, null, 2) + "\n");
  cached = parsed;
  return parsed;
}
export function reloadRouterConfig() { cached = undefined; return getRouterConfig(); }
export function overrideRouterConfigForTest(c: RouterConfig | undefined) { cached = c; }

/** Every distinct ref mentioned anywhere in the config. */
export function allRefs(c: RouterConfig = getRouterConfig()): string[] {
  const set = new Set<string>();
  const add = (a?: string[]) => a?.forEach((r) => set.add(r));
  add(c.classifier); add(c.judge); add(c.titles); add(c.embeddings); add(c.toolProbe); add(c.stt);
  Object.values(c.lanes).forEach(add); Object.values(c.paidLanes).forEach(add);
  add(c.think.candidates); add(c.think.shortExtra); add(c.think.paidExtra);
  set.add(c.localDefault);
  return [...set];
}
