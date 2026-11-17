import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cfg } from "../config.js";
import { getRouterConfig } from "../router/config.js";
import { splitRef } from "../providers/types.js";
import { getProvider, providerEnabled } from "../providers/registry.js";
import { recordUsage } from "../router/usage.js";
import { rivaConfigured, rivaTranscribe } from "./riva.js";

const exec = promisify(execFile);
const tmp = (ext: string) => path.join(os.tmpdir(), `om-${Date.now()}-${Math.random().toString(36).slice(2, 7)}${ext}`);
const has = async (bin: string) => { try { await exec("which", [bin]); return true; } catch { return false; } };

// ───────── Speech to text ─────────
export async function transcribe(buf: Buffer, filename = "audio.webm", mime = "audio/webm"): Promise<{ text: string; backend: string }> {
  if (cfg.WHISPER_MODEL && (await has(cfg.WHISPER_BIN))) {
    const inp = tmp(path.extname(filename) || ".webm"), wav = tmp(".wav");
    fs.writeFileSync(inp, buf);
    try {
      await exec("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, "-ar", "16000", "-ac", "1", wav]);
      const { stdout } = await exec(cfg.WHISPER_BIN, ["-m", cfg.WHISPER_MODEL, "-f", wav, "-nt", "-np"], { timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
      return { text: stdout.trim(), backend: "whisper.cpp" };
    } finally { fs.rmSync(inp, { force: true }); fs.rmSync(wav, { force: true }); }
  }
  const sttRef = getRouterConfig().stt.find((r) => { const p = getProvider(splitRef(r).provider); return p && providerEnabled(p); });
  if (sttRef) {
    const { provider, model } = splitRef(sttRef);
    const p = getProvider(provider)!;
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(buf)], { type: mime }), filename);
    form.append("model", model); form.append("response_format", "json");
    const t0 = Date.now();
    const r = await fetch(`${p.baseUrl()}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${p.apiKey()}` }, body: form, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`${p.label} transcription failed (${r.status}). ${r.status === 401 ? p.fixHint : ""}`);
    const j: any = await r.json();
    recordUsage({ ref: sttRef, tokensIn: 0, tokensOut: 0, ms: Date.now() - t0, kind: "stt" });
    return { text: String(j.text ?? "").trim(), backend: sttRef };
  }
  if (rivaConfigured()) {
    const t0 = Date.now();
    const text = await rivaTranscribe(buf, filename, mime);
    recordUsage({ ref: "nvidia:riva-parakeet", tokensIn: 0, tokensOut: 0, ms: Date.now() - t0, kind: "stt" });
    return { text, backend: "nvidia-riva" };
  }
  throw Object.assign(new Error("No speech-to-text backend is configured."), { fix: "Set NVIDIA_API_KEY (hosted Riva/Parakeet) or GROQ_API_KEY (hosted Whisper), or WHISPER_MODEL + WHISPER_BIN (whisper.cpp)." });
}

// ───────── Text to speech ─────────
export type TtsBackend = "kokoro" | "piper" | "say" | "none";
export async function ttsBackend(): Promise<TtsBackend> {
  const want = cfg.TTS_BACKEND;
  if (want !== "auto") return want as TtsBackend;
  try { const r = await fetch(`${cfg.KOKORO_URL.replace(/\/v1$/, "")}/health`, { signal: AbortSignal.timeout(800) }); if (r.ok || r.status === 404) return "kokoro"; } catch { /* not running */ }
  if (cfg.PIPER_MODEL && (await has(cfg.PIPER_BIN))) return "piper";
  if (process.platform === "darwin" && (await has("say"))) return "say";
  return "none";
}
export const VOICES = { host_a: { kokoro: "af_heart", say: "Samantha" }, host_b: { kokoro: "am_michael", say: "Daniel" } };

export async function synthesize(text: string, voice: "host_a" | "host_b" = "host_a"): Promise<{ audio: Buffer; mime: string; backend: TtsBackend }> {
  const clean = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim().slice(0, 4000);
  const backend = await ttsBackend();
  if (backend === "kokoro") {
    const r = await fetch(`${cfg.KOKORO_URL}/audio/speech`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "kokoro", input: clean, voice: VOICES[voice].kokoro, response_format: "mp3" }), signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`Kokoro returned ${r.status}.`);
    return { audio: Buffer.from(await r.arrayBuffer()), mime: "audio/mpeg", backend };
  }
  if (backend === "piper") {
    const out = tmp(".wav");
    await new Promise<void>((res, rej) => { const c = spawn(cfg.PIPER_BIN, ["--model", cfg.PIPER_MODEL, "--output_file", out]); c.on("error", rej); c.on("close", (code) => (code === 0 ? res() : rej(new Error(`piper exited ${code}`)))); c.stdin.end(clean); });
    const audio = fs.readFileSync(out); fs.rmSync(out, { force: true });
    return { audio, mime: "audio/wav", backend };
  }
  if (backend === "say") {
    const wav = tmp(".wav");
    await exec("say", ["-v", VOICES[voice].say, "-o", wav, "--data-format=LEI16@24000", clean]);
    const audio = fs.readFileSync(wav); fs.rmSync(wav, { force: true });
    return { audio, mime: "audio/wav", backend };
  }
  throw Object.assign(new Error("No text-to-speech engine is available."), { fix: "On macOS the built-in `say` voice works automatically. Elsewhere install Piper (set PIPER_BIN and PIPER_MODEL) or run a Kokoro server (KOKORO_URL)." });
}

export async function sttBackend(): Promise<string | null> {
  if (cfg.WHISPER_MODEL && (await has(cfg.WHISPER_BIN))) return "whisper.cpp";
  const g = getRouterConfig().stt.find((r) => { const p = getProvider(splitRef(r).provider); return p && providerEnabled(p); });
  if (g) return g;
  return rivaConfigured() ? "nvidia-riva" : null;
}
