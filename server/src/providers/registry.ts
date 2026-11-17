import { cfg } from "../config.js";
import type { ProviderDef } from "./types.js";

const defs = (): ProviderDef[] => [
  { id: "nvidia", label: "NVIDIA", dialect: "openai", paid: false, local: false, baseUrl: () => "https://integrate.api.nvidia.com/v1", apiKey: () => cfg.NVIDIA_API_KEY, keyEnv: "NVIDIA_API_KEY", fixHint: "Get a free key at build.nvidia.com and set NVIDIA_API_KEY." },
  { id: "google", label: "Google AI Studio", dialect: "openai", paid: false, local: false, baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: () => cfg.GEMINI_API_KEY, keyEnv: "GEMINI_API_KEY", fixHint: "Get a free key at aistudio.google.com and set GEMINI_API_KEY." },
  { id: "openrouter", label: "OpenRouter", dialect: "openai", paid: false, local: false, baseUrl: () => "https://openrouter.ai/api/v1", apiKey: () => cfg.OPENROUTER_API_KEY, keyEnv: "OPENROUTER_API_KEY", fixHint: "Create a key at openrouter.ai/keys and set OPENROUTER_API_KEY." },
  { id: "groq", label: "Groq", dialect: "openai", paid: false, local: false, baseUrl: () => "https://api.groq.com/openai/v1", apiKey: () => cfg.GROQ_API_KEY, keyEnv: "GROQ_API_KEY", fixHint: "Create a free key at console.groq.com and set GROQ_API_KEY." },
  { id: "ollama", label: "Ollama (local)", dialect: "ollama", paid: false, local: true, baseUrl: () => cfg.OLLAMA_URL, apiKey: () => "", keyEnv: "", fixHint: "Install Ollama (ollama.com), run `ollama serve`, then pull a model." },
  { id: "anthropic", label: "Anthropic", dialect: "anthropic", paid: true, local: false, baseUrl: () => "https://api.anthropic.com/v1", apiKey: () => cfg.ANTHROPIC_API_KEY, keyEnv: "ANTHROPIC_API_KEY", fixHint: "Set ANTHROPIC_API_KEY and ENABLE_PAID=true." },
  { id: "openai", label: "OpenAI", dialect: "openai", paid: true, local: false, baseUrl: () => "https://api.openai.com/v1", apiKey: () => cfg.OPENAI_API_KEY, keyEnv: "OPENAI_API_KEY", fixHint: "Set OPENAI_API_KEY and ENABLE_PAID=true." },
  { id: "xai", label: "xAI (Grok)", dialect: "openai", paid: true, local: false, baseUrl: () => "https://api.x.ai/v1", apiKey: () => cfg.XAI_API_KEY, keyEnv: "XAI_API_KEY", fixHint: "Set XAI_API_KEY and ENABLE_PAID=true." },
  { id: "googlepaid", label: "Google (paid key)", dialect: "openai", paid: true, local: false, baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: () => cfg.GEMINI_PAID_API_KEY, keyEnv: "GEMINI_PAID_API_KEY", fixHint: "Set GEMINI_PAID_API_KEY (a billing-enabled key) and ENABLE_PAID=true." },
  { id: "deepseek", label: "DeepSeek", dialect: "openai", paid: true, local: false, baseUrl: () => "https://api.deepseek.com/v1", apiKey: () => cfg.DEEPSEEK_API_KEY, keyEnv: "DEEPSEEK_API_KEY", fixHint: "Set DEEPSEEK_API_KEY and ENABLE_PAID=true." },
  { id: "meta", label: "Meta (Muse)", dialect: "openai", paid: true, local: false, baseUrl: () => cfg.META_BASE_URL, apiKey: () => cfg.META_API_KEY, keyEnv: "META_API_KEY", fixHint: "Set META_API_KEY (and META_BASE_URL if different) and ENABLE_PAID=true." },
];

export const allProviders = () => defs();
export const getProvider = (id: string) => defs().find((p) => p.id === id);

/** Provider is usable: has a key (or is local/stub), and passes the free/paid gates. */
export function providerEnabled(p: ProviderDef): boolean {
  if (p.paid && !cfg.ENABLE_PAID) return false;
  if (!p.paid && !p.local && !cfg.ALLOW_FREE_CLOUD) return false;
  if (cfg.OPENMAX_STUB) return true;
  return p.local || p.apiKey().length > 0;
}
export const enabledProviders = () => defs().filter(providerEnabled);
export const visibleProviders = () => defs().filter((p) => !p.paid || cfg.ENABLE_PAID);

/** OpenRouter without ENABLE_PAID: only ":free" model ids are allowed. */
export function refAllowed(provider: string, model: string): boolean {
  if (provider === "openrouter" && !cfg.ENABLE_PAID) return model.endsWith(":free");
  return true;
}
