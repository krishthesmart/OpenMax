import { closeDb, openDb } from "../src/db.js";
import { setConfigForTest } from "../src/config.js";
import { overrideRouterConfigForTest, RouterConfigSchema } from "../src/router/config.js";
import { resetLimits } from "../src/providers/limits.js";
import { stubReset } from "../src/providers/stub.js";

export const testRouterConfig = () => RouterConfigSchema.parse({
  classifier: ["groq:fast", "ollama:small"], judge: ["google:judge"], titles: ["groq:fast"], embeddings: ["nvidia:emb"], toolProbe: ["nvidia:tooly"],
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

export function freshEnv(over: Record<string, unknown> = {}) {
  closeDb(); resetLimits(); stubReset();
  setConfigForTest({ OPENMAX_STUB: true, DATA_DIR: ":memory:", NVIDIA_API_KEY: "k", GEMINI_API_KEY: "k", OPENROUTER_API_KEY: "k", GROQ_API_KEY: "k", ...over });
  openDb(":memory:");
  overrideRouterConfigForTest(testRouterConfig());
}
