import http from "node:http";
/** A tiny local shop: a search box, an email field, a password field and a "Place order" submit button. Counts POSTs. */
export function startTestPage(): Promise<{ url: string; posts: string[]; close: () => Promise<void> }> {
  const posts: string[] = [];
  const html = `<!doctype html><title>Test Shop</title><body><h1>Test Shop</h1><a href="/about">About</a>
<form method="post" action="/order"><label for="e">Email</label><input id="e" name="email"><input name="pw" type="password" aria-label="Password">
<input name="q" placeholder="note"><button type="submit">Place order</button></form></body>`;
  const srv = http.createServer((req, res) => {
    if (req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { posts.push(b); res.setHeader("content-type", "text/html"); res.end("<title>Thanks</title><h1>Order placed</h1>"); }); return; }
    res.setHeader("content-type", "text/html"); res.end(req.url === "/about" ? "<title>About</title><h1>About us</h1>" : html);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => { const port = (srv.address() as any).port; resolve({ url: `http://127.0.0.1:${port}/`, posts, close: () => new Promise<void>((r) => srv.close(() => r())) }); }));
}
