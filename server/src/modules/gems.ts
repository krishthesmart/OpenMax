import { getDb, now, uid } from "../db.js";
import { deleteSource, indexText, listSources } from "./rag.js";
import { attachmentText, getAttachment } from "./attachments.js";

export interface Gem { id: string; name: string; icon: string; instructions: string; pinned_model: string | null; lane: string | null; starters: string[]; private: boolean; created_at: number }
const row = (r: any): Gem => ({ ...r, starters: JSON.parse(r.starters ?? "[]"), private: !!r.private });
export const listGems = () => (getDb().prepare("SELECT * FROM gems ORDER BY created_at").all() as any[]).map(row);
export const getGem = (id: string) => { const r = getDb().prepare("SELECT * FROM gems WHERE id=?").get(id); return r ? row(r) : undefined; };
export function saveGem(g: Partial<Gem> & { name: string }): Gem {
  const id = g.id ?? uid("g_");
  const exists = getGem(id);
  const v = { name: g.name, icon: g.icon ?? exists?.icon ?? "✨", instructions: g.instructions ?? exists?.instructions ?? "", pinned_model: g.pinned_model ?? null, lane: g.lane ?? null, starters: JSON.stringify(g.starters ?? exists?.starters ?? []), private: g.private ? 1 : 0 };
  if (exists) getDb().prepare("UPDATE gems SET name=?,icon=?,instructions=?,pinned_model=?,lane=?,starters=?,private=? WHERE id=?").run(v.name, v.icon, v.instructions, v.pinned_model, v.lane, v.starters, v.private, id);
  else getDb().prepare("INSERT INTO gems(id,name,icon,instructions,pinned_model,lane,starters,private,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, v.name, v.icon, v.instructions, v.pinned_model, v.lane, v.starters, v.private, now());
  return getGem(id)!;
}
export function deleteGem(id: string) { getDb().prepare("DELETE FROM chunks WHERE owner_kind='gem' AND owner_id=?").run(id); getDb().prepare("DELETE FROM gems WHERE id=?").run(id); }
export const gemSources = (id: string) => listSources("gem", id);
export async function addGemKnowledge(gemId: string, attachmentId: string) {
  const a = getAttachment(attachmentId);
  if (!a) throw new Error("Attachment not found.");
  const text = attachmentText(a);
  if (!text) throw new Error(a.note ?? "No readable text in that file.");
  const gem = getGem(gemId);
  return indexText({ kind: "gem", id: gemId }, { id: a.id, name: a.name }, text, { localOnly: gem?.private });
}
export const removeGemKnowledge = (gemId: string, sourceId: string) => deleteSource("gem", gemId, sourceId);
