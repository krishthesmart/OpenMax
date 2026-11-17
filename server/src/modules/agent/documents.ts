import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

/** Small Markdown → PDF renderer (headings, paragraphs, bullet/numbered lists, code blocks, rules, simple tables as monospace). */
export async function markdownToPdf(file: string, title: string, markdown: string): Promise<void> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const doc = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 56, left: 60, right: 60 }, info: { Title: title } });
  const out = fs.createWriteStream(file); doc.pipe(out);
  const W = doc.page.width - 120;
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#111").text(title, { width: W }); doc.moveDown(0.6);
  const clean = (t: string) => t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/(?<!\*)\*(?!\s)(.+?)\*(?!\*)/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
  let inCode = false; let code: string[] = [];
  const flushCode = () => { if (!code.length) return; doc.font("Courier").fontSize(9).fillColor("#222").text(code.join("\n"), { width: W, lineGap: 1 }); doc.moveDown(0.5); code = []; };
  for (const raw of markdown.replace(/\r/g, "").split("\n")) {
    if (/^```/.test(raw)) { if (inCode) flushCode(); inCode = !inCode; continue; }
    if (inCode) { code.push(raw); continue; }
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) { const lvl = m[1]!.length; doc.moveDown(0.4).font("Helvetica-Bold").fontSize([20, 16, 13, 11.5][lvl - 1]!).fillColor("#111").text(clean(m[2]!), { width: W }); doc.moveDown(0.25); }
    else if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { doc.font("Helvetica").fontSize(10.5).fillColor("#222").text(`•  ${clean(m[1]!)}`, { width: W - 14, indent: 14, lineGap: 2 }); }
    else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) { doc.font("Helvetica").fontSize(10.5).fillColor("#222").text(`${m[1]}.  ${clean(m[2]!)}`, { width: W - 14, indent: 14, lineGap: 2 }); }
    else if (/^\s*\|.*\|\s*$/.test(line)) { if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) doc.font("Courier").fontSize(8.5).fillColor("#222").text(line.trim(), { width: W }); }
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { doc.moveDown(0.3).moveTo(60, doc.y).lineTo(60 + W, doc.y).strokeColor("#bbb").stroke(); doc.moveDown(0.5); }
    else if (line.trim() === "") doc.moveDown(0.4);
    else doc.font("Helvetica").fontSize(10.5).fillColor("#222").text(clean(line), { width: W, lineGap: 2, align: "left" });
  }
  flushCode(); doc.end();
  await new Promise<void>((res, rej) => { out.on("finish", () => res()); out.on("error", rej); });
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => { const s = v === undefined || v === null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.join("; ") : JSON.stringify(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.map(esc).join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
export function toMarkdownTable(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => String(Array.isArray(v) ? v.join(", ") : v ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").slice(0, 400);
  return [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`)].join("\n");
}
