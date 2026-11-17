import { config as loadDotenv } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.OPENMAX_ROOT ?? path.resolve(here, "..", "..");
let envFile = path.join(ROOT, ".env");
export const setEnvFileForTest = (f: string) => { envFile = f; };
loadDotenv({ path: envFile, quiet: true });

const bool = (d: boolean) =>
  z.preprocess((v) => (v === undefined || v === "" ? d : String(v).toLowerCase() === "true" || v === "1" || v === true), z.boolean());
const num = (d: number) => z.preprocess((v) => (v === undefined || v === "" ? d : Number(v)), z.number());
const str = (d = "") => z.preprocess((v) => (v === undefined ? d : String(v)), z.string());

const schema = z.object({
  PORT: num(8787),
  HOST: str("127.0.0.1"),
  DATA_DIR: str(path.join(ROOT, "data")),
  ALLOW_FREE_CLOUD: bool(true),
  ENABLE_PAID: bool(false),
  MEDIA_PROVIDER: str("auto"),
  GEMINI_NATIVE_URL: str("https://generativelanguage.googleapis.com/v1beta"),
  NVIDIA_BASE_URL: str("https://integrate.api.nvidia.com/v1"), GEMINI_BASE_URL: str("https://generativelanguage.googleapis.com/v1beta/openai"),
  OPENROUTER_BASE_URL: str("https://openrouter.ai/api/v1"), GROQ_BASE_URL: str("https://api.groq.com/openai/v1"),
  ANTHROPIC_BASE_URL: str("https://api.anthropic.com/v1"), OPENAI_BASE_URL: str("https://api.openai.com/v1"),
  XAI_BASE_URL: str("https://api.x.ai/v1"), DEEPSEEK_BASE_URL: str("https://api.deepseek.com/v1"),
  ALLOW_LOCAL_FETCH: bool(false), NVIDIA_GENAI_URL: str("https://ai.api.nvidia.com/v1/genai"),
  NVIDIA_ASR_ENDPOINT: str("grpc.nvcf.nvidia.com:443"), NVIDIA_ASR_FUNCTION_ID: str(""), NVIDIA_ASR_INSECURE: bool(false),
  NVIDIA_API_KEY: str(), GEMINI_API_KEY: str(), OPENROUTER_API_KEY: str(), GROQ_API_KEY: str(),
  ANTHROPIC_API_KEY: str(), OPENAI_API_KEY: str(), XAI_API_KEY: str(), GEMINI_PAID_API_KEY: str(),
  DEEPSEEK_API_KEY: str(), META_API_KEY: str(), META_BASE_URL: str("https://api.llama.com/compat/v1"),
  OLLAMA_URL: str("http://127.0.0.1:11434"),
  SEARCH_BACKEND: str("auto"), SEARXNG_URL: str("http://127.0.0.1:8080"), BRAVE_API_KEY: str(),
  COMFY_URL: str("http://127.0.0.1:8188"), FAL_KEY: str(),
  TTS_BACKEND: str("auto"), KOKORO_URL: str("http://127.0.0.1:8880/v1"), PIPER_BIN: str("piper"), PIPER_MODEL: str(),
  WHISPER_BIN: str("whisper-cli"), WHISPER_MODEL: str(),
  CODE_WORKSPACE: str(path.join(ROOT, "workspace")),
  AGENT_SANDBOX: str(path.join(ROOT, "data", "agent", "files")),
  MEMORYOS_URL: str(),
  MONTHLY_BUDGET_USD: num(20),
  GPU_WATTS: num(150), USD_PER_KWH: num(0.15),
  SMTP_HOST: str(), SMTP_PORT: num(587), SMTP_USER: str(), SMTP_PASS: str(), SMTP_FROM: str(),
  OPENMAX_PASSWORD: str(),
});
export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

/** Mutable singleton; wizard/Settings may update it and persist to .env. */
export let cfg: Config = loadConfig();
export function reloadConfig(): Config {
  loadDotenv({ path: envFile, override: true, quiet: true });
  cfg = loadConfig();
  return cfg;
}
export function setConfigForTest(over: Partial<Record<keyof Config, unknown>>) {
  cfg = loadConfig({ ...process.env, ...Object.fromEntries(Object.entries(over).map(([k, v]) => [k, String(v)])) });
  return cfg;
}

/** Persist KEY=value pairs into .env (keeps comments and other lines). */
export function writeEnv(updates: Record<string, string>) {
  const file = envFile;
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const seen = new Set<string>();
  const out = lines.map((l) => {
    const m = /^([A-Z0-9_]+)=/.exec(l);
    if (m && m[1] && m[1] in updates) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return l;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) out.push(`${k}=${v}`);
  fs.writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
  return reloadConfig();
}

export const dataPath = (...p: string[]) => path.join(cfg.DATA_DIR, ...p);
/** Reads JSON from DATA_DIR; if the file is missing there, falls back to the repo's shipped default in ./data. */
export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { /* try shipped default */ }
  try {
    const rel = path.relative(cfg.DATA_DIR, file);
    if (!rel.startsWith("..")) return JSON.parse(fs.readFileSync(path.join(ROOT, "data", rel), "utf8")) as T;
  } catch { /* fall through */ }
  return fallback;
}
