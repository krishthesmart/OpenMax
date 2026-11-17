import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { addRoutes } from "../app.js";
import { HttpError } from "../util/errors.js";
import { cancelTask, createBranchInRepo, createTask, decidePlan, deleteTask, getTask, listTasks, pushTask, retryTask } from "../modules/codeagent/tasks.js";

const must = (id: string) => { const t = getTask(id); if (!t) throw new HttpError(404, "Task not found."); return t; };
export function registerCodeTasks(app: FastifyInstance) {
  app.get("/api/code-tasks", async () => ({ tasks: listTasks() }));
  app.post("/api/code-tasks", async (req) => ({ task: createTask(z.object({ repo: z.string(), instruction: z.string(), localOnly: z.boolean().optional(), timeoutSec: z.number().optional() }).parse(req.body)) }));
  app.get("/api/code-tasks/:id", async (req) => ({ task: must((req.params as any).id) }));
  app.post("/api/code-tasks/:id/plan", async (req) => { const b = z.object({ decision: z.enum(["approve", "reject"]), testCommand: z.string().optional() }).parse(req.body); return { task: decidePlan((req.params as any).id, b.decision, b.testCommand) }; });
  app.post("/api/code-tasks/:id/cancel", async (req) => ({ cancelled: cancelTask((req.params as any).id) }));
  app.post("/api/code-tasks/:id/retry", async (req) => ({ task: retryTask((req.params as any).id) }));
  app.delete("/api/code-tasks/:id", async (req) => { deleteTask((req.params as any).id); return { ok: true }; });
  app.post("/api/code-tasks/:id/branch", async (req) => createBranchInRepo((req.params as any).id, (req.body as any)?.confirm === true));
  app.post("/api/code-tasks/:id/push", async (req) => { const b = z.object({ confirm: z.boolean().optional(), remote: z.string().optional() }).parse(req.body ?? {}); return { output: await pushTask((req.params as any).id, b.confirm === true, b.remote) }; });
}
addRoutes(registerCodeTasks);
