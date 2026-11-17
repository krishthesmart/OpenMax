import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshEnv } from "./helpers.js";
import { setConfigForTest } from "../src/config.js";
import { composePrompt, PRESETS, dimsFor, enqueue, getJob, backendsInfo, deleteJob, listJobs, mediaDir, validateParams } from "../src/modules/media/index.js";
import { fillWorkflow, comfyBackend } from "../src/modules/media/comfy.js";
import { buildBody, snapSize } from "../src/modules/media/nvidiaImage.js";
import { falBackend } from "../src/modules/media/fal.js";
import { GpuScheduler } from "../src/modules/media/scheduler.js";
import { buildPdf, getStory, pagePrompt, startStory, validateStory } from "../src/modules/media/story.js";
import { setStubHandler, comfy, pngBuffer, nvidiaImage } from "./fake.js";
import { saveAttachment } from "../src/modules/attachments.js";

const waitFor = async (f: () => boolean, ms = 4000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 15)); } };
let tmpData: string;
beforeEach(() => { tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "om-media-")); freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "comfy" }); });
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
  it("the PNG fixture really is a PNG", () => { expect(pngBuffer(8, 8).subarray(1, 4).toString()).toBe("PNG"); });
});

describe("capabilities (grey out unsupported ops)", () => {
  it("comfy supports only ops with a workflow file (t2i ships); reasons explain how to enable; there is no fake backend", async () => {
    const info = await backendsInfo();
    expect(info.backends.map((b) => b.id)).toEqual(expect.arrayContaining(["comfy", "google-image"]));
    for (const gone of ["mock", "pollinations"]) expect(info.backends.some((b) => b.id === gone)).toBe(false);
    const ops = comfyBackend.ops();
    expect(ops.t2i.supported).toBe(true); // data/workflows/t2i.json ships with the app
    expect(ops.i2v.supported).toBe(false); expect(ops.i2v.reason).toMatch(/workflows\/i2v\.json/);
    const g = info.backends.find((b) => b.id === "google-image")!; expect(g.ops.t2v.supported).toBe(false); expect(g.ops.t2v.reason).toMatch(/stills/);
  });
  it("auto picks ComfyUI when running, else NVIDIA FLUX (NVIDIA key), else Gemini image (Gemini key), else reports ComfyUI as unreachable", async () => {
    freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "auto", GEMINI_API_KEY: "" });
    expect((await backendsInfo()).backends.find((b) => b.default)!.id).toBe("comfy");
    comfy.up = false; expect((await backendsInfo()).backends.find((b) => b.default)!.id).toBe("nvidia-image");
    freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "auto", NVIDIA_API_KEY: "", GEMINI_API_KEY: "k" }); comfy.up = false;
    expect((await backendsInfo()).backends.find((b) => b.default)!.id).toBe("google-image");
    freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "auto", NVIDIA_API_KEY: "", GEMINI_API_KEY: "" }); comfy.up = false;
    const down = (await backendsInfo()).backends.find((b) => b.default)!; expect(down.id).toBe("comfy"); expect(down.status.ok).toBe(false); expect(down.status.detail).toMatch(/503|not reachable/);
  });
  it("NVIDIA FLUX backend: stills only, sizes snapped to the API's allowed set, no seed sent, real image saved", async () => {
    freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "nvidia-image" });
    const ops = (await backendsInfo()).backends.find((b) => b.id === "nvidia-image")!.ops;
    expect(ops.t2i.supported).toBe(true); expect(ops.t2v.reason).toMatch(/stills/); expect(ops.edit.reason).toMatch(/ComfyUI|Gemini/);
    expect(snapSize(512)).toBe(768); expect(snapSize(1536)).toBe(1344); expect(snapSize(1000)).toBe(1024);
    expect(buildBody("black-forest-labs/flux.1-schnell", "x", 1024, 1024)).toEqual({ prompt: "x", width: 1024, height: 1024, steps: 4 });
    expect(buildBody("black-forest-labs/flux.1-dev", "x", 1024, 1024)).toMatchObject({ mode: "base", cfg_scale: 3.5, steps: 20 });
    const j = enqueue({ op: "t2i", prompt: "a lighthouse", aspect: "21:9", count: 2, presets: ["cinematic"], seed: 9, negative: "blurry" });
    await waitFor(() => getJob(j.id)!.status === "done", 8000);
    const done = getJob(j.id)!; expect(done.outputs).toHaveLength(2); expect(fs.readFileSync(done.outputs[0]!.file).subarray(1, 4).toString()).toBe("PNG");
    expect(nvidiaImage.posted).toHaveLength(2); const sent = nvidiaImage.posted[0]!;
    expect(sent.model).toBe("black-forest-labs/flux.1-schnell"); expect(sent.auth).toBe("Bearer k"); expect("seed" in sent.body).toBe(false);
    expect(sent.body.prompt).toContain("a lighthouse"); expect(sent.body.prompt).toContain("Avoid: blurry"); expect([768, 832, 896, 960, 1024, 1088, 1152, 1216, 1280, 1344]).toContain(sent.body.width);
  });
  it("NVIDIA image errors are explained: filtered prompt, rate limit, rejected key", async () => {
    freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "nvidia-image" });
    for (const [tag, re] of [["__filtered__", /filtered/], ["__quota__", /quota|rate limit/], ["__auth__", /rejected the API key/]] as const) {
      const j = enqueue({ op: "t2i", prompt: `x ${tag}`, aspect: "1:1", count: 1, presets: [] });
      await waitFor(() => getJob(j.id)!.status === "error", 8000); expect(getJob(j.id)!.error).toMatch(re);
    }
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
    expect(() => validateParams({ ...base, op: "i2v" })).toThrow(/cannot do "i2v"/);
    expect(() => validateParams({ ...base, backend: "comfy", op: "i2v", inputAttachmentId: "a" })).toThrow(/cannot do "i2v"/);
    fs.mkdirSync(path.join(tmpData, "workflows"), { recursive: true }); fs.writeFileSync(path.join(tmpData, "workflows", "i2v.json"), "{}");
    expect(() => validateParams({ ...base, backend: "comfy", op: "i2v" })).toThrow(/input image/);
    fs.writeFileSync(path.join(tmpData, "workflows", "v2v.json"), "{}");
    expect(() => validateParams({ ...base, backend: "comfy", op: "v2v", subop: "extend", prompt: "", inputAttachmentId: "a" })).not.toThrow();
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
  it("t2i job on ComfyUI with the shipped workflow: real PNG files, seeds increment, aspect sets the size, remixable params", async () => {
    const j = enqueue({ op: "t2i", prompt: "a lighthouse at dusk", aspect: "16:9", count: 3, presets: ["cinematic"], seed: 100 });
    expect(j.status).toBe("queued");
    await waitFor(() => getJob(j.id)!.status === "done", 8000);
    const done = getJob(j.id)!;
    expect(done.outputs.map((o) => o.seed)).toEqual([100, 101, 102]);
    expect(done.outputs[0]!.url).toMatch(new RegExp(`^/api/media/${j.id}/out-1\\.png$`));
    expect(fs.readFileSync(done.outputs[0]!.file).subarray(1, 4).toString()).toBe("PNG");
    expect(done.params.presets).toEqual(["cinematic"]);
    const g = comfy.posted.slice(-3); expect(g).toHaveLength(3);
    expect(g[0]["6"].inputs.text).toContain("a lighthouse at dusk"); expect(g[0]["6"].inputs.text).toContain("cinematic lighting");
    expect(g[0]["3"].inputs.seed).toBe(100); expect(g[2]["3"].inputs.seed).toBe(102); expect(g[0]["5"].inputs.width).toBeGreaterThan(g[0]["5"].inputs.height);
  });
  it("video via ComfyUI: workflow tokens are filled, the clip is downloaded, and checkpoints are unloaded after the queue drains", async () => {
    freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "comfy" });
    fs.mkdirSync(path.join(tmpData, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(tmpData, "workflows", "t2v.json"), JSON.stringify({ "1": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}" } }, "2": { class_type: "KSampler", inputs: { seed: "{{seed}}", w: "{{width}}", frames: "{{frames}}" } }, "9": { class_type: "VHS_VideoCombine", inputs: {} } }));
    const j = enqueue({ op: "t2v", prompt: "waves on a beach", aspect: "16:9", count: 1, duration: 3, presets: ["dolly_in"], seed: 5 });
    await waitFor(() => getJob(j.id)!.status === "done", 8000);
    const o = getJob(j.id)!.outputs[0]!; expect(o.kind).toBe("video"); expect(o.mime).toBe("video/mp4"); expect(fs.readFileSync(o.file, "utf8")).toBe("fixture-mp4-bytes");
    const g = comfy.posted.at(-1); expect(g["1"].inputs.text).toContain("waves on a beach"); expect(g["1"].inputs.text).toContain("dolly in"); expect(g["2"].inputs.seed).toBe(5); expect(g["2"].inputs.frames).toBe(73); expect(typeof g["2"].inputs.w).toBe("number");
    await waitFor(() => comfy.freed >= 1, 3000);
  });
  it("ComfyUI rejections surface the node error; image edit uploads the input and fills {{image}}", async () => {
    freshEnv({ DATA_DIR: tmpData, MEDIA_PROVIDER: "comfy" });
    fs.mkdirSync(path.join(tmpData, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(tmpData, "workflows", "t2i.json"), JSON.stringify({ "6": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}" } }, "9": { class_type: "SaveImage", inputs: {} } }));
    fs.writeFileSync(path.join(tmpData, "workflows", "edit.json"), JSON.stringify({ "6": { class_type: "CLIPTextEncode", inputs: { text: "{{prompt}}" } }, "7": { class_type: "LoadImage", inputs: { image: "{{image}}" } }, "9": { class_type: "SaveImage", inputs: {} } }));
    const bad = enqueue({ op: "t2i", prompt: "__reject__", aspect: "1:1", count: 1, presets: [] });
    await waitFor(() => getJob(bad.id)!.status === "error"); expect(getJob(bad.id)!.error).toMatch(/missing checkpoint/);
    const att = await saveAttachment("in.png", "image/png", pngBuffer(16, 16));
    const e = enqueue({ op: "edit", prompt: "make it night", aspect: "1:1", count: 1, presets: [], inputAttachmentId: att.id });
    await waitFor(() => getJob(e.id)!.status === "done", 8000);
    expect(comfy.posted.at(-1)["7"].inputs.image).toBe("uploaded.png"); expect(fs.readFileSync(getJob(e.id)!.outputs[0]!.file).subarray(1, 4).toString()).toBe("PNG");
  });
  it("video is refused when no workflow exists for it, and v2v/edit need an uploaded input", () => {
    expect(() => enqueue({ op: "t2v", prompt: "waves", aspect: "16:9", count: 1, duration: 3, presets: [] })).toThrow(/cannot do "t2v"/);
    expect(() => enqueue({ op: "v2v", subop: "restyle", prompt: "x", aspect: "16:9", count: 1, presets: [], backend: "comfy" })).toThrow();
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
  it("end to end: 10 illustrated pages from real image files and a real PDF", async () => {
    setStubHandler(() => storyJson(10));
    const id = startStory({ premise: "A mouse who wants to visit the moon" });
    await waitFor(() => ["done", "error"].includes(getStory(id)!.status), 25000);
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
