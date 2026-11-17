/** Text extraction from PDFs via pdfjs. Returns "" when there is no text layer (caller may rasterize/OCR via a vision model). */
export async function pdfToText(buf: Buffer): Promise<string> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((it: any) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ").trim());
  }
  await doc.destroy();
  return pages.join("\n\n").trim();
}
export async function pdfPageCount(buf: Buffer): Promise<number> {
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const n = doc.numPages; await doc.destroy(); return n;
}
