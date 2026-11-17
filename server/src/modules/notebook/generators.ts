import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as PptxNs from "pptxgenjs";
const PptxGenJS: any = (PptxNs as any).default?.default ?? (PptxNs as any).default ?? PptxNs;
import { dataPath } from "../../config.js";
import { getDb, now, uid } from "../../db.js";
import { routedComplete, routedJSON } from "../../router/router.js";
import { synthesize } from "../speech.js";
import { parseWav, wavConcat } from "../wav.js";
import { getNotebook, listSources } from "./notebook.js";

const exec = promisify(execFile);
export const GENERATORS = ["study_guide", "faq", "timeline", "quiz", "flashcards", "mindmap", "slides", "audio"] as const;
export type GenKind = (typeof GENERATORS)[number];

export function sourceBundle(nid: string, budget = 120_000): string {
  const rows = getDb().prepare("SELECT name, text FROM notebook_sources WHERE notebook_id=? ORDER BY created_at").all(nid) as { name: string; text: string }[];
  if (!rows.length) throw Object.assign(new Error("Add at least one source first."), { status: 400 });
  const total = rows.reduce((n, r) => n + r.text.length, 0);
  const scale = total > budget ? budget / total : 1;
  return rows.map((r) => `### Source: ${r.name}\n${r.text.slice(0, Math.max(500, Math.floor(r.text.length * scale)))}`).join("\n\n");
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const s = (v: unknown, max = 600) => String(v ?? "").trim().slice(0, max);

export function validateQuiz(v: any) {
  const qs = arr<any>(v?.questions).map((q) => {
    const options = arr<any>(q.options).map((o) => s(o, 200)).filter(Boolean).slice(0, 5);
    let answer = Number(q.answer);
    if (!Number.isInteger(answer)) answer = options.findIndex((o) => o.toLowerCase() === s(q.answer, 200).toLowerCase());
    return { q: s(q.q ?? q.question, 400), options, answer, explanation: s(q.explanation, 500) };
  }).filter((q) => q.q && q.options.length >= 2 && q.answer >= 0 && q.answer < q.options.length);
  if (qs.length < 2) throw new Error("The model did not produce a usable quiz. Try again.");
  return { questions: qs };
}
/** Pull front/back pairs out of raw text when the JSON structure is broken (small models often flatten or repeat them). */
export function cardPairs(raw: string) {
  const seen = new Set<string>(); const cards: { front: string; back: string }[] = [];
  for (const m of raw.matchAll(/"front"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"back"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    const front = s(JSON.parse(`"${m[1]}"`), 400), back = s(JSON.parse(`"${m[2]}"`), 600);
    if (front && back && front !== back && !seen.has(front)) { seen.add(front); cards.push({ front, back }); }
  }
  return cards;
}
export function validateCards(v: any) {
  const cards = arr<any>(v?.cards).map((c) => ({ front: s(c.front ?? c.q, 400), back: s(c.back ?? c.a, 600) })).filter((c) => c.front && c.back);
  if (cards.length < 2) throw new Error("The model did not produce usable flashcards. Try again.");
  return { cards };
}
export function validateFaq(v: any) {
  const items = arr<any>(v?.items ?? v?.faq).map((i) => ({ q: s(i.q ?? i.question, 300), a: s(i.a ?? i.answer, 900) })).filter((i) => i.q && i.a);
  if (items.length < 2) throw new Error("The model did not produce a usable FAQ. Try again.");
  return { items };
}
export function validateTimeline(v: any) {
  const events = arr<any>(v?.events).map((e) => ({ when: s(e.when ?? e.date, 80), what: s(e.what ?? e.event, 400) })).filter((e) => e.when && e.what);
  if (events.length < 2) throw new Error("No dated events were found in these sources. Try a study guide instead.");
  return { events };
}
export interface MindNode { title: string; children?: MindNode[] }
export function validateMindmap(v: any): MindNode {
  const walk = (n: any, depth: number): MindNode => ({ title: s(n?.title ?? n?.name, 80), children: depth >= 3 ? [] : arr<any>(n?.children).map((c) => walk(c, depth + 1)).filter((c) => c.title).slice(0, 8) });
  const root = walk(v, 0);
  if (!root.title || !root.children?.length) throw new Error("The model did not produce a usable mind map. Try again.");
  return root;
}
export function validateSlides(v: any) {
  const slides = arr<any>(v?.slides).map((x) => ({ title: s(x.title, 100), bullets: arr<any>(x.bullets).map((b) => s(b, 200)).filter(Boolean).slice(0, 6), notes: s(x.notes, 600) })).filter((x) => x.title);
  if (slides.length < 3) throw new Error("The model did not produce a usable slide deck. Try again.");
  return { title: s(v?.title, 100) || slides[0]!.title, slides };
}
export interface AudioScript { title: string; chapters: { title: string; lines: { speaker: "A" | "B"; text: string }[] }[] }
export function validateScript(v: any): AudioScript {
  let prev: "A" | "B" = "B"; // a line without a speaker alternates from the previous one
  const chapters = arr<any>(v?.chapters).map((c) => ({
    title: s(c.title, 80) || "Chapter",
    lines: arr<any>(c.lines).map((l) => {
      const sp = s(l.speaker, 4);
      const speaker: "A" | "B" = sp ? (/^b$/i.test(sp) ? "B" : "A") : prev === "A" ? "B" : "A";
      prev = speaker;
      return { speaker, text: s(l.text, 700) };
    }).filter((l) => l.text),
  })).filter((c) => c.lines.length);
  if (!chapters.length) throw new Error("The model did not write a usable script. Try again.");
  return { title: s(v?.title, 100) || "Audio overview", chapters };
}

async function genJSON<T>(nid: string, task: "research" | "creative", system: string, user: string, validate: (v: any) => T, max = 4000): Promise<T> {
  const book = getNotebook(nid)!;
  const { value } = await routedJSON<any>({ task, private: book.private, purpose: "notebook-gen", temperature: 0.4, maxTokens: max, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
  return validate(value);
}

export async function buildPptx(data: { title: string; slides: { title: string; bullets: string[]; notes?: string }[] }, file: string) {
  const pptx = new PptxGenJS(); pptx.layout = "LAYOUT_16x9"; pptx.title = data.title;
  const t = pptx.addSlide(); t.background = { color: "1B1F3A" };
  t.addText(data.title, { x: 0.6, y: 2.0, w: 8.8, h: 1.5, fontSize: 36, bold: true, color: "FFFFFF", align: "center" });
  t.addText("Generated by OpenMax", { x: 0.6, y: 3.6, w: 8.8, h: 0.5, fontSize: 14, color: "B9C0FF", align: "center" });
  for (const sl of data.slides) {
    const slide = pptx.addSlide(); slide.background = { color: "FFFFFF" };
    slide.addText(sl.title, { x: 0.5, y: 0.35, w: 9, h: 0.9, fontSize: 28, bold: true, color: "1B1F3A" });
    slide.addText(sl.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })), { x: 0.7, y: 1.5, w: 8.6, h: 3.6, fontSize: 18, color: "333333", valign: "top", paraSpaceAfter: 8 });
    if (sl.notes) slide.addNotes(sl.notes);
  }
  await pptx.writeFile({ fileName: file });
}

const probe = async (f: string) => Number((await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f])).stdout.trim()) || 0;
export async function ffmpegAvailable() { try { await exec("ffmpeg", ["-version"]); return true; } catch { return false; } }

export { parseWav, wavConcat } from "../wav.js";
export type { Wav } from "../wav.js";

/** Convert any synthesized clip to PCM WAV: ffmpeg → macOS afconvert → already-WAV passthrough. */
async function toWav(raw: string, wav: string, mime: string, hasFfmpeg: boolean) {
  if (hasFfmpeg) { await exec("ffmpeg", ["-y", "-loglevel", "error", "-f", mime.includes("mpeg") ? "mp3" : mime.includes("aiff") ? "aiff" : "wav", "-i", raw, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", wav]); return; }
  if (!mime.includes("wav")) {
    try { await exec("afconvert", ["-f", "WAVE", "-d", "LEI16@24000", "-c", "1", raw, wav]); return; }
    catch { throw Object.assign(new Error("Cannot convert the voice audio without ffmpeg."), { fix: "Install a working ffmpeg (brew install ffmpeg), or use Piper/macOS `say` voices which write WAV directly." }); }
  }
  fs.copyFileSync(raw, wav);
}

/** Script → per-line TTS → one file with chapter markers. ffmpeg gives MP3/AAC with embedded chapters; without it we write a WAV and keep chapters in the output data. */
export async function buildAudio(script: AudioScript, outBase: string, opts: { forceNoFfmpeg?: boolean } = {}): Promise<{ file: string; mime: string; chapters: { title: string; start: number; end: number }[]; duration: number; backend: string; encoder: string }> {
  const hasFfmpeg = !opts.forceNoFfmpeg && (await ffmpegAvailable());
  const work = fs.mkdtempSync(path.join(path.dirname(outBase), "au-"));
  try {
    const wavs: string[] = []; const lineChapter: number[] = []; let backend = "unknown", n = 0;
    for (const [ci, ch] of script.chapters.entries()) {
      for (const line of ch.lines) {
        const r = await synthesize(line.text, line.speaker === "A" ? "host_a" : "host_b"); backend = r.backend;
        const raw = path.join(work, `raw-${n}`), wav = path.join(work, `l-${n++}.wav`);
        fs.writeFileSync(raw, r.audio);
        await toWav(raw, wav, r.mime, hasFfmpeg);
        wavs.push(wav); lineChapter.push(ci);
      }
    }
    let durations: number[]; let merged: Buffer | undefined;
    if (hasFfmpeg) durations = await Promise.all(wavs.map(probe));
    else { const c = wavConcat(wavs.map((w) => parseWav(fs.readFileSync(w)))); durations = c.durations; merged = c.buffer; }
    const chapters = script.chapters.map((c) => ({ title: c.title, start: 0, end: 0 }));
    let t = 0;
    durations.forEach((d, i) => { const ch = chapters[lineChapter[i]!]!; if (ch.end === 0 && ch.start === 0) ch.start = t; t += d; ch.end = t; });
    if (!hasFfmpeg) { const file = `${outBase}.wav`; fs.writeFileSync(file, merged!); return { file, mime: "audio/wav", chapters, duration: t, backend, encoder: "wav" }; }
    fs.writeFileSync(path.join(work, "list.txt"), wavs.map((w) => `file '${w}'`).join("\n"));
    fs.writeFileSync(path.join(work, "meta.txt"), `;FFMETADATA1\ntitle=${script.title}\n` + chapters.map((c) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.start * 1000)}\nEND=${Math.max(Math.round(c.end * 1000), Math.round(c.start * 1000) + 1)}\ntitle=${c.title}\n`).join(""));
    const args = (codec: string[], out: string) => ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(work, "list.txt"), "-i", path.join(work, "meta.txt"), "-map_metadata", "1", ...codec, out];
    let file = `${outBase}.mp3`, mime = "audio/mpeg", encoder = "mp3";
    try { await exec("ffmpeg", args(["-c:a", "libmp3lame", "-b:a", "96k"], file)); }
    catch { file = `${outBase}.m4a`; mime = "audio/mp4"; encoder = "aac"; await exec("ffmpeg", args(["-c:a", "aac", "-b:a", "96k"], file)); }
    return { file, mime, chapters, duration: t, backend, encoder };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

export interface OutputRow { id: string; notebook_id: string; kind: string; title: string; data: any; file: string | null; created_at: number }
const orow = (r: any): OutputRow => ({ ...r, data: JSON.parse(r.data) });
export const listOutputs = (nid: string) => (getDb().prepare("SELECT * FROM notebook_outputs WHERE notebook_id=? ORDER BY created_at DESC").all(nid) as any[]).map(orow);
export const getOutput = (id: string) => { const r = getDb().prepare("SELECT * FROM notebook_outputs WHERE id=?").get(id); return r ? orow(r) : undefined; };
export function deleteOutput(id: string) { const o = getOutput(id); if (o?.file) fs.rmSync(o.file, { force: true }); getDb().prepare("DELETE FROM notebook_outputs WHERE id=?").run(id); }
const nbDir = (nid: string) => { const d = dataPath("notebooks", nid); fs.mkdirSync(d, { recursive: true }); return d; };

export async function generate(nid: string, kind: GenKind, opts: { focus?: string; count?: number } = {}): Promise<OutputRow> {
  const book = getNotebook(nid); if (!book) throw Object.assign(new Error("Notebook not found."), { status: 404 });
  const src = sourceBundle(nid);
  const focus = opts.focus ? `\nFocus on: ${opts.focus}` : "";
  const user = `SOURCES:\n${src}${focus}`;
  const id = uid("no_"); let title = ""; let data: any; let file: string | null = null;
  const only = "Use ONLY information from the sources. Do not add outside facts. Reply with ONLY JSON, no commentary.";
  if (kind === "study_guide") {
    const r = await routedComplete({ task: "research", private: book.private, purpose: "notebook-gen", temperature: 0.3, maxTokens: 3500, messages: [{ role: "system", content: "Write a thorough study guide from the sources in Markdown: Overview, Key concepts (with short definitions), Important details, Common misconceptions, and 5 self-test questions with brief answers. Use ONLY the sources." }, { role: "user", content: user }] });
    title = "Study guide"; data = { markdown: r.text };
  } else if (kind === "faq") { title = "FAQ"; data = await genJSON(nid, "research", `Write the ${opts.count ?? 8} most useful FAQ entries a newcomer to these sources would ask, with accurate concise answers. ${only} Format: {"items":[{"q":"...","a":"..."}]}`, user, validateFaq); }
  else if (kind === "timeline") { title = "Timeline"; data = await genJSON(nid, "research", `Extract a chronological timeline of dated events from the sources (use the dates as written). ${only} Format: {"events":[{"when":"...","what":"..."}]}`, user, validateTimeline); }
  else if (kind === "quiz") { title = "Quiz"; data = await genJSON(nid, "research", `Write ${opts.count ?? 8} multiple-choice questions testing understanding of the sources: 4 options each, exactly one correct, plus a one-sentence explanation. ${only} Format: {"questions":[{"q":"...","options":["a","b","c","d"],"answer":0,"explanation":"..."}]} where "answer" is the 0-based index.`, user, validateQuiz); }
  else if (kind === "flashcards") {
    title = "Flashcards";
    const fsys = `Write ${opts.count ?? 12} flashcards (term/question on the front, concise answer on the back) covering the key facts. ${only} Format: {"cards":[{"front":"...","back":"..."}]}`;
    try { data = await genJSON(nid, "research", fsys, user, validateCards, 2500); }
    catch (e) {
      const raw = await routedComplete({ task: "research", private: book.private, purpose: "notebook-gen", temperature: 0.4, maxTokens: 1800, json: true, messages: [{ role: "system", content: fsys }, { role: "user", content: user }] });
      const cards = cardPairs(raw.text); if (cards.length < 2) throw e; data = { cards };
    }
    const ins = getDb().prepare("INSERT INTO cards(id,notebook_id,front,back,due) VALUES(?,?,?,?,?)");
    getDb().transaction(() => data.cards.forEach((c: any) => ins.run(uid("cd_"), nid, c.front, c.back, now())))();
  } else if (kind === "mindmap") { title = "Mind map"; data = await genJSON(nid, "research", `Create a mind map of the sources: a central topic, 4-7 main branches, each with 2-5 sub-points (max depth 3). ${only} Format: {"title":"...","children":[{"title":"...","children":[{"title":"..."}]}]}`, user, validateMindmap); }
  else if (kind === "slides") {
    const d = await genJSON(nid, "research", `Create a clear slide deck (${opts.count ?? 8} content slides) summarizing the sources: each slide has a short title, 3-5 concise bullets and short speaker notes. ${only} Format: {"title":"...","slides":[{"title":"...","bullets":["..."],"notes":"..."}]}`, user, validateSlides);
    title = d.title; data = d; file = path.join(nbDir(nid), `slides-${id}.pptx`); await buildPptx(d, file);
  } else if (kind === "audio") {
    const script = await genJSON(nid, "creative", `Write a lively two-host podcast script ("A" and "B") explaining the sources to a curious listener: natural back-and-forth, plain spoken language, no stage directions, concrete examples, 3-5 chapters of 6-10 lines each, ending with a takeaway. ${only} Format: {"title":"...","chapters":[{"title":"...","lines":[{"speaker":"A","text":"..."},{"speaker":"B","text":"..."}]}]}`, user, validateScript, 6000);
    title = script.title;
    const a = await buildAudio(script, path.join(nbDir(nid), `audio-${id}`));
    file = a.file; data = { script, chapters: a.chapters, duration: a.duration, mime: a.mime, ttsBackend: a.backend, encoder: a.encoder };
  }
  getDb().prepare("INSERT INTO notebook_outputs(id,notebook_id,kind,title,data,file,created_at) VALUES(?,?,?,?,?,?,?)").run(id, nid, kind, title, JSON.stringify(data), file, now());
  return getOutput(id)!;
}
void listSources;
