import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { freshEnv } from "./helpers.js";
import { wavTone } from "./fake.js";
import { chunkPcm, rivaTranscribe, toWav16k } from "../src/modules/riva.js";
import { parseWav, toPcm16kMono, wavBuffer } from "../src/modules/wav.js";
import { sttBackend, transcribe } from "../src/modules/speech.js";

// A local gRPC server speaking the real Riva ASR protocol (fixture; shipped code talks to NVIDIA unless NVIDIA_ASR_ENDPOINT points elsewhere).
const calls: { metadata: Record<string, string>; encoding: number; rate: number; lang: string; bytes: number }[] = [];
let failWith: grpc.status | undefined; let server: grpc.Server; let port = 0;
beforeAll(async () => {
  const def = protoLoader.loadSync(path.join(__dirname, "..", "proto", "riva_asr_min.proto"), { keepCase: true, enums: Number, longs: Number, defaults: true });
  const pkg = grpc.loadPackageDefinition(def) as any;
  server = new grpc.Server();
  server.addService(pkg.nvidia.riva.asr.RivaSpeechRecognition.service, {
    Recognize: (call: any, cb: any) => {
      const md = call.metadata.getMap() as Record<string, string>;
      calls.push({ metadata: md, encoding: call.request.config.encoding, rate: call.request.config.sample_rate_hertz, lang: call.request.config.language_code, bytes: call.request.audio.length });
      if (failWith !== undefined) return cb({ code: failWith, details: "denied" });
      cb(null, { results: [{ alternatives: [{ transcript: `piece of ${call.request.audio.length} bytes`, confidence: 0.9 }] }] });
    },
  });
  port = await new Promise<number>((res, rej) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (e, p) => (e ? rej(e) : res(p))));
});
afterAll(() => { server.forceShutdown(); });
beforeEach(() => { calls.length = 0; failWith = undefined; freshEnv({ GROQ_API_KEY: "", NVIDIA_ASR_ENDPOINT: `127.0.0.1:${port}`, NVIDIA_ASR_INSECURE: true, NVIDIA_ASR_FUNCTION_ID: "" }); });

describe("WAV conversion for speech recognition (pure JS)", () => {
  it("downmixes and resamples any PCM WAV to 16 kHz mono 16-bit", () => {
    const w = parseWav(wavTone(1, 24000)); const pcm = toPcm16kMono(w);
    expect(pcm.length).toBe(16000 * 2);
    const stereo8 = wavBuffer({ rate: 8000, channels: 2, bits: 8, data: Buffer.alloc(8000 * 2, 200) }); // 1 s of stereo 8-bit
    expect(toPcm16kMono(parseWav(stereo8)).length).toBe(16000 * 2);
    expect(parseWav(wavBuffer({ rate: 16000, channels: 1, bits: 16, data: Buffer.alloc(100) })).rate).toBe(16000);
    expect(() => parseWav(Buffer.from("not a wav file at all, really"))).toThrow(/not a WAV/);
  });
  it("chunks long audio into pieces under the unary request limit", () => {
    const pcm = Buffer.alloc(16000 * 2 * 125); const parts = chunkPcm(pcm, 50);
    expect(parts.map((p) => p.length / 32000)).toEqual([50, 50, 25]); expect(chunkPcm(Buffer.alloc(10)).length).toBe(1);
  });
  it("undecodable audio gets a fix-it message", async () => {
    await expect(toWav16k(Buffer.from("garbage bytes that are not audio"), "x.webm", "audio/webm")).rejects.toMatchObject({ fix: expect.stringContaining("WAV") });
  });
});

describe("NVIDIA Riva speech-to-text over gRPC", () => {
  it("sends 16 kHz LINEAR_PCM with the function id and bearer key, and returns the transcript", async () => {
    const text = await rivaTranscribe(wavTone(1, 24000), "a.wav", "audio/wav");
    expect(text).toBe(`piece of ${16000 * 2} bytes`);
    const c = calls[0]!; expect(c.encoding).toBe(1); expect(c.rate).toBe(16000); expect(c.lang).toBe("en-US");
    expect(c.metadata["function-id"]).toBe("1598d209-5e27-4d3c-8079-4751568b1081"); expect(c.metadata.authorization).toBe("Bearer k");
  });
  it("splits long recordings into several calls and joins the transcripts", async () => {
    const long = wavBuffer({ rate: 16000, channels: 1, bits: 16, data: Buffer.alloc(16000 * 2 * 120) });
    const text = await rivaTranscribe(long, "long.wav", "audio/wav");
    expect(calls).toHaveLength(3); expect(text.split("piece of").length - 1).toBe(3);
  });
  it("a rejected key is reported clearly with how to fix it", async () => {
    failWith = grpc.status.UNAUTHENTICATED;
    await expect(rivaTranscribe(wavTone(0.5), "a.wav", "audio/wav")).rejects.toMatchObject({ message: expect.stringMatching(/rejected the API key/), fix: expect.stringContaining("NVIDIA_API_KEY") });
  });
  it("speech.transcribe uses Riva when no Whisper backend exists, and reports it as the STT backend", async () => {
    expect(await sttBackend()).toBe("nvidia-riva");
    const r = await transcribe(wavTone(0.5), "x.wav", "audio/wav"); expect(r.backend).toBe("nvidia-riva"); expect(r.text).toMatch(/piece of/);
  });
  it("with no key at all, transcription explains every way to enable it", async () => {
    freshEnv({ GROQ_API_KEY: "", NVIDIA_API_KEY: "" });
    expect(await sttBackend()).toBeNull();
    await expect(transcribe(wavTone(0.5), "x.wav", "audio/wav")).rejects.toMatchObject({ fix: expect.stringMatching(/NVIDIA_API_KEY.*GROQ_API_KEY.*whisper/i) });
  });
  it("Groq hosted Whisper still takes precedence when a Groq key exists", async () => {
    freshEnv({ GROQ_API_KEY: "k", NVIDIA_ASR_ENDPOINT: `127.0.0.1:${port}`, NVIDIA_ASR_INSECURE: true });
    const r = await transcribe(wavTone(0.5), "x.wav", "audio/wav"); expect(r.text).toBe("this is a transcript"); expect(calls).toHaveLength(0);
  });
});
