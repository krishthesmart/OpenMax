import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshEnv } from "./helpers.js";
import { setConfigForTest } from "../src/config.js";
import { composePrompt, PRESETS, dimsFor, enqueue, getJob, backendsInfo, deleteJob, listJobs, mediaDir, validateParams, mockSvg } from "../src/modules/media/index.js";
import { fillWorkflow, comfyBackend } from "../src/modules/media/comfy.js";
import { falBackend } from "../src/modules/media/fal.js";
import { GpuScheduler } from "../src/modules/media/scheduler.js";
import { buildPdf, getStory, pagePrompt, startStory, validateStory } from "../src/modules/media/story.js";
import { setStubHandler } from "../src/providers/stub.js";
import { saveAttachment } from "../src/modules/attachments.js";

const waitFor = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 15)); } };
let tmpData: string;
beforeEach(() => { tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "om-media-")); freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "mock" }); });
afterEach(() => fs.rmSync(tmpData, { recursive: true, force: true }));

describe("presets and dimensions", () => {
  it("has ~18 presets covering motion and style", () => {
    expect(PRESETS.length).toBe(18);
    for (const id of ["static", "dolly_in", "dolly_out", "orbit", "crane", "pan_left", "pan_right", "handheld", "fpv", "bullet_time", "crash_zoom", "rack_focus", "timelapse", "slow_mo", "cinematic", "anime", "noir", "product"]) expect(PRESETS.some((p) => p.id === id)).toBe(true);
  });
  it("composes prompt + negatives and video-edit prefixes", () => {
    const c = composePrompt("a fox", ["dolly_in", "noir"]);
    expect(c.prompt).toContain("a fox"); expect(c.prompt).toContain("dolly in"); expect(c.prompt).toContain("film noir");
    expect(c.negative).toContain("color");
    expect(composePrompt("neon city", [], "restyle").prompt.startsWith("Restyle")).toBe(true);
  });
  it("aspect → multiples of 64 near the pixel budget", () => {
    const { width, height } = dimsFor("16:9", false);
    expect(width % 64).toBe(0); expect(height % 64).toBe(0); expect(width).toBeGreaterThan(height);
    expect(dimsFor("9:16", true).height).toBeGreaterThan(dimsFor("9:16", true).width);
  });
  it("mock svg is deterministic per (prompt, seed) and animated for video", () => {
    const a = mockSvg({ prompt: "x", seed: 1, width: 320, height: 200 });
    expect(a).toBe(mockSvg({ prompt: "x", seed: 1, width: 320, height: 200 }));
    expect(a).not.toBe(mockSvg({ prompt: "x", seed: 2, width: 320, height: 200 }));
    expect(mockSvg({ prompt: "x", seed: 1, width: 320, height: 200, animated: true, anim: "zoom-in" })).toContain("<animateTransform");
  });
});

describe("capabilities (grey out unsupported ops)", () => {
  it("mock supports everything; comfy only ops with a workflow file; reasons explain how to enable", async () => {
    const info = await backendsInfo();
    const mock = info.backends.find((b) => b.id === "mock")!; expect(Object.values(mock.ops).every((o) => o.supported)).toBe(true);
    fs.mkdirSync(path.join(tmpData, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(tmpData, "workflows", "t2i.json"), "{}");
    const ops = comfyBackend.ops();
    expect(ops.t2i.supported).toBe(true);
    expect(ops.i2v.supported).toBe(false); expect(ops.i2v.reason).toMatch(/workflows\/i2v\.json/);
  });
  it("fal is hidden without ENABLE_PAID and has no v2v", async () => {
    expect((await backendsInfo()).backends.some((b) => b.id === "fal")).toBe(false);
    freshEnv({ DATA_DIR: tmpData, ENABLE_PAID: true, FAL_KEY: "k" });
    expect((await backendsInfo()).backends.some((b) => b.id === "fal")).toBe(true);
    expect(falBackend.ops().v2v.supported).toBe(false);
  });
  it("validateParams rejects unsupported/invalid requests with clear messages", () => {
    const base = { op: "t2i", prompt: "x", aspect: "1:1", count: 1, presets: [] } as any;
    expect(() => validateParams({ ...base, count: 9 })).toThrow(/Count/);
    expect(() => validateParams({ ...base, prompt: "" })).toThrow(/prompt/);
    expect(() => validateParams({ ...base, aspect: "5:7" })).toThrow(/aspect/);
    expect(() => validateParams({ ...base, op: "i2v" })).toThrow(/input image/);
    expect(() => validateParams({ ...base, backend: "comfy", op: "i2v", inputAttachmentId: "a" })).toThrow(/cannot do "i2v"/);
    expect(() => validateParams({ ...base, op: "v2v", subop: "extend", prompt: "", inputAttachmentId: "a" })).not.toThrow();
  });
});

describe("comfy workflow templating", () => {
  it("whole-string tokens keep native types; embedded tokens interpolate; unknown tokens stay", () => {
    const out: any = fillWorkflow({ a: { seed: "{{seed}}", w: "{{width}}", text: "{{prompt}} in {{style}}", pass: "{{unknown}}", list: ["{{frames}}", 5] } }, { seed: 7, width: 640, prompt: "a cat", frames: 49, style: "ink" });
    expect(out.a).toEqual({ seed: 7, w: 640, text: "a cat in ink", pass: "{{unknown}}", list: [49, 5] });
  });
});

describe("jobs and GPU scheduler", () => {
  it("scheduler runs GPU jobs one at a time, in order, and unloads after the queue drains", async () => {
    const s = new GpuScheduler(); const log: string[] = []; let live = 0, maxLive = 0;
    const job = (n: string) => () => (async () => { live++; maxLive = Math.max(maxLive, live); log.push(`start ${n}`); await new Promise((r) => setTimeout(r, 15)); log.push(`end ${n}`); live--; return n; })();
    const res = await Promise.all([s.runExclusive(job("a"), async () => { log.push("unload"); }), s.runExclusive(job("b"), async () => { log.push("unload"); }), s.runExclusive(job("c"), async () => { log.push("unload"); })]);
    expect(res).toEqual(["a", "b", "c"]); expect(maxLive).toBe(1);
    expect(log.filter((l) => l.startsWith("start"))).toEqual(["start a", "start b", "start c"]);
    expect(log.filter((l) => l === "unload")).toHaveLength(1); expect(log.at(-1)).toBe("unload");
  });
  it("scheduler keeps going after a failed job", async () => {
    const s = new GpuScheduler();
    await expect(s.runExclusive(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await s.runExclusive(async () => 5)).toBe(5);
  });
  it("t2i job: queued → done with count outputs, seeds increment, files served path, remixable params", async () => {
    const j = enqueue({ op: "t2i", prompt: "a lighthouse at dusk", aspect: "16:9", count: 3, presets: ["cinematic"], seed: 100 });
    expect(j.status).toBe("queued");
    await waitFor(() => getJob(j.id)!.status === "done");
    const done = getJob(j.id)!;
    expect(done.outputs.map((o) => o.seed)).toEqual([100, 101, 102]);
    expect(done.outputs[0]!.url).toMatch(new RegExp(`^/api/media/${j.id}/out-1\\.svg$`));
    expect(fs.existsSync(done.outputs[0]!.file)).toBe(true);
    expect(done.params.presets).toEqual(["cinematic"]);
  });
  it("video job (t2v) produces an animated clip; v2v/edit need an uploaded input", async () => {
    const j = enqueue({ op: "t2v", prompt: "waves", aspect: "16:9", count: 1, duration: 3, presets: ["pan_left"] });
    await waitFor(() => getJob(j.id)!.status === "done");
    const o = getJob(j.id)!.outputs[0]!; expect(o.kind).toBe("video");
    expect(fs.readFileSync(o.file, "utf8")).toContain("animateTransform");
    expect(() => enqueue({ op: "v2v", subop: "restyle", prompt: "x", aspect: "16:9", count: 1, presets: [] })).toThrow(/input video/);
    const att = await saveAttachment("clip.png", "image/png", Buffer.from("x"));
    const e = enqueue({ op: "edit", prompt: "make it night", aspect: "1:1", count: 1, presets: [], inputAttachmentId: att.id });
    await waitFor(() => getJob(e.id)!.status === "done");
  });
  it("delete removes the row and its files", async () => {
    const j = enqueue({ op: "t2i", prompt: "x", aspect: "1:1", count: 1, presets: [] });
    await waitFor(() => getJob(j.id)!.status === "done");
    const dir = path.join(mediaDir(), j.id); expect(fs.existsSync(dir)).toBe(true);
    deleteJob(j.id); expect(fs.existsSync(dir)).toBe(false); expect(listJobs().some((x) => x.id === j.id)).toBe(false);
  });
});

describe("storybook", () => {
  const storyJson = (n: number) => JSON.stringify({
    title: "Pip and the Moon", style: "soft watercolor picture book",
    characters: [{ name: "Pip", look: "a small round grey mouse with a red scarf and big round ears" }, { name: "Luna", look: "a gentle white owl with silver-tipped wings" }],
    pages: Array.from({ length: n }, (_, i) => ({ text: `Page ${i + 1}: Pip walked on.`, scene: `Pip in scene ${i + 1}`, characters: i % 2 ? ["Pip", "Luna"] : ["Pip"] })),
  });
  it("validates stories and keeps character looks verbatim in every page prompt", () => {
    const s = validateStory(JSON.parse(storyJson(10)));
    expect(s.pages).toHaveLength(10);
    const p1 = pagePrompt(s, s.pages[0]!), p2 = pagePrompt(s, s.pages[1]!);
    expect(p1).toContain("a small round grey mouse with a red scarf"); expect(p2).toContain("a small round grey mouse with a red scarf"); expect(p2).toContain("silver-tipped wings");
    expect(p1).not.toContain("silver-tipped");
    expect(() => validateStory({ pages: [{ text: "a" }] })).toThrow(/at least 3 pages/);
    expect(() => validateStory({ pages: [{ text: "a" }, { text: "b" }, { text: "c" }] })).toThrow(/character/);
  });
  it("end to end with the mock backend: 10 illustrated pages and a real PDF", async () => {
    setStubHandler(() => storyJson(10));
    const id = startStory({ premise: "A mouse who wants to visit the moon" });
    await waitFor(() => ["done", "error"].includes(getStory(id)!.status), 10000);
    const s = getStory(id)!;
    expect(s.error).toBeUndefined(); expect(s.status).toBe("done");
    expect(s.pages).toHaveLength(10); expect(s.pages.every((pg: { image?: string }) => pg.image)).toBe(true);
    const pdf = path.join(mediaDir(), `story-${id}`, "storybook.pdf");
    const buf = fs.readFileSync(pdf); expect(buf.subarray(0, 4).toString()).toBe("%PDF");
    expect((buf.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(11); // title + 10 pages
  });
  it("reports a clear error when the model returns an unusable story", async () => {
    setStubHandler(() => '{"title":"x"}');
    const id = startStory({ premise: "anything at all" });
    await waitFor(() => getStory(id)!.status === "error");
    expect(getStory(id)!.error).toMatch(/usable story/);
  });
  it("pdf builder tolerates a missing illustration", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "om-pdf-"));
    await buildPdf(dir, { title: "T", style: "", pages: [{ text: "hello", scene: "s", characters: [] }] }, path.join(dir, "o.pdf"));
    expect(fs.statSync(path.join(dir, "o.pdf")).size).toBeGreaterThan(500);
  });
});
void setConfigForTest;
