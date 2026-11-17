import { api } from "./api";

export class Recorder {
  private rec?: MediaRecorder; private chunks: Blob[] = []; private stream?: MediaStream;
  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = []; this.rec = new MediaRecorder(this.stream);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start();
  }
  stop(): Promise<Blob> {
    return new Promise((res) => {
      if (!this.rec) return res(new Blob());
      this.rec.onstop = () => { this.stream?.getTracks().forEach((t) => t.stop()); res(new Blob(this.chunks, { type: this.rec!.mimeType || "audio/webm" })); };
      this.rec.stop();
    });
  }
}
export async function transcribeBlob(b: Blob): Promise<string> {
  const f = new FormData(); f.append("file", b, "speech.webm");
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
