/** Pure, dependency-free: used by the server (persistence) and the web client (rendering, streaming-safe). */
export const ARTIFACT_KINDS = ["code", "markdown", "html", "svg", "react"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export interface ParsedArtifact { key: string; title: string; kind: ArtifactKind; lang?: string; content: string; complete: boolean }
export type Segment = { type: "text"; text: string } | { type: "artifact"; artifact: ParsedArtifact };

const OPEN = /^:::artifact\{([^}\n]*)\}[ \t]*\n/m;
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "artifact";

function attrs(s: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g)) o[(m[1] ?? m[3])!] = (m[2] ?? m[4])!;
  return o;
}
function unwrapFence(body: string): { content: string; lang?: string } {
  const m = /^\s*```([\w+-]*)\n([\s\S]*?)\n?```\s*$/.exec(body);
  return m ? { content: m[2]!, lang: m[1] || undefined } : { content: body.replace(/^\n+|\n+$/g, "") };
}

export function parseArtifacts(text: string): Segment[] {
  const out: Segment[] = [];
  let rest = text;
  for (;;) {
    const m = OPEN.exec(rest);
    if (!m) break;
    const before = rest.slice(0, m.index);
    if (before) out.push({ type: "text", text: before });
    const a = attrs(m[1]!);
    const start = m.index + m[0].length;
    const after = rest.slice(start);
    const close = /^:::[ \t]*$/m.exec(after);
    const rawBody = close ? after.slice(0, close.index) : after;
    const complete = !!close;
    const kind = (ARTIFACT_KINDS as readonly string[]).includes(a.kind ?? "") ? (a.kind as ArtifactKind) : a.kind === "text" ? "markdown" : "code";
    const { content, lang } = kind === "markdown" ? { content: rawBody.replace(/^\n+|\n+$/g, ""), lang: undefined } : unwrapFence(rawBody);
    const title = a.title || "Untitled";
    out.push({ type: "artifact", artifact: { key: a.id || slug(title), title, kind, lang: a.lang || lang, content, complete } });
    rest = close ? after.slice(close.index + close[0].length).replace(/^\n/, "") : "";
    if (!close) break;
  }
  if (rest) out.push({ type: "text", text: rest });
  return out;
}
export const artifactsOf = (text: string) => parseArtifacts(text).flatMap((s) => (s.type === "artifact" ? [s.artifact] : []));
/** Text with artifact bodies replaced by a short placeholder (for titles / previews / TTS). */
export const stripArtifacts = (text: string) => parseArtifacts(text).map((s) => (s.type === "text" ? s.text : `[${s.artifact.title}]`)).join("");

export function extForArtifact(a: Pick<ParsedArtifact, "kind" | "lang">): string {
  if (a.kind === "html") return "html"; if (a.kind === "svg") return "svg"; if (a.kind === "markdown") return "md"; if (a.kind === "react") return "jsx";
  const l = (a.lang ?? "").toLowerCase();
  return ({ typescript: "ts", ts: "ts", tsx: "tsx", javascript: "js", js: "js", python: "py", py: "py", rust: "rs", go: "go", java: "java", bash: "sh", sh: "sh", json: "json", css: "css", sql: "sql", yaml: "yml", c: "c", cpp: "cpp" } as Record<string, string>)[l] ?? (l || "txt");
}
