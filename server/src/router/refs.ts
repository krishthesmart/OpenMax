import { complete, type LLMResult } from "../providers/llm.js";
import { getProvider, providerEnabled } from "../providers/registry.js";
import { cooldownRemaining } from "../providers/limits.js";
import { splitRef, type LLMRequest } from "../providers/types.js";
import { recordUsage } from "./usage.js";

/** Try an explicit ordered ref list (titles, judge, classifier-style roles). Honors local-only and cooldowns. */
export async function completeWithRefs(refs: string[], req: Omit<LLMRequest, "model">, opts: { localOnly?: boolean; purpose?: string } = {}): Promise<LLMResult & { ref: string }> {
  let last: unknown;
  for (const ref of refs) {
    const p = getProvider(splitRef(ref).provider);
    if (!p || !providerEnabled(p) || (opts.localOnly && !p.local) || cooldownRemaining(p.id) > 0) continue;
    try {
      const r = await complete({ ...req, model: ref });
      recordUsage({ ref, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ms: r.ms, kind: opts.purpose ?? "aux" });
      return { ...r, ref };
    } catch (e: any) { if (e?.name === "AbortError") throw e; last = e; }
  }
  throw last instanceof Error ? last : new Error("No model available for this step. Add a provider key or start Ollama.");
}
