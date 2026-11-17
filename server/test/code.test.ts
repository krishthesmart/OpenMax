import { afterAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshEnv } from "./helpers.js";
import { deletePath, listTree, readFile, safeResolve, writeFile } from "../src/modules/workspace.js";
import { buildCodeMessages, parseFileBlock, proseOutside, runCodeAction } from "../src/modules/codeActions.js";
import { setStubHandler } from "./fake.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "om-ws-"));
const root = path.join(base, "ws"); const outside = path.join(base, "outside");
fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("workspace path safety", () => {
  it("allows normal relative paths, including not-yet-existing files", () => {
    expect(safeResolve(root, "src/a.ts")).toBe(path.join(fs.realpathSync(root), "src/a.ts"));
    expect(safeResolve(root, "./x/../y.txt")).toBe(path.join(fs.realpathSync(root), "y.txt"));
  });
  it.each(["../outside/secret.txt", "a/../../outside/secret.txt", "/etc/passwd", "C:\\Windows\\win.ini", "ok\0.txt", "..", "src/../../.."])(
    "rejects escape attempt %j", (p) => { expect(() => safeResolve(root, p)).toThrow(); });
  it("rejects a symlink that points outside the workspace (read and write)", () => {
    fs.symlinkSync(outside, path.join(root, "link"));
    expect(() => readFile(root, "link/secret.txt")).toThrow(/outside/);
    expect(() => writeFile(root, "link/new.txt", "x")).toThrow(/outside/);
    expect(fs.existsSync(path.join(outside, "new.txt"))).toBe(false);
  });
  it("write/read round trip creates directories; tree hides node_modules and symlinks", () => {
    writeFile(root, "src/deep/a.ts", "export const a = 1;\n");
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true }); fs.writeFileSync(path.join(root, "node_modules/x.js"), "");
    expect(readFile(root, "src/deep/a.ts").content).toBe("export const a = 1;\n");
    const names = JSON.stringify(listTree(root));
    expect(names).toContain("a.ts"); expect(names).not.toContain("node_modules"); expect(names).not.toContain('"link"');
  });
  it("refuses binary files and oversize files", () => {
    fs.writeFileSync(path.join(root, "b.bin"), Buffer.from([1, 2, 0, 3]));
    expect(() => readFile(root, "b.bin")).toThrow(/binary/);
    fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(1_100_000));
    expect(() => readFile(root, "big.txt")).toThrow(/1 MB/);
  });
  it("deleting requires explicit confirmation and never the root", () => {
    writeFile(root, "del.txt", "x");
    expect(() => deletePath(root, "del.txt", false)).toThrow(/confirmation/);
    expect(fs.existsSync(path.join(root, "del.txt"))).toBe(true);
    expect(() => deletePath(root, ".", true)).toThrow(/root/);
    deletePath(root, "del.txt", true);
    expect(fs.existsSync(path.join(root, "del.txt"))).toBe(false);
  });
});

describe("file block parsing and actions", () => {
  beforeEach(() => freshEnv());
  it("parses ```file blocks with a path, prose before, and nested fences in content", () => {
    const t = "I fixed the off-by-one.\n```file path=src/a.ts\nconst x = `a`;\n```\n";
    expect(parseFileBlock(t)).toEqual({ path: "src/a.ts", content: "const x = `a`;\n" });
    expect(proseOutside(t)).toBe("I fixed the off-by-one.");
    const md = "```file path=README.md\n# T\n```js\ncode\n```\nend\n```";
    expect(parseFileBlock(md)!.content).toBe("# T\n```js\ncode\n```\nend\n");
  });
  it("returns undefined when there is no file block; tolerates a missing path and a missing closing fence", () => {
    expect(parseFileBlock("just prose")).toBeUndefined();
    expect(parseFileBlock("```file\nabc\n```")).toEqual({ path: undefined, content: "abc\n" });
    expect(parseFileBlock("```file path=a.py\nprint(1)")!.content).toBe("print(1)\n");
  });
  it("prompts differ per action; only non-explain actions request a file block", () => {
    const e = buildCodeMessages({ action: "explain", path: "a.ts", content: "x" })[0]!.content;
    const f = buildCodeMessages({ action: "fix", path: "a.ts", content: "x", instruction: "off by one" })[0]!.content;
    expect(e).not.toContain("```file"); expect(f).toContain("```file path=a.ts"); expect(f).toContain("off by one");
    expect(buildCodeMessages({ action: "custom", path: "a.ts", content: "x", instruction: "make it async" })[0]!.content).toContain("make it async");
  });
  it("routes to the code lane and streams the model reply", async () => {
    setStubHandler(() => "Done.\n```file path=a.ts\nfixed\n```");
    let text = "", model = "";
    for await (const ev of runCodeAction({ action: "fix", path: "a.ts", content: "bug" })) { if (ev.type === "text") text += ev.text; if (ev.type === "route") model = ev.info.task; }
    expect(model).toBe("code"); expect(parseFileBlock(text)!.content).toBe("fixed\n");
  });
});
