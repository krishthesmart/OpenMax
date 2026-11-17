import { getDb, now, uid } from "../db.js";
export interface InboxItem { id: string; kind: string; title: string; body: string; ref: string | null; read: boolean; created_at: number }
const row = (r: any): InboxItem => ({ ...r, read: !!r.read });
export function addInbox(o: { kind: string; title: string; body: string; ref?: string }): InboxItem {
  const id = uid("in_"); getDb().prepare("INSERT INTO inbox(id,kind,title,body,ref,read,created_at) VALUES(?,?,?,?,?,0,?)").run(id, o.kind, o.title.slice(0, 200), o.body.slice(0, 20000), o.ref ?? null, now());
  return row(getDb().prepare("SELECT * FROM inbox WHERE id=?").get(id));
}
export const listInbox = (limit = 200) => (getDb().prepare("SELECT * FROM inbox ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map(row);
export const markRead = (id: string, read = true) => getDb().prepare("UPDATE inbox SET read=? WHERE id=?").run(read ? 1 : 0, id);
export const deleteInbox = (id: string) => getDb().prepare("DELETE FROM inbox WHERE id=?").run(id);
export const unreadCount = () => (getDb().prepare("SELECT COUNT(*) n FROM inbox WHERE read=0").get() as { n: number }).n;
