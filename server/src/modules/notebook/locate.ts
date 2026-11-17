/** Find where a retrieved chunk sits in its source text (whitespace-insensitive), so the UI can highlight the passage. */
export function locatePassage(source: string, passage: string): { start: number; end: number } | undefined {
  const norm = (s: string) => { const idx: number[] = []; let out = ""; let prevSpace = true; for (let i = 0; i < s.length; i++) { const ws = /\s/.test(s[i]!); if (ws) { if (!prevSpace) { out += " "; idx.push(i); } prevSpace = true; } else { out += s[i]!.toLowerCase(); idx.push(i); prevSpace = false; } } return { out, idx }; };
  const S = norm(source), P = norm(passage);
  const pText = P.out.trim();
  if (!pText) return undefined;
  const needle = pText.slice(0, Math.min(80, pText.length));
  const at = S.out.indexOf(needle);
  if (at < 0) return undefined;
  const endNorm = Math.min(S.out.length - 1, at + pText.length - 1);
  return { start: S.idx[at]!, end: (S.idx[endNorm] ?? source.length - 1) + 1 };
}
