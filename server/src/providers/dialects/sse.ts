/** Minimal SSE / NDJSON line readers over a fetch Response body. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
      }
    }
    if (buf) yield buf;
  } finally {
    reader.releaseLock();
  }
}
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  let event: string | undefined;
  for await (const line of readLines(body)) {
    if (line === "") { event = undefined; continue; }
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) yield { event, data: line.slice(5).trim() };
  }
}
