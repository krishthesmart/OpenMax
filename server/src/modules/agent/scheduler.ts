import cron, { type ScheduledTask } from "node-cron";
import { getDb, now, uid } from "../../db.js";
import { startRun } from "./agent.js";

export interface Schedule { id: string; name: string; cron: string; goal: string; enabled: boolean; last_run: number | null; created_at: number }
const row = (r: any): Schedule => ({ ...r, enabled: !!r.enabled });
const tasks = new Map<string, ScheduledTask>();

export const validateCron = (expr: string) => cron.validate(expr);
export const listSchedules = () => (getDb().prepare("SELECT * FROM schedules ORDER BY created_at").all() as any[]).map(row);
export const getSchedule = (id: string) => { const r = getDb().prepare("SELECT * FROM schedules WHERE id=?").get(id); return r ? row(r) : undefined; };

/** Fire a schedule now. Scheduled runs are unattended: approvals are queued to the Inbox instead of blocking. */
export function trigger(id: string): string | undefined {
  const s = getSchedule(id); if (!s) return undefined;
  getDb().prepare("UPDATE schedules SET last_run=? WHERE id=?").run(now(), id);
  return startRun({ goal: s.goal, scheduleId: id, unattended: true });
}
export function syncSchedules() {
  for (const t of tasks.values()) t.stop();
  tasks.clear();
  for (const s of listSchedules()) {
    if (!s.enabled || !cron.validate(s.cron)) continue;
    tasks.set(s.id, cron.schedule(s.cron, () => { try { trigger(s.id); } catch { /* logged in run */ } }));
  }
  return tasks.size;
}
export function saveSchedule(o: { id?: string; name: string; cron: string; goal: string; enabled?: boolean }): Schedule {
  if (!cron.validate(o.cron)) throw Object.assign(new Error(`"${o.cron}" is not a valid cron expression.`), { status: 400, fix: 'Use 5 fields: minute hour day-of-month month day-of-week, e.g. "0 8 * * 1-5" for 8:00 on weekdays.' });
  const id = o.id ?? uid("sc_");
  if (getSchedule(id)) getDb().prepare("UPDATE schedules SET name=?, cron=?, goal=?, enabled=? WHERE id=?").run(o.name, o.cron, o.goal, o.enabled === false ? 0 : 1, id);
  else getDb().prepare("INSERT INTO schedules(id,name,cron,goal,enabled,created_at) VALUES(?,?,?,?,?,?)").run(id, o.name, o.cron, o.goal, o.enabled === false ? 0 : 1, now());
  syncSchedules(); return getSchedule(id)!;
}
export function deleteSchedule(id: string) { getDb().prepare("DELETE FROM schedules WHERE id=?").run(id); syncSchedules(); }
export function stopAllSchedules() { for (const t of tasks.values()) t.stop(); tasks.clear(); }
