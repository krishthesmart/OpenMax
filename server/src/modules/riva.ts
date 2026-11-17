/**
 * NVIDIA hosted speech recognition (Riva / Parakeet on build.nvidia.com) over gRPC, using the same NVIDIA_API_KEY.
 * Endpoint metadata: `function-id` + `authorization: Bearer <key>` on grpc.nvcf.nvidia.com:443.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { cfg } from "../config.js";
import { parseWav, toPcm16kMono, wavBuffer } from "./wav.js";

const exec = promisify(execFile);
const PROTO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "proto", "riva_asr_min.proto");
export const DEFAULT_PARAKEET_FUNCTION_ID = "1598d209-5e27-4d3c-8079-4751568b1081";
export const rivaConfigured = () => !!cfg.NVIDIA_API_KEY;

let client: any, clientKey = "";
function getClient() {
  const key = `${cfg.NVIDIA_ASR_ENDPOINT}|${cfg.NVIDIA_ASR_INSECURE}`;
  if (client && clientKey === key) return client;
  const def = protoLoader.loadSync(PROTO, { keepCase: true, enums: Number, longs: Number, defaults: true });
  const pkg = grpc.loadPackageDefinition(def) as any;
  client = new pkg.nvidia.riva.asr.RivaSpeechRecognition(cfg.NVIDIA_ASR_ENDPOINT, cfg.NVIDIA_ASR_INSECURE ? grpc.credentials.createInsecure() : grpc.credentials.createSsl());
  clientKey = key;
  return client;
}

/** Split 16 kHz mono PCM into pieces small enough for a unary Recognize call. */
export function chunkPcm(pcm: Buffer, seconds = 50): Buffer[] {
  const size = seconds * 16000 * 2, out: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += size) out.push(pcm.subarray(i, Math.min(pcm.length, i + size)));
  return out.length ? out : [pcm];
}

/** Accepts WAV directly (pure JS); other formats go through ffmpeg or macOS afconvert if present. */
export async function toWav16k(audio: Buffer, filename = "audio", mime = ""): Promise<Buffer> {
  try { return wavBuffer({ rate: 16000, channels: 1, bits: 16, data: toPcm16kMono(parseWav(audio)) }); } catch { /* not a (supported) WAV: convert */ }
  const inp = path.join(os.tmpdir(), `om-stt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${path.extname(filename) || ".bin"}`), out = `${inp}.wav`;
  fs.writeFileSync(inp, audio);
  try {
    try { await exec("ffmpeg", ["-y", "-loglevel", "error", "-i", inp, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out]); }
    catch { await exec("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", inp, out]); }
    return wavBuffer({ rate: 16000, channels: 1, bits: 16, data: toPcm16kMono(parseWav(fs.readFileSync(out))) });
  } catch {
    throw Object.assign(new Error(`Cannot decode ${mime || "this audio format"} for speech recognition.`), { fix: "Send WAV audio (the web recorder does), or install a working ffmpeg (brew install ffmpeg)." });
  } finally { fs.rmSync(inp, { force: true }); fs.rmSync(out, { force: true }); }
}

function recognize(pcm: Buffer, signal?: AbortSignal): Promise<string> {
  const md = new grpc.Metadata();
  md.set("function-id", cfg.NVIDIA_ASR_FUNCTION_ID || DEFAULT_PARAKEET_FUNCTION_ID);
  md.set("authorization", `Bearer ${cfg.NVIDIA_API_KEY}`);
  const req = { config: { encoding: 1, sample_rate_hertz: 16000, language_code: "en-US", max_alternatives: 1, enable_automatic_punctuation: true, audio_channel_count: 1 }, audio: pcm };
  return new Promise((resolve, reject) => {
    const call = getClient().Recognize(req, md, { deadline: Date.now() + 60_000 }, (err: grpc.ServiceError | null, res: any) => {
      if (err) {
        const code = grpc.status[err.code] ?? String(err.code);
        return reject(Object.assign(new Error(err.code === grpc.status.UNAUTHENTICATED || err.code === grpc.status.PERMISSION_DENIED ? "NVIDIA rejected the API key for speech recognition." : `NVIDIA speech recognition failed (${code}): ${String(err.details ?? "").slice(0, 160)}`), { fix: "Check NVIDIA_API_KEY, or set NVIDIA_ASR_FUNCTION_ID to a Riva ASR function id from build.nvidia.com." }));
      }
      resolve((res?.results ?? []).map((r: any) => r.alternatives?.[0]?.transcript ?? "").join(" ").trim());
    });
    signal?.addEventListener("abort", () => call.cancel(), { once: true });
  });
}

export async function rivaTranscribe(audio: Buffer, filename?: string, mime?: string, signal?: AbortSignal): Promise<string> {
  const wav = await toWav16k(audio, filename, mime);
  const pcm = parseWav(wav).data; const parts: string[] = [];
  for (const piece of chunkPcm(pcm)) parts.push(await recognize(piece, signal));
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
