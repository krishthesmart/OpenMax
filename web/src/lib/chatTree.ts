export interface Msg { id: string; parent_id: string | null; role: "user" | "assistant"; content: string; meta: any; created_at: number }
export function indexTree(msgs: Msg[]) {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const children = new Map<string | null, Msg[]>();
  for (const m of msgs) { const k = m.parent_id; (children.get(k) ?? children.set(k, []).get(k)!).push(m); }
  for (const arr of children.values()) arr.sort((a, b) => a.created_at - b.created_at);
  return { byId, children };
}
export function pathFromLeaf(msgs: Msg[], leaf: string | null): Msg[] {
  const { byId } = indexTree(msgs);
  const out: Msg[] = []; let cur = leaf ? byId.get(leaf) : undefined;
  while (cur) { out.unshift(cur); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined; }
  return out;
}
/** Follow the newest child repeatedly to land on a leaf below `id`. */
export function deepest(msgs: Msg[], id: string): string {
  const { children } = indexTree(msgs);
  let cur = id;
  for (;;) { const kids = children.get(cur); if (!kids?.length) return cur; cur = kids[kids.length - 1]!.id; }
}
export function siblingsOf(msgs: Msg[], m: Msg): Msg[] { return indexTree(msgs).children.get(m.parent_id) ?? [m]; }
