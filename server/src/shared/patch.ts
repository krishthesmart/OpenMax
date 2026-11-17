/** Structured edit operations for Canvas. Pure and atomic: if any op cannot be applied, nothing changes. */
export type PatchOp =
  | { op: "replace"; find: string; replace: string; all?: boolean }
  | { op: "insert_after"; anchor: string; text: string }
  | { op: "insert_before"; anchor: string; text: string }
  | { op: "delete"; find: string }
  | { op: "replace_lines"; start: number; end: number; text: string }
  | { op: "append"; text: string }
  | { op: "set"; text: string };

export interface PatchResult { ok: boolean; content: string; errors: string[]; applied: number }

const count = (hay: string, needle: string) => { if (!needle) return 0; let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length; } return n; };
const short = (s: string) => JSON.stringify(s.length > 40 ? s.slice(0, 37) + "…" : s);

export function applyPatch(content: string, ops: PatchOp[]): PatchResult {
  let cur = content; const errors: string[] = [];
  ops.forEach((o, i) => {
    const tag = `op ${i + 1} (${o.op})`;
    const unique = (needle: string): number | undefined => {
      const n = count(cur, needle);
      if (!needle) { errors.push(`${tag}: empty search text`); return undefined; }
      if (n === 0) { errors.push(`${tag}: text not found: ${short(needle)}`); return undefined; }
      if (n > 1) { errors.push(`${tag}: text appears ${n} times, include more context to make it unique: ${short(needle)}`); return undefined; }
      return cur.indexOf(needle);
    };
    switch (o.op) {
      case "replace": {
        if (o.all) { if (count(cur, o.find) === 0) { errors.push(`${tag}: text not found: ${short(o.find)}`); break; } cur = cur.split(o.find).join(o.replace); break; }
        const at = unique(o.find); if (at !== undefined) cur = cur.slice(0, at) + o.replace + cur.slice(at + o.find.length); break;
      }
      case "delete": { const at = unique(o.find); if (at !== undefined) cur = cur.slice(0, at) + cur.slice(at + o.find.length); break; }
      case "insert_after": { const at = unique(o.anchor); if (at !== undefined) cur = cur.slice(0, at + o.anchor.length) + o.text + cur.slice(at + o.anchor.length); break; }
      case "insert_before": { const at = unique(o.anchor); if (at !== undefined) cur = cur.slice(0, at) + o.text + cur.slice(at); break; }
      case "replace_lines": {
        const lines = cur.split("\n");
        if (!Number.isInteger(o.start) || !Number.isInteger(o.end) || o.start < 1 || o.end < o.start || o.start > lines.length) { errors.push(`${tag}: invalid line range ${o.start}-${o.end} (document has ${lines.length} lines)`); break; }
        lines.splice(o.start - 1, Math.min(o.end, lines.length) - o.start + 1, ...(o.text === "" ? [] : o.text.split("\n")));
        cur = lines.join("\n"); break;
      }
      case "append": cur = cur + (cur && !cur.endsWith("\n") && !o.text.startsWith("\n") ? "\n" : "") + o.text; break;
      case "set": cur = o.text; break;
      default: errors.push(`${tag}: unknown operation`);
    }
  });
  return errors.length ? { ok: false, content, errors, applied: 0 } : { ok: true, content: cur, errors: [], applied: ops.length };
}

const OPS = new Set(["replace", "insert_after", "insert_before", "delete", "replace_lines", "append", "set"]);
/** Validate untrusted model output into PatchOp[] (drops malformed ops, reports why). */
export function parseOps(v: unknown): { ops: PatchOp[]; dropped: string[] } {
  const raw = Array.isArray((v as any)?.ops) ? (v as any).ops : Array.isArray(v) ? v : [];
  const ops: PatchOp[] = [], dropped: string[] = [];
  raw.forEach((o: any, i: number) => {
    const str = (k: string) => typeof o?.[k] === "string";
    if (!o || !OPS.has(o.op)) return void dropped.push(`op ${i + 1}: unknown operation`);
    const ok = (o.op === "replace" && str("find") && str("replace")) || (o.op === "delete" && str("find")) || ((o.op === "insert_after" || o.op === "insert_before") && str("anchor") && str("text"))
      || (o.op === "replace_lines" && typeof o.start === "number" && typeof o.end === "number" && str("text")) || ((o.op === "append" || o.op === "set") && str("text"));
    if (!ok) return void dropped.push(`op ${i + 1}: missing fields for ${o.op}`);
    ops.push(o as PatchOp);
  });
  return { ops, dropped };
}
