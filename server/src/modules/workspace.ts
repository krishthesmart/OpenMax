import fs from "node:fs";
import path from "node:path";
import { cfg } from "../config.js";
import { HttpError } from "../util/errors.js";

export const IGNORED = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "target", ".DS_Store", ".cache"]);
export const MAX_FILE_BYTES = 1_000_000;

export const workspaceRoot = () => { fs.mkdirSync(cfg.CODE_WORKSPACE, { recursive: true }); return fs.realpathSync(cfg.CODE_WORKSPACE); };

/**
 * Resolve a user-supplied relative path inside `root`, refusing anything that escapes it:
 * absolute paths, `..` traversal, NUL bytes, and symlinks that point outside.
 */
export function safeResolve(root: string, rel: string): string {
  if (typeof rel !== "string" || rel.includes("\0")) throw new HttpError(400, "Invalid path.");
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) throw new HttpError(400, "Absolute paths are not allowed; use a path relative to the workspace.");
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel);
  const within = (p: string) => p === realRoot || p.startsWith(realRoot + path.sep);
  if (!within(target)) throw new HttpError(400, "That path is outside the workspace.", "Paths must stay inside CODE_WORKSPACE.");
  // resolve symlinks of the deepest existing ancestor
  let probe = target;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const realProbe = fs.realpathSync(probe);
  if (!within(realProbe)) throw new HttpError(400, "That path resolves outside the workspace (symlink).");
  return target;
}

export interface TreeNode { name: string; path: string; type: "dir" | "file"; size?: number; children?: TreeNode[] }
export function listTree(root: string, rel = "", depth = 4): TreeNode[] {
  const abs = safeResolve(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return [];
  const entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !IGNORED.has(e.name) && !e.isSymbolicLink());
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return entries.map((e) => {
    const p = path.posix.join(rel.split(path.sep).join("/"), e.name);
    if (e.isDirectory()) return { name: e.name, path: p, type: "dir" as const, children: depth > 1 ? listTree(root, p, depth - 1) : [] };
    return { name: e.name, path: p, type: "file" as const, size: fs.statSync(path.join(abs, e.name)).size };
  });
}

export function readFile(root: string, rel: string): { path: string; content: string; size: number } {
  const abs = safeResolve(root, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HttpError(404, "File not found.");
  const st = fs.statSync(abs);
  if (st.size > MAX_FILE_BYTES) throw new HttpError(413, "File is larger than 1 MB.", "Open a smaller file.");
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) throw new HttpError(415, "This looks like a binary file.");
  return { path: rel, content: buf.toString("utf8"), size: st.size };
}
export function writeFile(root: string, rel: string, content: string) {
  const abs = safeResolve(root, rel);
  if (path.relative(root, abs) === "") throw new HttpError(400, "Not a file path.");
  if (Buffer.byteLength(content) > MAX_FILE_BYTES * 4) throw new HttpError(413, "Content is too large.");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
/** Deleting is irreversible: refuse unless the caller passes the explicit UI confirmation flag. */
export function deletePath(root: string, rel: string, confirm: boolean) {
  if (confirm !== true) throw new HttpError(409, "Deleting needs an explicit confirmation.", "Confirm the deletion in the UI.");
  const abs = safeResolve(root, rel);
  if (abs === fs.realpathSync(root)) throw new HttpError(400, "Refusing to delete the workspace root.");
  if (!fs.existsSync(abs)) throw new HttpError(404, "Not found.");
  fs.rmSync(abs, { recursive: true, force: true });
}

/** Short project outline for prompts. */
export function outline(root: string, max = 60): string {
  const lines: string[] = [];
  const walk = (nodes: TreeNode[], pad: string) => { for (const n of nodes) { if (lines.length >= max) return; lines.push(`${pad}${n.type === "dir" ? n.name + "/" : n.name}`); if (n.children) walk(n.children, pad + "  "); } };
  walk(listTree(root, "", 3), "");
  return lines.join("\n");
}
