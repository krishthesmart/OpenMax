import { getDb, vecLoaded } from "../db.js";
import { embed, hashEmbed, toBlob, HASH_DIM } from "./embeddings.js";

export function chunkText(text: string, size = 900, overlap = 120): string[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];
  const paras = clean.split(/\n{2,}/).flatMap((p) => (p.length <= size ? [p] : p.match(new RegExp(`[\\s\\S]{1,${size}}(?:[.!?](?=\\s)|\\s|$)`, "g")) ?? [p]));
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras.map((x) => x.trim()).filter(Boolean)) {
    if (cur && cur.length + p.length + 2 > size) { chunks.push(cur); cur = (overlap ? cur.slice(-overlap).replace(/^\S*\s/, "") + "\n\n" : "") + p; }
    else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export interface Hit { chunkId: number; sourceId: string | null; sourceName: string | null; idx: number; text: string; score: number }

export async function indexText(owner: { kind: string; id: string }, source: { id: string; name: string }, text: string, opts: { localOnly?: boolean } = {}) {
  const chunks = chunkText(text);
  if (!chunks.length) return { chunks: 0, model: "none" };
  const { vectors, model } = await embed(chunks, "passage", opts);
  const db = getDb();
  const ins = db.prepare("INSERT INTO chunks(owner_kind,owner_id,source_id,source_name,idx,text,embedding,dim) VALUES(?,?,?,?,?,?,?,?)");
  db.transaction(() => chunks.forEach((c, i) => ins.run(owner.kind, owner.id, source.id, source.name, i, c, toBlob(vectors[i]!), vectors[i]!.length)))();
  return { chunks: chunks.length, model };
}
export function deleteSource(ownerKind: string, ownerId: string, sourceId: string) {
  getDb().prepare("DELETE FROM chunks WHERE owner_kind=? AND owner_id=? AND source_id=?").run(ownerKind, ownerId, sourceId);
}
export function listSources(ownerKind: string, ownerId: string) {
  return getDb().prepare("SELECT source_id id, source_name name, COUNT(*) chunks FROM chunks WHERE owner_kind=? AND owner_id=? GROUP BY source_id ORDER BY MIN(id)").all(ownerKind, ownerId) as { id: string; name: string; chunks: number }[];
}

function cosine(a: Float32Array, b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function retrieve(owner: { kind: string; id: string }, query: string, k = 6, opts: { localOnly?: boolean; sourceIds?: string[] } = {}): Promise<Hit[]> {
  const db = getDb();
  const dims = (db.prepare("SELECT DISTINCT dim FROM chunks WHERE owner_kind=? AND owner_id=?").all(owner.kind, owner.id) as { dim: number }[]).map((r) => r.dim);
  if (!dims.length) return [];
  const hits: Hit[] = [];
  for (const dim of dims) {
    const qv = dim === HASH_DIM ? hashEmbed(query) : (await embed([query], "query", opts)).vectors[0]!;
    if (qv.length !== dim) continue;
    const src = opts.sourceIds?.length ? `AND source_id IN (${opts.sourceIds.map(() => "?").join(",")})` : "";
    const args: unknown[] = [owner.kind, owner.id, dim, ...(opts.sourceIds ?? [])];
    if (vecLoaded) {
      const rows = db.prepare(`SELECT id, source_id, source_name, idx, text, vec_distance_cosine(embedding, ?) d FROM chunks WHERE owner_kind=? AND owner_id=? AND dim=? ${src} ORDER BY d LIMIT ?`).all(toBlob(qv), ...args, k) as any[];
      rows.forEach((r) => hits.push({ chunkId: r.id, sourceId: r.source_id, sourceName: r.source_name, idx: r.idx, text: r.text, score: 1 - r.d }));
    } else {
      const rows = db.prepare(`SELECT id, source_id, source_name, idx, text, embedding FROM chunks WHERE owner_kind=? AND owner_id=? AND dim=? ${src}`).all(...args) as any[];
      rows.forEach((r) => hits.push({ chunkId: r.id, sourceId: r.source_id, sourceName: r.source_name, idx: r.idx, text: r.text, score: cosine(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, dim), qv) }));
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, k);
}

/** Context block with [n] markers + the matching citation list. */
export function formatContext(hits: Hit[]): { context: string; citations: { n: number; name: string; idx: number; chunkId: number; text: string }[] } {
  const citations = hits.map((h, i) => ({ n: i + 1, name: h.sourceName ?? "source", idx: h.idx, chunkId: h.chunkId, text: h.text }));
  return { context: citations.map((c) => `[${c.n}] (${c.name})\n${c.text}`).join("\n\n"), citations };
}
