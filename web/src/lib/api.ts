export class ApiError extends Error { constructor(message: string, public fix?: string, public status = 0) { super(message); } }

function authHeaders(): Record<string, string> {
  const p = localStorage.getItem("om.password");
  return p ? { authorization: `Bearer ${p}` } : {};
}
async function parse(res: Response) {
  const text = await res.text();
  let j: any; try { j = text ? JSON.parse(text) : {}; } catch { j = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new ApiError(j.error ?? `Request failed (${res.status})`, j.fix, res.status);
  return j;
}
export const api = {
  get: <T = any>(url: string): Promise<T> => fetch(url, { headers: authHeaders() }).then(parse),
  post: <T = any>(url: string, body?: unknown): Promise<T> => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body ?? {}) }).then(parse),
  put: <T = any>(url: string, body?: unknown): Promise<T> => fetch(url, { method: "PUT", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body ?? {}) }).then(parse),
  del: <T = any>(url: string): Promise<T> => fetch(url, { method: "DELETE", headers: authHeaders() }).then(parse),
  upload: <T = any>(url: string, form: FormData): Promise<T> => fetch(url, { method: "POST", headers: authHeaders(), body: form }).then(parse),
};

/** POST that returns an SSE stream; calls onEvent for each event. Resolves when the stream ends. */
export async function streamPost(url: string, body: unknown, onEvent: (event: string, data: any) => void, signal?: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body ?? {}), signal });
  if (!res.ok || !res.body) await parse(res);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      let ev = "message", data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) { try { onEvent(ev, JSON.parse(data)); } catch { /* ignore */ } }
    }
  }
}
export function subscribeSSE(url: string, onEvent: (event: string, data: any) => void): () => void {
  const ac = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, { headers: authHeaders(), signal: ac.signal });
      if (!res.body) return;
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = "message", data = "";
          for (const line of block.split("\n")) { if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data += line.slice(5).trim(); }
          if (data) { try { onEvent(ev, JSON.parse(data)); } catch { /* ignore */ } }
        }
      }
    } catch { /* closed */ }
  })();
  return () => ac.abort();
}
