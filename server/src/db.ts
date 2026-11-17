import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import path from "node:path";
import { cfg } from "./config.js";

export type DB = Database.Database;
let db: DB | undefined;
export let vecLoaded = false;

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New chat', gem_id TEXT, mode TEXT NOT NULL DEFAULT 'auto',
     private INTEGER NOT NULL DEFAULT 0, pinned_model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS messages (
     id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, parent_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL,
     meta TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
   CREATE TABLE IF NOT EXISTS route_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, task TEXT, model TEXT, provider TEXT, mode TEXT,
     confidence REAL, source TEXT, latency_ms INTEGER, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
     tps REAL, error TEXT, fallbacks TEXT, rating INTEGER DEFAULT 0, message_id TEXT);
   CREATE TABLE IF NOT EXISTS usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
     tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
     status INTEGER NOT NULL DEFAULT 200, cost_usd REAL NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'chat');
   CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
   CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS gems (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '✨', instructions TEXT NOT NULL DEFAULT '',
     pinned_model TEXT, lane TEXT, starters TEXT NOT NULL DEFAULT '[]', private INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS chunks (
     id INTEGER PRIMARY KEY AUTOINCREMENT, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, source_id TEXT,
     source_name TEXT, idx INTEGER NOT NULL, text TEXT NOT NULL, embedding BLOB, dim INTEGER);
   CREATE INDEX IF NOT EXISTS idx_chunks_owner ON chunks(owner_kind, owner_id);
   CREATE TABLE IF NOT EXISTS artifacts (
     id TEXT PRIMARY KEY, conversation_id TEXT, title TEXT, kind TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS artifact_versions (
     id INTEGER PRIMARY KEY AUTOINCREMENT, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS canvases (id TEXT PRIMARY KEY, title TEXT, kind TEXT NOT NULL DEFAULT 'markdown', conversation_id TEXT, updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS canvas_versions (
     id INTEGER PRIMARY KEY AUTOINCREMENT, canvas_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS notebooks (id TEXT PRIMARY KEY, title TEXT NOT NULL, private INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS notebook_sources (
     id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, url TEXT, text TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS notebook_outputs (
     id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT, data TEXT NOT NULL, file TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS cards (
     id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, front TEXT NOT NULL, back TEXT NOT NULL,
     ease REAL NOT NULL DEFAULT 2.5, interval INTEGER NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS media_jobs (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, backend TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL,
     progress REAL NOT NULL DEFAULT 0, outputs TEXT NOT NULL DEFAULT '[]', error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
   CREATE TABLE IF NOT EXISTS stories (id TEXT PRIMARY KEY, title TEXT, premise TEXT, data TEXT NOT NULL, pdf TEXT, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS agent_runs (
     id TEXT PRIMARY KEY, goal TEXT NOT NULL, status TEXT NOT NULL, result TEXT, schedule_id TEXT, created_at INTEGER NOT NULL, finished_at INTEGER);
   CREATE TABLE IF NOT EXISTS agent_steps (
     id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, n INTEGER NOT NULL, tool TEXT, args TEXT, result TEXT, screenshot TEXT, status TEXT NOT NULL, ts INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS approvals (
     id TEXT PRIMARY KEY, run_id TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL, payload TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, decided_at INTEGER);
   CREATE TABLE IF NOT EXISTS schedules (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, cron TEXT NOT NULL, goal TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_run INTEGER, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS inbox (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, ref TEXT, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS code_tasks (
     id TEXT PRIMARY KEY, repo TEXT NOT NULL, instruction TEXT NOT NULL, status TEXT NOT NULL, plan TEXT, branch TEXT, diff TEXT,
     log TEXT NOT NULL DEFAULT '[]', iterations INTEGER NOT NULL DEFAULT 0, sandbox TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS model_catalog (provider TEXT NOT NULL, model TEXT NOT NULL, meta TEXT, seen_at INTEGER NOT NULL, PRIMARY KEY(provider, model));
   CREATE TABLE IF NOT EXISTS ref_status (ref TEXT PRIMARY KEY, ok INTEGER NOT NULL, error TEXT, ms INTEGER, tools INTEGER, checked_at INTEGER NOT NULL);`,
  `ALTER TABLE conversations ADD COLUMN leaf_id TEXT;
   ALTER TABLE conversations ADD COLUMN allow_cloud INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE IF NOT EXISTS attachments (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL,
     path TEXT NOT NULL, text_path TEXT, pages TEXT, note TEXT, created_at INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS research (
     id TEXT PRIMARY KEY, query TEXT NOT NULL, deep INTEGER NOT NULL DEFAULT 0, answer TEXT NOT NULL DEFAULT '',
     sources TEXT NOT NULL DEFAULT '[]', steps TEXT NOT NULL DEFAULT '[]', followups TEXT NOT NULL DEFAULT '[]', model TEXT, created_at INTEGER NOT NULL);`,
];

export function openDb(file?: string): DB {
  if (db) return db;
  const target = file ?? path.join(cfg.DATA_DIR, "openmax.db");
  if (target !== ":memory:") fs.mkdirSync(path.dirname(target), { recursive: true });
  const d = new Database(target);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  try { sqliteVec.load(d); vecLoaded = true; } catch { vecLoaded = false; }
  d.exec("CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)");
  const done = new Set((d.prepare("SELECT n FROM _migrations").all() as { n: number }[]).map((r) => r.n));
  MIGRATIONS.forEach((sql, i) => {
    if (done.has(i)) return;
    d.transaction(() => { d.exec(sql); d.prepare("INSERT INTO _migrations(n) VALUES (?)").run(i); })();
  });
  db = d;
  return d;
}
export const getDb = () => openDb();
export function closeDb() { db?.close(); db = undefined; }

export const now = () => Date.now();
export const uid = (p = "") => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function getSetting<T>(key: string, fallback: T): T {
  const r = getDb().prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
  if (!r) return fallback;
  try { return JSON.parse(r.value) as T; } catch { return fallback; }
}
export function setSetting(key: string, value: unknown) {
  getDb().prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
}
