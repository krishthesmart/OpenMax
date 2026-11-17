import { beforeEach, describe, expect, it } from "vitest";
import { freshEnv } from "./helpers.js";
import { applyPatch, parseOps } from "../src/shared/patch.js";
import { createCanvas, editWithInstruction, getCanvas, listVersions, restoreVersion, saveContent, suggest, transform, validateSuggestions } from "../src/modules/canvas/canvas.js";
import { setStubHandler } from "../src/providers/stub.js";

const DOC = "# Title\n\nHello world.\nThis is a test.\nBye.";

describe("applyPatch", () => {
  it("replace (unique), delete, insert before/after, append, set", () => {
    expect(applyPatch(DOC, [{ op: "replace", find: "Hello world.", replace: "Hi!" }]).content).toBe("# Title\n\nHi!\nThis is a test.\nBye.");
    expect(applyPatch(DOC, [{ op: "delete", find: "This is a test.\n" }]).content).toBe("# Title\n\nHello world.\nBye.");
    expect(applyPatch(DOC, [{ op: "insert_after", anchor: "# Title", text: "\n\nSubtitle" }]).content.startsWith("# Title\n\nSubtitle\n\nHello")).toBe(true);
    expect(applyPatch(DOC, [{ op: "insert_before", anchor: "Bye.", text: "Well, " }]).content.endsWith("Well, Bye.")).toBe(true);
    expect(applyPatch("a", [{ op: "append", text: "b" }]).content).toBe("a\nb");
    expect(applyPatch(DOC, [{ op: "set", text: "new" }]).content).toBe("new");
  });
  it("replace_lines is 1-based inclusive and validates ranges", () => {
    expect(applyPatch("a\nb\nc\nd", [{ op: "replace_lines", start: 2, end: 3, text: "X" }]).content).toBe("a\nX\nd");
    expect(applyPatch("a\nb\nc", [{ op: "replace_lines", start: 2, end: 2, text: "" }]).content).toBe("a\nc");
    expect(applyPatch("a\nb", [{ op: "replace_lines", start: 5, end: 6, text: "x" }]).errors[0]).toMatch(/invalid line range/);
    expect(applyPatch("a\nb", [{ op: "replace_lines", start: 2, end: 1, text: "x" }]).ok).toBe(false);
  });
  it("rejects missing and ambiguous matches with actionable errors; all:true replaces every occurrence", () => {
    expect(applyPatch(DOC, [{ op: "replace", find: "nope", replace: "x" }]).errors[0]).toMatch(/not found/);
    const dup = "a b a";
    expect(applyPatch(dup, [{ op: "replace", find: "a", replace: "x" }]).errors[0]).toMatch(/appears 2 times/);
    expect(applyPatch(dup, [{ op: "replace", find: "a", replace: "x", all: true }]).content).toBe("x b x");
    expect(applyPatch(DOC, [{ op: "delete", find: "" }]).errors[0]).toMatch(/empty/);
  });
  it("is atomic: one bad op leaves the document untouched", () => {
    const r = applyPatch(DOC, [{ op: "replace", find: "Hello world.", replace: "Changed" }, { op: "replace", find: "missing", replace: "x" }]);
    expect(r.ok).toBe(false); expect(r.content).toBe(DOC); expect(r.applied).toBe(0);
  });
  it("later ops see earlier ops' results", () => {
    expect(applyPatch("one", [{ op: "replace", find: "one", replace: "two" }, { op: "replace", find: "two", replace: "three" }]).content).toBe("three");
  });
  it("parseOps drops malformed operations and explains why", () => {
    const { ops, dropped } = parseOps({ ops: [{ op: "replace", find: "a", replace: "b" }, { op: "replace", find: "a" }, { op: "explode" }, { op: "append", text: "t" }] });
    expect(ops).toHaveLength(2); expect(dropped).toHaveLength(2);
    expect(parseOps("garbage").ops).toEqual([]);
    expect(parseOps([{ op: "set", text: "x" }]).ops).toHaveLength(1);
  });
});

describe("canvas versions", () => {
  beforeEach(() => freshEnv());
  it("saves a version per real change, ignores no-ops, and restores old versions as new ones", () => {
    const c = createCanvas({ title: "Doc", content: "v1" });
    expect(c.version).toBe(1);
    saveContent(c.id, "v1"); expect(getCanvas(c.id)!.version).toBe(1);
    saveContent(c.id, "v2"); saveContent(c.id, "v3");
    expect(getCanvas(c.id)!.content).toBe("v3");
    const r = restoreVersion(c.id, 1);
    expect(r.content).toBe("v1"); expect(r.version).toBe(4);
    expect((listVersions(c.id) as any[]).map((v) => v.version)).toEqual([4, 3, 2, 1]);
    expect((listVersions(c.id) as any[])[0].note).toBe("Restored v1");
    expect(() => restoreVersion(c.id, 99)).toThrow(/not found/);
  });
});

describe("model-driven editing", () => {
  beforeEach(() => freshEnv());
  it("applies structured ops from the model as a new version with the model's summary", async () => {
    const c = createCanvas({ title: "Notes", kind: "markdown", content: DOC });
    setStubHandler(() => JSON.stringify({ summary: "Friendlier greeting", ops: [{ op: "replace", find: "Hello world.", replace: "Hello, friend!" }] }));
    const r = await editWithInstruction(c.id, "make the greeting friendlier");
    expect(r.changed).toBe(true); expect(r.canvas.content).toContain("Hello, friend!"); expect(r.canvas.version).toBe(2);
    expect((listVersions(c.id) as any[])[0].note).toBe("Friendlier greeting");
  });
  it("feeds failures back once and succeeds on the retry; gives a fix-it error after two failures", async () => {
    const c = createCanvas({ title: "Notes", content: DOC });
    let n = 0; let seenFeedback = "";
    setStubHandler((req) => { n++; seenFeedback = req.messages.at(-1)!.content; return JSON.stringify(n === 1 ? { ops: [{ op: "replace", find: "does not exist", replace: "x" }] } : { summary: "ok", ops: [{ op: "append", text: "The end." }] }); });
    const r = await editWithInstruction(c.id, "add an ending");
    expect(r.attempts).toBe(2); expect(seenFeedback).toMatch(/could not be applied/); expect(r.canvas.content.endsWith("The end.")).toBe(true);
    setStubHandler(() => '{"ops":[{"op":"delete","find":"zzz"}]}');
    await expect(editWithInstruction(c.id, "x?")).rejects.toMatchObject({ status: 422, fix: expect.stringContaining("specific") });
    expect(getCanvas(c.id)!.version).toBe(2);
  });
  it("selection is passed to the model; no-op edits do not create versions", async () => {
    const c = createCanvas({ title: "N", content: DOC }); let user = "";
    setStubHandler((req) => { user = req.messages.at(-1)!.content; return JSON.stringify({ ops: [{ op: "replace", find: "Bye.", replace: "Bye." }] }); });
    const r = await editWithInstruction(c.id, "leave it", { selection: "Bye." });
    expect(user).toContain("Selected text"); expect(r.changed).toBe(false); expect(getCanvas(c.id)!.version).toBe(1);
  });
  it("suggestions: only exact, unique, actually-different passages survive and nothing is applied", async () => {
    const c = createCanvas({ title: "N", content: "A cat sat. A cat ran. The dog barked." });
    expect(validateSuggestions(c.content, { suggestions: [{ find: "A cat", replace: "The cat" }, { find: "The dog barked.", replace: "The dog barked loudly.", why: "vivid" }, { find: "missing", replace: "x" }, { find: "The dog barked.", replace: "The dog barked." }] })).toHaveLength(1);
    setStubHandler(() => JSON.stringify({ suggestions: [{ find: "The dog barked.", replace: "The dog barked loudly.", why: "vivid" }] }));
    const s = await suggest(c.id, "");
    expect(s).toEqual([{ find: "The dog barked.", replace: "The dog barked loudly.", why: "vivid" }]);
    expect(getCanvas(c.id)!.version).toBe(1);
  });
  it("length/tone controls rewrite the selection only (or the whole doc) and record the action", async () => {
    const c = createCanvas({ title: "N", content: "Intro line.\nThe quick brown fox jumps over the lazy dog.\nOutro." });
    setStubHandler(() => "The fox jumps.");
    const a = await transform(c.id, { kind: "shorter" }, { selection: "The quick brown fox jumps over the lazy dog." });
    expect(a.content).toBe("Intro line.\nThe fox jumps.\nOutro.");
    setStubHandler(() => "```\nREWRITTEN\n```");
    const b = await transform(c.id, { kind: "tone", tone: "formal" });
    expect(b.content).toBe("REWRITTEN");
    expect((listVersions(c.id) as any[]).map((v) => v.note)).toEqual(["Tone: formal", "Made shorter (selection)", "Created"]);
  });
});
