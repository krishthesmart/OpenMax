const UA = "Mozilla/5.0 (compatible; OpenMax/0.1)";
export function youtubeId(u: string): string | undefined {
  try {
    const x = new URL(u);
    if (/(^|\.)youtu\.be$/.test(x.hostname)) return x.pathname.slice(1) || undefined;
    if (/(^|\.)youtube\.com$/.test(x.hostname)) return x.searchParams.get("v") ?? /\/(embed|shorts|live)\/([\w-]{6,})/.exec(x.pathname)?.[2] ?? undefined;
  } catch { /* not a URL */ }
  return undefined;
}
export function parseCaptionTracks(html: string): { baseUrl: string; lang: string; auto: boolean }[] {
  const m = /"captionTracks":(\[[\s\S]*?\])/.exec(html);
  if (!m) return [];
  try { return (JSON.parse(m[1]!) as any[]).map((t) => ({ baseUrl: String(t.baseUrl).replace(/\\u0026/g, "&"), lang: t.languageCode, auto: t.kind === "asr" })); } catch { return []; }
}
export function parseTimedText(body: string): string {
  try { const j = JSON.parse(body); return (j.events ?? []).flatMap((e: any) => (e.segs ?? []).map((s: any) => s.utf8)).join("").replace(/\s*\n\s*/g, " ").trim(); } catch { /* xml */ }
  return [...body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) => m[1]!.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")).join(" ").replace(/\s+/g, " ").trim();
}
export async function fetchTranscript(url: string): Promise<{ title: string; text: string }> {
  const id = youtubeId(url);
  if (!id) throw new Error("That is not a YouTube link.");
  const page = await (await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { "user-agent": UA, "accept-language": "en-US,en;q=0.9" }, signal: AbortSignal.timeout(20000) })).text();
  const title = /<title>([^<]*)<\/title>/.exec(page)?.[1]?.replace(/ - YouTube$/, "") ?? `YouTube ${id}`;
  const tracks = parseCaptionTracks(page);
  const pick = tracks.find((t) => t.lang.startsWith("en") && !t.auto) ?? tracks.find((t) => t.lang.startsWith("en")) ?? tracks[0];
  if (!pick) throw Object.assign(new Error("This video has no captions OpenMax can read."), { fix: "Paste the transcript as a text source instead (YouTube → ⋯ → Show transcript)." });
  const body = await (await fetch(`${pick.baseUrl}&fmt=json3`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) })).text();
  const text = parseTimedText(body);
  if (!text) throw Object.assign(new Error("The transcript came back empty."), { fix: "Paste the transcript as a text source instead." });
  return { title, text };
}
