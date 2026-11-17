/** GPU scheduler: GPU media jobs are exclusive (one at a time); LLM calls never go through it, so they interleave freely. */
export class GpuScheduler {
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0; private queued = 0;
  state() { return { active: this.active, queued: this.queued }; }
  runExclusive<T>(fn: () => Promise<T>, afterIdle?: () => Promise<void>): Promise<T> {
    this.queued++;
    const run = async () => {
      this.queued--; this.active++;
      try { return await fn(); }
      finally {
        this.active--;
        if (this.active === 0 && this.queued === 0 && afterIdle) await afterIdle().catch(() => {}); // unload checkpoints once the queue drains
      }
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => {});
    return p;
  }
}
export const gpu = new GpuScheduler();
