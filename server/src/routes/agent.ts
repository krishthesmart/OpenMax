import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { z } from "zod";
import { addRoutes } from "../app.js";
import { HttpError } from "../util/errors.js";
import { openSSE } from "../util/sse.js";
import { getRun, listRuns, runApprovals, runSteps, shotPath, startRun, startWide, stopRun, subscribe } from "../modules/agent/agent.js";
import { getDeliverable, listDeliverables, resolveDeliverable } from "../modules/agent/deliverables.js";
import { sandboxAvailable } from "../modules/agent/sandbox.js";
import { decide, getApproval, listApprovals, pendingCount } from "../modules/agent/approvals.js";
import { deleteSchedule, getSchedule, listSchedules, saveSchedule, trigger } from "../modules/agent/scheduler.js";
import { addInbox, deleteInbox, listInbox, markRead, unreadCount } from "../modules/inbox.js";

export function registerAgent(app: FastifyInstance) {
  app.post("/api/agent/runs", async (req) => { const b = z.object({ goal: z.string().min(3).max(4000), long: z.boolean().optional() }).parse(req.body); return { id: startRun({ goal: b.goal, long: b.long }) }; });
  app.post("/api/agent/wide", async (req) => { const b = z.object({ items: z.array(z.string()).min(1).max(200), task: z.string().min(5).max(2000), columns: z.array(z.string()).max(12).optional() }).parse(req.body); return { id: startWide(b) }; });
  app.get("/api/agent/capabilities", async () => ({ sandbox: sandboxAvailable(), note: sandboxAvailable() ? "Code runs in a macOS sandbox: writes confined to the run workspace, no network unless approved." : "No OS sandbox on this platform: every shell command needs your approval." }));
  app.get("/api/agent/runs", async () => ({ runs: listRuns() }));
  app.get("/api/agent/runs/:id", async (req) => { const id = (req.params as any).id; const run = getRun(id); if (!run) throw new HttpError(404, "Run not found."); return { run: { ...run, plan: run.plan ? JSON.parse(run.plan) : null }, steps: runSteps(id), approvals: runApprovals(id), deliverables: listDeliverables(id) }; });
  app.post("/api/agent/runs/:id/stop", async (req) => ({ stopped: stopRun((req.params as any).id) }));
  app.get("/api/agent/runs/:id/events", async (req, reply) => {
    const id = (req.params as any).id; const run = getRun(id); if (!run) throw new HttpError(404, "Run not found.");
    const sse = openSSE(req, reply);
    sse.send("snapshot", { run, steps: runSteps(id), approvals: runApprovals(id) });
    const off = subscribe(id, (e) => { sse.send(e.type, e.data); if (e.type === "done" || e.type === "error") { off?.(); sse.end(); } });
    if (!off) { sse.end(); return; }
    sse.signal.addEventListener("abort", () => off());
  });
  /** Deliverables: files the agent produced. Served from an opaque-origin sandbox (CSP) so agent-written HTML can never touch this app's API or cookies. */
  const serveDeliverable = async (req: any, reply: any) => {
    const d = getDeliverable(req.params.id); if (!d) throw new HttpError(404, "Deliverable not found.");
    const r = resolveDeliverable(d, req.params["*"] || undefined); if (!r) throw new HttpError(404, "File not found in this deliverable.");
    const inline = /^(text\/(html|plain|markdown|csv|css|javascript)|image\/|application\/(pdf|json)|audio\/|video\/)/.test(r.mime) && !(req.query as any).download;
    reply.header("content-security-policy", "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob: 'unsafe-inline'; connect-src 'self'").header("x-content-type-options", "nosniff")
      .header("content-disposition", `${inline ? "inline" : "attachment"}; filename="${r.file.split("/").pop()!.replace(/"/g, "")}"`);
    return reply.type(r.mime).send(fs.createReadStream(r.file));
  };
  app.get("/api/agent/deliverables/:id", serveDeliverable);
  app.get("/api/agent/deliverables/:id/*", serveDeliverable);
  app.get("/api/agent/shots/:run/:file", async (req, reply) => { const p = req.params as any; const f = shotPath(p.run, p.file); if (!f) throw new HttpError(404, "Screenshot not found."); return reply.type("image/png").send(fs.createReadStream(f)); });

  // Approvals: the ONLY way a gated action proceeds is a human POST here.
  app.get("/api/approvals", async (req) => ({ approvals: listApprovals((req.query as any).status), pending: pendingCount() }));
  app.post("/api/approvals/:id", async (req) => {
    const b = z.object({ decision: z.enum(["approve", "reject"]), answer: z.string().optional() }).parse(req.body);
    const a = getApproval((req.params as any).id); if (!a) throw new HttpError(404, "Approval not found.");
    return { approval: await decide(a.id, b.decision, b.answer) };
  });

  // Schedules
  app.get("/api/schedules", async () => ({ schedules: listSchedules() }));
  app.post("/api/schedules", async (req) => ({ schedule: saveSchedule(z.object({ id: z.string().optional(), name: z.string().min(1), cron: z.string(), goal: z.string().min(3), enabled: z.boolean().optional() }).parse(req.body)) }));
  app.delete("/api/schedules/:id", async (req) => { deleteSchedule((req.params as any).id); return { ok: true }; });
  app.post("/api/schedules/:id/run", async (req) => { const id = (req.params as any).id; if (!getSchedule(id)) throw new HttpError(404, "Schedule not found."); return { runId: trigger(id) }; });

  // Inbox
  app.get("/api/inbox", async () => ({ items: listInbox(), unread: unreadCount(), pendingApprovals: pendingCount() }));
  app.get("/api/inbox/count", async () => ({ unread: unreadCount(), pendingApprovals: pendingCount() }));
  app.post("/api/inbox/:id/read", async (req) => { markRead((req.params as any).id, (req.body as any)?.read !== false); return { ok: true }; });
  app.delete("/api/inbox/:id", async (req) => { deleteInbox((req.params as any).id); return { ok: true }; });
  void addInbox;
}
addRoutes(registerAgent);
