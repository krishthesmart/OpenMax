import { getDb, getSetting, now, setSetting, uid } from "../../db.js";
import type { ApprovalKind } from "./gates.js";
import { redactCards } from "../../util/redact.js";

export interface Approval { id: string; run_id: string | null; kind: ApprovalKind; summary: string; payload: any; status: "pending" | "approved" | "rejected" | "cancelled" | "expired"; answer: string | null; created_at: number; decided_at: number | null }
const row = (r: any): Approval => ({ ...r, payload: JSON.parse(r.payload ?? "{}") });
export const getApproval = (id: string) => { const r = getDb().prepare("SELECT * FROM approvals WHERE id=?").get(id); return r ? row(r) : undefined; };
export const listApprovals = (status?: string) => (getDb().prepare(status ? "SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC LIMIT 200" : "SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200").all(...(status ? [status] : [])) as any[]).map(row);

type Waiter = (a: Approval) => void;
const waiters = new Map<string, Waiter>();
type Deferred = (a: Approval) => Promise<void>;
let deferredExecutor: Deferred | undefined;
export const setDeferredExecutor = (f: Deferred | undefined) => { deferredExecutor = f; };

export function createApproval(o: { runId?: string; kind: ApprovalKind; summary: string; payload: object }): Approval {
  const id = uid("ap_");
  getDb().prepare("INSERT INTO approvals(id,run_id,kind,summary,payload,status,created_at) VALUES(?,?,?,?,?,'pending',?)").run(id, o.runId ?? null, o.kind, redactCards(o.summary), redactCards(JSON.stringify(o.payload)), now());
  return getApproval(id)!;
}
/** Blocks until the user decides (or the run is aborted). The only way past a gate. */
export function waitForDecision(id: string, signal?: AbortSignal): Promise<Approval> {
  const cur = getApproval(id)!;
  if (cur.status !== "pending") return Promise.resolve(cur);
  return new Promise((resolve, reject) => {
    waiters.set(id, resolve);
    signal?.addEventListener("abort", () => { waiters.delete(id); getDb().prepare("UPDATE approvals SET status='cancelled', decided_at=? WHERE id=? AND status='pending'").run(now(), id); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}
/** Called from the HTTP route only: a human click. */
export async function decide(id: string, decision: "approve" | "reject", answer?: string): Promise<Approval> {
  const a = getApproval(id); if (!a) throw Object.assign(new Error("Approval not found."), { status: 404 });
  if (a.status !== "pending") throw Object.assign(new Error(`This request was already ${a.status}.`), { status: 409 });
  getDb().prepare("UPDATE approvals SET status=?, answer=?, decided_at=? WHERE id=?").run(decision === "approve" ? "approved" : "rejected", answer ? redactCards(answer).slice(0, 2000) : null, now(), id);
  const done = getApproval(id)!;
  const w = waiters.get(id);
  if (w) { waiters.delete(id); w(done); }
  else if (decision === "approve" && a.payload?.deferred && deferredExecutor) {
    // unattended run: nobody is waiting, so execute the approved action now (send_email / file_delete only)
    try { await deferredExecutor(done); } catch (e: any) { getDb().prepare("UPDATE approvals SET answer=? WHERE id=?").run(`Failed: ${e.message}`.slice(0, 500), id); }
  }
  return getApproval(id)!;
}
export const cancelRunApprovals = (runId: string) => { getDb().prepare("UPDATE approvals SET status='cancelled', decided_at=? WHERE run_id=? AND status='pending' AND json_extract(payload,'$.deferred') IS NOT 1").run(now(), runId); };
export const pendingCount = () => (getDb().prepare("SELECT COUNT(*) n FROM approvals WHERE status='pending'").get() as { n: number }).n;

export const knownRecipients = () => getSetting<string[]>("agent.knownRecipients", []);
export const rememberRecipients = (to: string[]) => setSetting("agent.knownRecipients", [...new Set([...knownRecipients(), ...to.map((x) => x.toLowerCase())])].slice(-500));
