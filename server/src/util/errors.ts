import { ProviderError } from "../providers/types.js";
/** Turn any thrown value into a short, actionable message. Never returns a stack trace. */
export function friendlyError(e: unknown): { message: string; fix?: string; status?: number } {
  if (e instanceof ProviderError) return { message: e.message, fix: e.fix, status: e.status };
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|fetch failed/i.test(msg)) return { message: "A required local service is not reachable.", fix: "Check that Ollama / SearXNG / ComfyUI are running (see /api/health)." };
  if ((e instanceof Error && e.name === "AbortError") || /^(this operation was )?aborted\b/i.test(msg)) return { message: "Cancelled." };
  return { message: msg.split("\n")[0]!.slice(0, 300), fix: typeof (e as any)?.fix === "string" ? (e as any).fix : undefined, status: typeof (e as any)?.status === "number" ? (e as any).status : undefined };
}
export class HttpError extends Error {
  constructor(public status: number, message: string, public fix?: string) { super(message); }
}
