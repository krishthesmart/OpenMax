import { api } from "./api";

/** Records microphone audio as 16 kHz mono WAV (what speech-recognition services accept; browsers' default WebM/Opus is not). */
export class Recorder {
  private ctx?: AudioContext; private stream?: MediaStream; private node?: ScriptProcessorNode; private src?: MediaStreamAudioSourceNode; private chunks: Float32Array[] = [];
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.ctx = new AudioContext(); this.chunks = [];
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => { this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    this.src.connect(this.node); this.node.connect(this.ctx.destination);
  }
  async stop(): Promise<Blob> {
    const rate = this.ctx?.sampleRate ?? 48000;
    this.node?.disconnect(); this.src?.disconnect(); this.stream?.getTracks().forEach((t) => t.stop()); await this.ctx?.close();
    const total = this.chunks.reduce((n, c) => n + c.length, 0), all = new Float32Array(total); let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    const ratio = rate / 16000, outLen = Math.floor(total / ratio), pcm = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) { const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(total - 1, i0 + 1), f = p - i0; pcm[i] = Math.max(-32768, Math.min(32767, Math.round((all[i0]! * (1 - f) + all[i1]! * f) * 32767))); }
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf), w = (off: number, t: string) => [...t].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
    w(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: "audio/wav" });
  }
}
export async function transcribeBlob(b: Blob): Promise<string> {
  const f = new FormData(); f.append("file", b, "speech.wav");
  return (await api.upload("/api/stt", f)).text as string;
}

/** Speaks streamed text sentence by sentence; each sentence is synthesized as soon as it completes. */
export class Speaker {
  private buf = ""; private queue: Promise<string | null>[] = []; private playing = false; private stopped = false; private audio?: HTMLAudioElement;
  push(text: string) {
    this.buf += text;
    let m: RegExpExecArray | null;
    while ((m = /^([\s\S]*?[.!?]["')\]]?)(\s+|$)/.exec(this.buf)) && m[0].length < this.buf.length) { this.enqueue(m[1]!); this.buf = this.buf.slice(m[0].length); }
  }
  flush() { if (this.buf.trim()) this.enqueue(this.buf); this.buf = ""; }
  private enqueue(sentence: string) {
    const s = sentence.replace(/[*_`#>\[\]]/g, "").trim(); if (s.length < 2) return;
    const p = fetch("/api/tts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: s }) })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null);
    this.queue.push(p); void this.drain();
  }
  private async drain() {
    if (this.playing) return; this.playing = true;
    while (this.queue.length && !this.stopped) {
      const url = await this.queue.shift()!;
      if (!url || this.stopped) continue;
      await new Promise<void>((res) => { const a = new Audio(url); this.audio = a; a.onended = a.onerror = () => { URL.revokeObjectURL(url); res(); }; a.play().catch(() => res()); });
    }
    this.playing = false;
  }
  stop() { this.stopped = true; this.queue = []; this.audio?.pause(); }
}
