import fs from "node:fs";
import path from "node:path";
import { PRESETS } from "./presets.js";
import { OPS, type MediaBackend, type MediaOutput, type Op, type OpSupport, type RunCtx } from "./types.js";

function rng(seed: number) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const hash = (t: string) => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
function wrap(text: string, max: number): string[] { const out: string[] = []; let cur = ""; for (const w of text.split(/\s+/)) { if ((cur + " " + w).trim().length > max) { out.push(cur); cur = w; } else cur = (cur + " " + w).trim(); } if (cur) out.push(cur); return out.slice(0, 5); }

export function mockSvg(o: { prompt: string; seed: number; width: number; height: number; animated?: boolean; anim?: string; duration?: number; label?: string }): string {
  const { width: W, height: H } = o;
  const r = rng(hash(o.prompt) ^ o.seed);
  const hue = Math.floor(r() * 360), hue2 = (hue + 40 + Math.floor(r() * 120)) % 360;
  const dur = o.duration ?? 4;
  const shapes = Array.from({ length: 9 }, (_, i) => {
    const cx = r() * W, cy = r() * H, rad = (0.06 + r() * 0.2) * Math.min(W, H), op = 0.15 + r() * 0.35;
    const fill = `hsl(${(hue + i * 25) % 360} 70% ${45 + r() * 25}%)`;
    const drift = o.animated ? `<animateTransform attributeName="transform" type="translate" values="0 0;${(r() - 0.5) * 80} ${(r() - 0.5) * 80};0 0" dur="${dur}s" repeatCount="indefinite"/>` : "";
    return i % 3 === 0 ? `<rect x="${cx - rad}" y="${cy - rad}" width="${rad * 2}" height="${rad * 1.4}" rx="${rad * 0.2}" fill="${fill}" opacity="${op}">${drift}</rect>` : `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${fill}" opacity="${op}">${drift}</circle>`;
  }).join("");
  const motion: Record<string, string> = {
    "zoom-in": `<animateTransform attributeName="transform" type="scale" values="1;1.35;1" dur="${dur}s" repeatCount="indefinite" additive="sum"/>`,
    "zoom-out": `<animateTransform attributeName="transform" type="scale" values="1.35;1;1.35" dur="${dur}s" repeatCount="indefinite"/>`,
    "pan-left": `<animateTransform attributeName="transform" type="translate" values="${W * 0.08} 0;${-W * 0.08} 0;${W * 0.08} 0" dur="${dur}s" repeatCount="indefinite"/>`,
    "pan-right": `<animateTransform attributeName="transform" type="translate" values="${-W * 0.08} 0;${W * 0.08} 0;${-W * 0.08} 0" dur="${dur}s" repeatCount="indefinite"/>`,
    rise: `<animateTransform attributeName="transform" type="translate" values="0 ${H * 0.08};0 ${-H * 0.08};0 ${H * 0.08}" dur="${dur}s" repeatCount="indefinite"/>`,
    orbit: `<animateTransform attributeName="transform" type="rotate" values="-6 ${W / 2} ${H / 2};6 ${W / 2} ${H / 2};-6 ${W / 2} ${H / 2}" dur="${dur}s" repeatCount="indefinite"/>`,
    shake: `<animateTransform attributeName="transform" type="translate" values="0 0;3 -2;-2 3;2 2;0 0" dur="0.4s" repeatCount="indefinite"/>`,
  };
  const m = o.animated ? motion[o.anim ?? ""] ?? "" : "";
  const lines = wrap(o.prompt, Math.max(14, Math.floor(W / 22)));
  const fs = Math.max(14, Math.round(W / 34));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 22%)"/><stop offset="1" stop-color="hsl(${hue2} 65% 38%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/><g>${m}${shapes}</g>
<rect x="0" y="${H - fs * (lines.length + 2)}" width="${W}" height="${fs * (lines.length + 2)}" fill="#000" opacity="0.45"/>
${lines.map((l, i) => `<text x="${fs}" y="${H - fs * (lines.length - i + 0.2)}" font-family="system-ui,sans-serif" font-size="${fs}" fill="#fff">${esc(l)}</text>`).join("")}
<text x="${fs}" y="${fs * 1.6}" font-family="monospace" font-size="${Math.round(fs * 0.7)}" fill="#fff" opacity="0.7">${esc(o.label ?? "MOCK")} · seed ${o.seed}</text></svg>`;
}

export const mockBackend: MediaBackend = {
  id: "mock", label: "Mock (SVG placeholders)", gpu: false,
  async status() { return { ok: true, detail: "No GPU needed. Produces SVG placeholders so the whole Studio flow can be tried." }; },
  ops: () => Object.fromEntries(OPS.map((o) => [o, { supported: true } as OpSupport])) as Record<Op, OpSupport>,
  async run(ctx: RunCtx): Promise<MediaOutput[]> {
    const video = ctx.params.op !== "t2i" && ctx.params.op !== "edit";
    const anim = ctx.params.presets.map((id) => PRESETS.find((p) => p.id === id)?.anim).find((a) => a && a !== "static") ?? "zoom-in";
    const outs: MediaOutput[] = [];
    for (let i = 0; i < ctx.seeds.length; i++) {
      if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
      ctx.progress(i / ctx.seeds.length, `Rendering ${i + 1}/${ctx.seeds.length}`);
      const file = path.join(ctx.dir, `out-${i + 1}.svg`);
      fs.writeFileSync(file, mockSvg({ prompt: ctx.prompt, seed: ctx.seeds[i]!, width: ctx.width, height: ctx.height, animated: video, anim, duration: ctx.params.duration, label: `MOCK ${ctx.params.op}` }));
      outs.push({ file, mime: "image/svg+xml", kind: video ? "video" : "image", seed: ctx.seeds[i]! });
      await new Promise((r) => setTimeout(r, 15));
    }
    return outs;
  },
};
