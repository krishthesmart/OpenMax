/** Minimal PCM WAV tools (no ffmpeg needed). */
export interface Wav { rate: number; channels: number; bits: number; data: Buffer }

export function parseWav(buf: Buffer): Wav {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, fmt: { rate: number; channels: number; bits: number; tag: number } | undefined, data: Buffer | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString("latin1", off, off + 4); let size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { tag: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") { if (off + 8 + size > buf.length) size = buf.length - off - 8; data = buf.subarray(off + 8, off + 8 + size); }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("malformed WAV");
  if (fmt.tag !== 1 && fmt.tag !== 0xfffe) throw new Error("only PCM WAV is supported");
  return { rate: fmt.rate, channels: fmt.channels, bits: fmt.bits, data };
}

export function wavBuffer(w: Wav): Buffer {
  const h = Buffer.alloc(44), br = w.rate * w.channels * (w.bits / 8);
  h.write("RIFF", 0); h.writeUInt32LE(36 + w.data.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(w.channels, 22);
  h.writeUInt32LE(w.rate, 24); h.writeUInt32LE(br, 28); h.writeUInt16LE(w.channels * (w.bits / 8), 32); h.writeUInt16LE(w.bits, 34); h.write("data", 36); h.writeUInt32LE(w.data.length, 40);
  return Buffer.concat([h, w.data]);
}

export function wavConcat(parts: Wav[]): { buffer: Buffer; durations: number[] } {
  const f = parts[0]!;
  for (const p of parts) if (p.rate !== f.rate || p.channels !== f.channels || p.bits !== f.bits) throw new Error("audio pieces have different formats and ffmpeg is not available to convert them");
  const br = f.rate * f.channels * (f.bits / 8);
  return { buffer: wavBuffer({ ...f, data: Buffer.concat(parts.map((p) => p.data)) }), durations: parts.map((p) => p.data.length / br) };
}

/** Any PCM WAV (8/16/24/32-bit, any rate/channels) → 16 kHz mono signed 16-bit samples (downmix + linear resample). */
export function toPcm16kMono(w: Wav): Buffer {
  const bytes = w.bits / 8, frames = Math.floor(w.data.length / (bytes * w.channels));
  const sample = (i: number, ch: number): number => {
    const o = (i * w.channels + ch) * bytes;
    if (w.bits === 16) return w.data.readInt16LE(o) / 32768;
    if (w.bits === 8) return (w.data[o]! - 128) / 128;
    if (w.bits === 24) return w.data.readIntLE(o, 3) / 8388608;
    if (w.bits === 32) return w.data.readInt32LE(o) / 2147483648;
    throw new Error(`unsupported WAV bit depth ${w.bits}`);
  };
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) { let a = 0; for (let c = 0; c < w.channels; c++) a += sample(i, c); mono[i] = a / w.channels; }
  const outLen = Math.floor((frames * 16000) / w.rate), out = Buffer.alloc(outLen * 2), ratio = w.rate / 16000;
  for (let i = 0; i < outLen; i++) {
    const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(frames - 1, i0 + 1), f = p - i0;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((mono[i0]! * (1 - f) + mono[i1]! * f) * 32767))), i * 2);
  }
  return out;
}
