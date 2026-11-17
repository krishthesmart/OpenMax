import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDb } from "../src/db.js";
import { setConfigForTest } from "../src/config.js";
import { overrideRouterConfigForTest, RouterConfigSchema } from "../src/router/config.js";
import { resetLimits } from "../src/providers/limits.js";
import { stubReset } from "./fake.js";

export const testRouterConfig = () => RouterConfigSchema.parse({
  classifier: ["groq:fast", "ollama:small"], judge: ["google:judge"], titles: ["groq:fast"], embeddings: ["nvidia:emb"], stt: ["groq:whisper"], toolProbe: ["nvidia:tooly"],
  lanes: {
    quick: ["groq:fast", "ollama:small"], code: ["openrouter:coder:free", "nvidia:big", "groq:large", "ollama:small"],
    reasoning: ["nvidia:big", "google:flash", "ollama:small"], research: ["google:flash", "nvidia:big"],
    "long-context": ["google:flash", "ollama:small"], vision: ["google:flash", "ollama:vision"], multimodal: ["google:flash", "ollama:vision"],
    realtime: ["google:flash", "groq:large"], creative: ["openrouter:muse:free", "google:flash"], agentic: ["nvidia:tooly", "google:flash"],
  },
  paidLanes: { code: ["anthropic:opus"], realtime: ["xai:grok"] },
  think: { candidates: ["nvidia:big", "google:flash", "openrouter:coder:free"], shortExtra: ["groq:large"], paidExtra: ["anthropic:opus"] },
  localDefault: "ollama:small",
});

const dirs: string[] = [];
process.on("exit", () => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** Fresh in-memory DB + stub providers. File output (uploads, media…) goes to a throwaway temp dir, never into the repo. */
export function freshEnv(over: Record<string, unknown> = {}) {
  closeDb(); resetLimits(); stubReset();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "om-test-data-")); dirs.push(data);
  setConfigForTest({ DATA_DIR: data, MEDIA_PROVIDER: "comfy", SEARCH_BACKEND: "searxng", NVIDIA_API_KEY: "k", GEMINI_API_KEY: "k", OPENROUTER_API_KEY: "k", GROQ_API_KEY: "k", ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", XAI_API_KEY: "k", GEMINI_PAID_API_KEY: "k", DEEPSEEK_API_KEY: "k", META_API_KEY: "k", ...over });
  openDb(":memory:");
  overrideRouterConfigForTest(testRouterConfig());
}
