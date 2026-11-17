import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { getDb, now, uid } from "../../db.js";
import { routedJSON } from "../../router/router.js";
import { defaultBackendId, getBackend, mediaDir, renderInline } from "./index.js";

export interface StoryPage { text: string; scene: string; characters: string[]; image?: string; error?: string }
export interface StoryData {
  status: "writing" | "illustrating" | "binding" | "done" | "error"; progress: number; error?: string; title: string; style: string;
  characters: { name: string; look: string }[]; pages: StoryPage[]; backend: string; seed: number;
}
export const PAGES = 10;

export function validateStory(v: any, pages = PAGES): { title: string; style: string; characters: { name: string; look: string }[]; pages: StoryPage[] } {
  const chars = (Array.isArray(v?.characters) ? v.characters : []).map((c: any) => ({ name: String(c.name ?? "").trim(), look: String(c.look ?? c.description ?? "").trim() })).filter((c: any) => c.name && c.look);
  const ps: StoryPage[] = (Array.isArray(v?.pages) ? v.pages : []).map((p: any) => ({ text: String(p.text ?? "").trim(), scene: String(p.scene ?? p.illustration ?? p.text ?? "").trim(), characters: (Array.isArray(p.characters) ? p.characters : []).map(String) })).filter((p: StoryPage) => p.text);
  if (ps.length < 3) throw new Error("The model did not write a usable story (needs at least 3 pages). Try again or use a different premise.");
  if (!chars.length) throw new Error("The story has no character descriptions, so illustrations could not stay consistent. Try again.");
  return { title: String(v.title ?? "Untitled story").slice(0, 80), style: String(v.style ?? "children's picture book illustration, soft watercolor").slice(0, 200), characters: chars, pages: ps.slice(0, pages) };
}

/** Prompt for page i: the style and each present character's FIXED visual description are repeated verbatim on every page. */
export function pagePrompt(story: Pick<StoryData, "style" | "characters">, page: StoryPage): string {
  const present = story.characters.filter((c) => page.characters.some((n) => n.toLowerCase() === c.name.toLowerCase()) || page.scene.toLowerCase().includes(c.name.toLowerCase()));
  const cast = (present.length ? present : story.characters.slice(0, 1)).map((c) => `${c.name} (${c.look})`).join("; ");
  return `${story.style}. Characters, drawn identically on every page: ${cast}. Scene: ${page.scene}`;
}

const read = (id: string) => { const r = getDb().prepare("SELECT * FROM stories WHERE id=?").get(id) as any; return r ? { ...r, data: JSON.parse(r.data) as StoryData } : undefined; };
const save = (id: string, data: StoryData, extra: { title?: string; pdf?: string } = {}) => getDb().prepare("UPDATE stories SET data=?, title=COALESCE(?,title), pdf=COALESCE(?,pdf) WHERE id=?").run(JSON.stringify(data), extra.title ?? null, extra.pdf ?? null, id);
export const getStory = (id: string) => { const r = read(id); return r && { id: r.id, title: r.title, premise: r.premise, pdf: r.pdf, created_at: r.created_at, ...r.data }; };
export const listStories = () => (getDb().prepare("SELECT id,title,premise,created_at,data FROM stories ORDER BY created_at DESC").all() as any[]).map((r) => { const d = JSON.parse(r.data) as StoryData; return { id: r.id, title: r.title, premise: r.premise, created_at: r.created_at, status: d.status, progress: d.progress }; });
export function deleteStory(id: string) { getDb().prepare("DELETE FROM stories WHERE id=?").run(id); fs.rmSync(path.join(mediaDir(), `story-${id}`), { recursive: true, force: true }); }

export async function buildPdf(dir: string, story: Pick<StoryData, "title" | "pages" | "style">, out: string): Promise<void> {
  const W = 468, H = 612; // 6.5 x 8.5 in
  const doc = new PDFDocument({ size: [W, H], margin: 0, info: { Title: story.title } });
  const stream = fs.createWriteStream(out); doc.pipe(stream);
  doc.rect(0, 0, W, H).fill("#1b1f3a");
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(30).text(story.title, 40, H / 2 - 60, { width: W - 80, align: "center" });
  doc.font("Helvetica").fontSize(12).fillColor("#b9c0ff").text("An OpenMax storybook", 40, H / 2 + 40, { width: W - 80, align: "center" });
  for (const [i, p] of story.pages.entries()) {
    doc.addPage({ size: [W, H], margin: 0 });
    doc.rect(0, 0, W, H).fill("#fffdf6");
    const box = { x: 24, y: 24, w: W - 48, h: 330 };
    const file = p.image ? path.join(dir, p.image) : undefined;
    if (file && fs.existsSync(file)) {
      if (file.endsWith(".svg")) SVGtoPDF(doc, fs.readFileSync(file, "utf8"), box.x, box.y, { width: box.w, height: box.h, preserveAspectRatio: "xMidYMid meet", assumePt: true });
      else doc.image(file, box.x, box.y, { fit: [box.w, box.h], align: "center", valign: "center" });
    } else { doc.rect(box.x, box.y, box.w, box.h).fill("#eee"); doc.fillColor("#999").fontSize(11).text("illustration unavailable", box.x, box.y + box.h / 2, { width: box.w, align: "center" }); }
    doc.fillColor("#222").font("Times-Roman").fontSize(15).text(p.text, 40, 372, { width: W - 80, align: "left", lineGap: 4 });
    doc.fillColor("#999").font("Helvetica").fontSize(9).text(String(i + 1), 0, H - 28, { width: W, align: "center" });
  }
  doc.end();
  await new Promise<void>((res, rej) => { stream.on("finish", () => res()); stream.on("error", rej); });
}

export function startStory(o: { premise: string; style?: string; backend?: string; pages?: number }): string {
  const id = uid("s_");
  const backend = o.backend ?? defaultBackendId();
  const data: StoryData = { status: "writing", progress: 0, title: "Untitled", style: o.style ?? "", characters: [], pages: [], backend, seed: Math.floor(Math.random() * 2 ** 31) };
  getDb().prepare("INSERT INTO stories(id,title,premise,data,created_at) VALUES(?,?,?,?,?)").run(id, "Writing…", o.premise, JSON.stringify(data), now());
  void produce(id, o.premise, o.style, o.pages ?? PAGES).catch((e) => { const r = read(id); if (r) save(id, { ...r.data, status: "error", error: e.message }); });
  return id;
}

async function produce(id: string, premise: string, style: string | undefined, nPages: number) {
  let d: StoryData = read(id)!.data;
  const b = getBackend(d.backend);
  if (!b || !b.ops().t2i.supported) throw new Error(`The "${d.backend}" backend cannot make images. ${b?.ops().t2i.reason ?? "Pick another backend."}`);
  const { value } = await routedJSON<any>({
    task: "creative", purpose: "story", temperature: 0.8, maxTokens: 3500,
    messages: [
      { role: "system", content: `You write illustrated children's storybooks. Reply with ONLY JSON: {"title":"...","style":"one line art direction used for EVERY illustration","characters":[{"name":"...","look":"a precise, fixed visual description: species/age, hair/fur, clothing colors, distinctive features"}],"pages":[{"text":"2-3 sentences of story for this page","scene":"what the illustration shows, concrete and visual","characters":["names present"]}]}. Exactly ${nPages} pages with a clear beginning, middle and end. Keep the character looks concrete and unchanging.` },
      { role: "user", content: `Premise: ${premise}${style ? `\nArt style: ${style}` : ""}` },
    ],
  });
  const story = validateStory(value, nPages);
  d = { ...d, ...story, style: style || story.style, status: "illustrating", progress: 0.05 };
  save(id, d, { title: story.title });
  const dir = path.join(mediaDir(), `story-${id}`); fs.mkdirSync(dir, { recursive: true });
  let ref: string | undefined;
  for (const [i, page] of d.pages.entries()) {
    try {
      const outs = await renderInline({ op: "t2i", prompt: pagePrompt(d, page), aspect: "4:3", count: 1, presets: [], seed: d.seed, backend: d.backend }, `story-${id}`, i > 0 && d.backend === "google-image" ? ref : undefined);
      const o = outs[0]!; const name = `page-${i + 1}${path.extname(o.file)}`;
      fs.renameSync(o.file, path.join(dir, name)); page.image = name;
      if (i === 0) ref = path.join(dir, name);
    } catch (e: any) { page.error = e.message; }
    d.progress = 0.05 + 0.85 * ((i + 1) / d.pages.length); save(id, d);
  }
  if (d.pages.every((pg) => !pg.image)) throw new Error(`No illustrations could be made. ${d.pages[0]?.error ?? ""}`);
  d.status = "binding"; save(id, d);
  const pdfName = "storybook.pdf";
  await buildPdf(dir, d, path.join(dir, pdfName));
  d.status = "done"; d.progress = 1; save(id, d, { pdf: pdfName });
}
export const storyPdfPath = (id: string) => { const r = read(id); return r?.pdf ? path.join(mediaDir(), `story-${id}`, r.pdf) : undefined; };
export const storyFile = (id: string, file: string) => { if (!/^[\w-]+$/.test(id) || file !== path.basename(file)) return undefined; const p = path.join(mediaDir(), `story-${id}`, file); return fs.existsSync(p) ? p : undefined; };
