import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataPath } from "../../config.js";
import type { ElementInfo } from "./gates.js";

export interface PageView { url: string; title: string; text: string; elements: ElementInfo[] }
export interface BrowserDriver {
  open(url: string): Promise<PageView>;
  click(ref: number): Promise<PageView>;
  type(ref: number, text: string, opts?: { enter?: boolean; clear?: boolean }): Promise<PageView>;
  select(ref: number, value: string): Promise<PageView>;
  read(): Promise<PageView>;
  describe(ref: number): Promise<ElementInfo | undefined>;
  currentUrl(): string;
  screenshot(): Promise<Buffer | undefined>;
  close(): Promise<void>;
}

export function assertBrowsable(u: string): URL {
  let url: URL; try { url = new URL(u); } catch { throw new Error(`Not a valid URL: ${u}`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("The agent browser only opens http(s) pages.");
  if (/^(169\.254\.|metadata\.google|100\.100\.100\.200)/.test(url.hostname)) throw new Error("That address is blocked.");
  return url;
}

/** Find a Chromium Playwright can launch: PLAYWRIGHT_CHROMIUM_PATH, the default install, or any other installed Playwright Chromium build. */
export function findChromium(): string | undefined {
  const env = process.env.PLAYWRIGHT_CHROMIUM_PATH; if (env && fs.existsSync(env)) return env;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), "Library/Caches/ms-playwright"), path.join(os.homedir(), ".cache/ms-playwright")].filter(Boolean) as string[];
  const rels = ["chrome-headless-shell-mac-arm64/chrome-headless-shell", "chrome-headless-shell-mac-x64/chrome-headless-shell", "chrome-headless-shell-linux64/chrome-headless-shell", "chrome-linux/headless_shell", "chrome-linux/chrome"];
  const cands: string[] = [];
  for (const r of roots) { if (!fs.existsSync(r)) continue; for (const d of fs.readdirSync(r).filter((x) => /^chromium_headless_shell-\d+$/.test(x)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) for (const rel of rels) cands.push(path.join(r, d, rel)); }
  return cands.find((c) => fs.existsSync(c));
}

const ANNOTATE = `() => {
  const sel = 'a[href], button, input, select, textarea, [role=button], [role=link], [onclick]';
  const out = []; let n = 0;
  document.querySelectorAll('[data-om-ref]').forEach(e => e.removeAttribute('data-om-ref'));
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    if (el.type === 'hidden') continue;
    el.setAttribute('data-om-ref', String(++n));
    const label = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || '';
    out.push({ ref: n, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || undefined, text: (el.innerText || el.value || '').trim().slice(0, 80) || undefined, name: el.getAttribute('name') || el.id || undefined, label: label.trim().slice(0, 60) || undefined, placeholder: el.getAttribute('placeholder') || undefined, inForm: !!el.form, formAction: el.form ? el.form.action : undefined });
    if (n >= 80) break;
  }
  return { title: document.title, text: (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 5000), elements: out };
}`;

export class PlaywrightDriver implements BrowserDriver {
  private ctx: any; private page: any; private last: PageView = { url: "", title: "", text: "", elements: [] };
  private async ensure() {
    if (this.page) return;
    const { chromium } = await import("playwright");
    const dir = dataPath("browser-profile"); fs.mkdirSync(dir, { recursive: true });
    const exe = findChromium();
    const opts: any = { headless: true, viewport: { width: 1280, height: 800 }, acceptDownloads: false, ...(exe ? { executablePath: exe } : {}) };
    try { this.ctx = await chromium.launchPersistentContext(dir, opts); }
    catch (e: any) { throw Object.assign(new Error("Could not start the agent browser (isolated Chromium)."), { fix: `Run \`npx playwright install chromium\` once. (${String(e.message).split("\n")[0]})` }); }
    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    this.page.setDefaultTimeout(8000);
  }
  private async view(): Promise<PageView> {
    try { await this.page.waitForLoadState("domcontentloaded", { timeout: 5000 }); } catch { /* keep going */ }
    const a = await this.page.evaluate(`(${ANNOTATE})()`);
    this.last = { url: this.page.url(), ...a };
    return this.last;
  }
  currentUrl() { return this.page?.url?.() ?? ""; }
  async open(url: string) { assertBrowsable(url); await this.ensure(); await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }); return this.view(); }
  async read() { await this.ensure(); return this.view(); }
  async describe(ref: number) { return this.last.elements.find((e) => e.ref === ref); }
  private loc(ref: number) { return this.page.locator(`[data-om-ref="${ref}"]`).first(); }
  async click(ref: number) { await this.ensure(); await this.loc(ref).click({ timeout: 6000 }); await this.page.waitForTimeout(400); return this.view(); }
  async type(ref: number, text: string, o: { enter?: boolean; clear?: boolean } = {}) { await this.ensure(); const l = this.loc(ref); await l.fill(o.clear === false ? (await l.inputValue().catch(() => "")) + text : text); if (o.enter) await l.press("Enter"); await this.page.waitForTimeout(o.enter ? 400 : 50); return this.view(); }
  async select(ref: number, value: string) { await this.ensure(); await this.loc(ref).selectOption(value); return this.view(); }
  async screenshot() { try { return await this.page?.screenshot({ type: "png" }); } catch { return undefined; } }
  async close() { try { await this.ctx?.close(); } catch { /* ignore */ } this.ctx = undefined; this.page = undefined; }
}
