import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataPath } from "../config.js";
import { getDb, now, uid } from "../db.js";
import { pdfToText } from "./pdf.js";
import { transcribe } from "./speech.js";
import type { ImagePart } from "../providers/types.js";
import type { AttachmentKind } from "../router/classify.js";
import { redactCards } from "../util/redact.js";

const exec = promisify(execFile);
export interface Attachment { id: string; name: string; mime: string; kind: AttachmentKind; size: number; path: string; text_path: string | null; pages: string | null; note: string | null }
const dir = () => { const d = dataPath("uploads"); fs.mkdirSync(d, { recursive: true }); return d; };

export function kindOf(mime: string, name: string): AttachmentKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|webm|flac)$/i.test(name)) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  return "text";
}

/** Rasterize PDF pages for scanned documents (poppler's pdftoppm, or macOS sips for page 1). */
export async function rasterizePdf(file: string, maxPages = 3): Promise<string[]> {
  const base = path.join(os.tmpdir(), `om-pdf-${Date.now()}`);
  try {
    await exec("pdftoppm", ["-png", "-r", "110", "-l", String(maxPages), file, base]);
    const out = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(path.basename(base)) && f.endsWith(".png")).sort().map((f) => path.join(os.tmpdir(), f));
    if (out.length) return out;
  } catch { /* try sips */ }
  if (process.platform === "darwin") {
    try { const o = `${base}-1.png`; await exec("sips", ["-s", "format", "png", file, "--out", o]); if (fs.existsSync(o)) return [o]; } catch { /* none */ }
  }
  return [];
}

export async function saveAttachment(name: string, mime: string, buf: Buffer): Promise<Attachment> {
  const id = uid("a_");
  const kind = kindOf(mime, name);
  const ext = path.extname(name) || "";
  const file = path.join(dir(), id + ext);
  fs.writeFileSync(file, buf);
  let textPath: string | null = null, pages: string | null = null, note: string | null = null;
  const writeText = (t: string) => { textPath = path.join(dir(), `${id}.txt`); fs.writeFileSync(textPath, redactCards(t)); };
  try {
    if (kind === "pdf") {
      const t = await pdfToText(buf).catch(() => "");
      if (t.length > 40) writeText(t);
      else {
        const imgs = await rasterizePdf(file);
        if (imgs.length) { const kept = imgs.map((p, i) => { const dst = path.join(dir(), `${id}.p${i + 1}.png`); fs.copyFileSync(p, dst); fs.rmSync(p, { force: true }); return dst; }); pages = JSON.stringify(kept); note = "Scanned PDF: pages rasterized for a vision model."; }
        else note = "This PDF has no text layer and could not be rasterized. Install poppler (`brew install poppler`) so scanned PDFs can be read by a vision model.";
      }
    } else if (kind === "audio") {
      const t = await transcribe(buf, name, mime);
      writeText(t.text); note = `Transcribed with ${t.backend}.`;
    } else if (kind === "text") writeText(buf.toString("utf8"));
    else if (kind === "video") note = "Video is kept as a file; frames are not analysed by the chat models.";
  } catch (e: any) { note = e.fix ? `${e.message} ${e.fix}` : e.message; }
  getDb().prepare("INSERT INTO attachments(id,name,mime,kind,size,path,text_path,pages,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, name, mime, kind, buf.length, file, textPath, pages, note, now());
  return getAttachment(id)!;
}
export const getAttachment = (id: string) => getDb().prepare("SELECT * FROM attachments WHERE id=?").get(id) as Attachment | undefined;
export const attachmentText = (a: Attachment) => (a.text_path && fs.existsSync(a.text_path) ? fs.readFileSync(a.text_path, "utf8") : "");
export function attachmentImages(a: Attachment): ImagePart[] {
  if (a.kind === "image") return [{ mime: a.mime, data: fs.readFileSync(a.path).toString("base64") }];
  if (a.pages) return (JSON.parse(a.pages) as string[]).map((p) => ({ mime: "image/png", data: fs.readFileSync(p).toString("base64") }));
  return [];
}
export const publicAttachment = (a: Attachment) => ({ id: a.id, name: a.name, mime: a.mime, kind: a.kind, size: a.size, note: a.note, chars: attachmentText(a).length });
