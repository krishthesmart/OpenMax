import type { FastifyReply, FastifyRequest } from "fastify";

export interface SSE { send(event: string, data: unknown): void; end(): void; signal: AbortSignal; closed: boolean }

/** Open an SSE response. The signal aborts when the client disconnects, so upstream streams are cleaned up. */
export function openSSE(req: FastifyRequest, reply: FastifyReply): SSE {
  const ac = new AbortController();
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform",
    connection: "keep-alive", "x-accel-buffering": "no",
  });
  const s: SSE = {
    signal: ac.signal, closed: false,
    send(event, data) { if (!s.closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    end() { if (!s.closed) { s.closed = true; res.end(); } },
  };
  res.on("close", () => { s.closed = true; ac.abort(); });
  const ping = setInterval(() => { if (!s.closed) res.write(": ping\n\n"); }, 15000);
  res.on("close", () => clearInterval(ping));
  void req;
  return s;
}
