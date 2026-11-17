import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshEnv } from "./helpers.js";
import { nextReview } from "../src/modules/notebook/sm2.js";
import { locatePassage } from "../src/modules/notebook/locate.js";
import { parseCaptionTracks, parseTimedText, youtubeId } from "../src/modules/notebook/youtube.js";
import { NOT_IN_SOURCES, addSource, buildCitations, createNotebook, listSources, notebookChat, removeSource } from "../src/modules/notebook/notebook.js";
import { buildAudio, buildPptx, generate, parseWav, wavConcat, validateCards, validateMindmap, validateQuiz, validateScript, validateSlides } from "../src/modules/notebook/generators.js";
import { retrieve } from "../src/modules/rag.js";
import { setStubHandler } from "../src/providers/stub.js";
import { getDb } from "../src/db.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "om-nb-")); freshEnv({ DATA_DIR: tmp }); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
const collect = async (g: AsyncGenerator<{ event: string; data: any }>) => { const o: { event: string; data: any }[] = []; for await (const e of g) o.push(e); return o; };

const CATS = "Cats are obligate carnivores. They sleep between twelve and sixteen hours every day. A group of kittens is called a kindle.";
const TAX = "In Canada the personal income tax filing deadline is April thirtieth. Late filers pay a penalty of five percent of the balance owing.";

describe("spaced repetition (SM-2)", () => {
  it("grows intervals 1 → 6 → ×ease and adjusts ease", () => {
    const t = 0; let c = { ease: 2.5, interval: 0, reps: 0 };
    const a = nextReview(c, 5, t); expect(a).toMatchObject({ interval: 1, reps: 1 }); expect(a.due).toBe(86_400_000); expect(a.ease).toBe(2.6);
    const b = nextReview(a, 5, t); expect(b).toMatchObject({ interval: 6, reps: 2 });
    const d = nextReview(b, 4, t); expect(d.interval).toBe(Math.round(6 * b.ease)); expect(d.ease).toBe(b.ease);
    void c;
  });
  it("a failed review resets progress, lowers ease (min 1.3) and returns in 10 minutes", () => {
    const f = nextReview({ ease: 1.35, interval: 30, reps: 5 }, 1, 1000);
    expect(f).toMatchObject({ reps: 0, interval: 0, ease: 1.3 }); expect(f.due).toBe(1000 + 600_000);
  });
  it("quality 3 passes but lowers ease", () => { expect(nextReview({ ease: 2.5, interval: 0, reps: 0 }, 3, 0).ease).toBeLessThan(2.5); });
});

describe("passage location", () => {
  it("finds a chunk in its source regardless of whitespace/case", () => {
    const src = "Intro text.\n\nCats   are obligate\ncarnivores. They sleep a lot.\n\nOutro.";
    const loc = locatePassage(src, "cats are obligate carnivores. they sleep a lot.")!;
    expect(src.slice(loc.start, loc.end)).toMatch(/^Cats\s+are obligate\s+carnivores\. They sleep a lot\.$/);
    expect(locatePassage(src, "completely different text")).toBeUndefined();
  });
});

describe("youtube", () => {
  it("extracts ids from common URL shapes", () => {
    expect(youtubeId("https://www.youtube.com/watch?v=abc123XYZ_-")).toBe("abc123XYZ_-");
    expect(youtubeId("https://youtu.be/abc123")).toBe("abc123");
    expect(youtubeId("https://www.youtube.com/shorts/abcdef12")).toBe("abcdef12");
    expect(youtubeId("https://example.com/watch?v=1")).toBeUndefined();
  });
  it("parses caption tracks and timed text (json3 and xml)", () => {
    const html = 'x"captionTracks":[{"baseUrl":"https://yt/api?a=1\\u0026b=2","languageCode":"en","kind":"asr"},{"baseUrl":"https://yt/en","languageCode":"en"}],"audioTracks"';
    const t = parseCaptionTracks(html); expect(t).toHaveLength(2); expect(t[0]!.baseUrl).toBe("https://yt/api?a=1&b=2"); expect(t[0]!.auto).toBe(true);
    expect(parseTimedText(JSON.stringify({ events: [{ segs: [{ utf8: "Hello " }, { utf8: "world" }] }, { segs: [{ utf8: "\nagain" }] }] }))).toBe("Hello world again");
    expect(parseTimedText('<transcript><text start="0">Tom &amp; Jerry</text><text>Hi</text></transcript>')).toBe("Tom & Jerry Hi");
  });
});

describe("notebook sources + grounded chat", () => {
  it("indexes text sources and removes them cleanly", async () => {
    const nb = createNotebook("Pets");
    const s = await addSource(nb.id, { kind: "text", name: "cats.txt", text: CATS });
    expect(listSources(nb.id)).toHaveLength(1);
    expect((await retrieve({ kind: "notebook", id: nb.id }, "how much do cats sleep", 1))[0]!.text).toContain("sixteen");
    removeSource(nb.id, s.id);
    expect(listSources(nb.id)).toHaveLength(0);
    expect(await retrieve({ kind: "notebook", id: nb.id }, "cats", 3)).toEqual([]);
    await expect(addSource(nb.id, { kind: "text", text: "hi" })).rejects.toThrow(/almost no text/);
  });
  it("answers only from retrieved excerpts, keeps valid citations with passage offsets, drops invented ones", async () => {
    const nb = createNotebook("Mixed");
    await addSource(nb.id, { kind: "text", name: "cats.txt", text: CATS });
    await addSource(nb.id, { kind: "text", name: "tax.txt", text: TAX });
    let sys = "";
    setStubHandler((req) => { sys = req.messages[0]!.content; return "Cats sleep twelve to sixteen hours [1][7]."; });
    const ev = await collect(notebookChat({ notebookId: nb.id, question: "How long do cats sleep?" }));
    expect(sys).toContain("ONLY the numbered source excerpts"); expect(sys).toContain("SOURCE EXCERPTS");
    const done = ev.find((e) => e.event === "done")!.data;
    expect(done.text).toBe("Cats sleep twelve to sixteen hours [1].");
    expect(done.citations).toHaveLength(1);
    const c = done.citations[0];
    expect(c.source).toBeTruthy(); expect(c.start).toBeGreaterThanOrEqual(0); expect(c.end).toBeGreaterThan(c.start);
    expect(done.grounded).toBe(true);
  });
  it("flags an answer with no citations as ungrounded; refuses when the notebook has no sources", async () => {
    const nb = createNotebook("Empty");
    const none = await collect(notebookChat({ notebookId: nb.id, question: "anything?" }));
    expect(none.find((e) => e.event === "done")!.data.text).toBe(NOT_IN_SOURCES);
    await addSource(nb.id, { kind: "text", name: "cats.txt", text: CATS });
    setStubHandler(() => "Cats are amazing and the moon is far away.");
    const ev = await collect(notebookChat({ notebookId: nb.id, question: "tell me things" }));
    expect(ev.find((e) => e.event === "done")!.data.grounded).toBe(false);
  });
  it("private notebooks never call a cloud model (chat and generators)", async () => {
    const nb = createNotebook("Secret", true);
    await addSource(nb.id, { kind: "text", name: "memo.txt", text: CATS });
    const seen: string[] = [];
    setStubHandler((_r, p, m) => { seen.push(`${p}:${m}`); return '{"cards":[{"front":"a","back":"b"},{"front":"c","back":"d"}]}'; });
    await collect(notebookChat({ notebookId: nb.id, question: "cats sleep?" }));
    await generate(nb.id, "flashcards");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((s) => s.startsWith("ollama:"))).toBe(true);
  });
  it("citation builder maps hits to source ids and offsets", async () => {
    const nb = createNotebook("X"); await addSource(nb.id, { kind: "text", name: "cats.txt", text: CATS });
    const hits = await retrieve({ kind: "notebook", id: nb.id }, "kittens", 2);
    const cites = buildCitations(nb.id, hits);
    expect(cites[0]).toMatchObject({ n: 1, source: "cats.txt" }); expect(cites[0]!.sourceId).toBeTruthy();
  });
});

describe("generators", () => {
  it("validators accept good data and reject junk", () => {
    expect(validateQuiz({ questions: [{ q: "A?", options: ["x", "y", "z", "w"], answer: "y" }, { q: "B?", options: ["1", "2"], answer: 0 }] }).questions[0]!.answer).toBe(1);
    expect(() => validateQuiz({ questions: [{ q: "A?", options: ["x"], answer: 0 }] })).toThrow(/usable quiz/);
    expect(validateCards({ cards: [{ q: "f", a: "b" }, { front: "f2", back: "b2" }] }).cards).toHaveLength(2);
    expect(() => validateMindmap({ title: "T", children: [] })).toThrow();
    expect(validateMindmap({ title: "T", children: [{ title: "A", children: [{ title: "a1", children: [{ title: "a2", children: [{ title: "too deep" }] }] }] }] }).children![0]!.children![0]!.children![0]!.children).toEqual([]);
    expect(validateSlides({ slides: [{ title: "a" }, { title: "b" }, { title: "c", bullets: ["x"] }] }).slides).toHaveLength(3);
    expect(validateScript({ chapters: [{ title: "c", lines: [{ speaker: "b", text: "hi" }, { text: "yo" }] }] }).chapters[0]!.lines.map((l) => l.speaker)).toEqual(["B", "A"]);
  });
  it("study guide, quiz, flashcards (creates review cards), mind map, slides (.pptx) end to end", async () => {
    const nb = createNotebook("Cats"); await addSource(nb.id, { kind: "text", name: "cats.txt", text: CATS });
    setStubHandler((req) => {
      const sys = req.messages[0]!.content;
      if (/study guide/.test(sys)) return "# Guide\nCats sleep.";
      if (/multiple-choice/.test(sys)) return JSON.stringify({ questions: [{ q: "Sleep?", options: ["2h", "14h", "20h", "1h"], answer: 1, explanation: "12-16h" }, { q: "Kittens?", options: ["kindle", "pack"], answer: 0 }] });
      if (/flashcards/.test(sys)) return JSON.stringify({ cards: [{ front: "Kitten group", back: "kindle" }, { front: "Sleep", back: "12-16h" }] });
      if (/mind map/.test(sys)) return JSON.stringify({ title: "Cats", children: [{ title: "Diet", children: [{ title: "Carnivore" }] }] });
      if (/slide deck/.test(sys)) return JSON.stringify({ title: "Cats 101", slides: [{ title: "Diet", bullets: ["Carnivores"] }, { title: "Sleep", bullets: ["12-16h"], notes: "n" }, { title: "Kittens", bullets: ["kindle"] }] });
      return "{}";
    });
    expect((await generate(nb.id, "study_guide")).data.markdown).toContain("Guide");
    expect((await generate(nb.id, "quiz")).data.questions).toHaveLength(2);
    await generate(nb.id, "flashcards");
    expect((getDb().prepare("SELECT COUNT(*) n FROM cards WHERE notebook_id=?").get(nb.id) as any).n).toBe(2);
    expect((await generate(nb.id, "mindmap")).data.title).toBe("Cats");
    const slides = await generate(nb.id, "slides");
    expect(fs.readFileSync(slides.file!).subarray(0, 2).toString()).toBe("PK");
  });
  it("generating without sources is a clear error", async () => {
    await expect(generate(createNotebook("E").id, "quiz")).rejects.toThrow(/at least one source/);
  });
  it("pptx builder writes a real file", async () => {
    const f = path.join(tmp, "x.pptx"); await buildPptx({ title: "T", slides: [{ title: "S", bullets: ["a", "b"], notes: "n" }] }, f);
    expect(fs.statSync(f).size).toBeGreaterThan(2000);
  });
  it("audio overview: script → TTS → one audio file with chapters (ffmpeg when it works, pure-JS WAV otherwise)", async () => {
    const nb = createNotebook("Cats"); await addSource(nb.id, { kind: "text", name: "cats.txt", text: CATS });
    setStubHandler(() => JSON.stringify({ title: "Cat chat", chapters: [{ title: "Sleep", lines: [{ speaker: "A", text: "Cats sleep a lot, you know." }, { speaker: "B", text: "Twelve to sixteen hours a day!" }] }, { title: "Kittens", lines: [{ speaker: "A", text: "A group of kittens is a kindle." }] }] }));
    const out = await generate(nb.id, "audio");
    expect(fs.existsSync(out.file!)).toBe(true); expect(out.file).toMatch(/\.(mp3|m4a|wav)$/);
    expect(out.data.chapters.map((c: any) => c.title)).toEqual(["Sleep", "Kittens"]);
    expect(out.data.chapters[1].start).toBeCloseTo(out.data.chapters[0].end, 3);
    expect(out.data.duration).toBeGreaterThan(0);
  }, 60000);
  it("WAV fallback path (forced, no ffmpeg) concatenates pieces and yields consistent chapter times", async () => {
    const script = { title: "T", chapters: [{ title: "One", lines: [{ speaker: "A" as const, text: "Hello there my friend." }, { speaker: "B" as const, text: "Hi!" }] }, { title: "Two", lines: [{ speaker: "A" as const, text: "Second chapter here." }] }] };
    const out = await buildAudio(script, path.join(tmp, "nofx"), { forceNoFfmpeg: true });
    expect(out.encoder).toBe("wav"); expect(out.file.endsWith(".wav")).toBe(true);
    const wav = parseWav(fs.readFileSync(out.file));
    const secs = wav.data.length / (wav.rate * wav.channels * (wav.bits / 8));
    expect(out.duration).toBeCloseTo(secs, 2);
    expect(out.chapters[0]!.start).toBe(0); expect(out.chapters[1]!.start).toBeCloseTo(out.chapters[0]!.end, 5); expect(out.chapters[1]!.end).toBeCloseTo(out.duration, 5);
  });
  it("wavConcat rejects mismatched formats and parseWav rejects junk", () => {
    const mk = (rate: number) => ({ rate, channels: 1, bits: 16, data: Buffer.alloc(100) });
    expect(() => wavConcat([mk(8000), mk(16000)])).toThrow(/different formats/);
    expect(() => parseWav(Buffer.from("hello world this is not a wav"))).toThrow();
    expect(wavConcat([mk(8000), mk(8000)]).durations).toEqual([100 / 16000, 100 / 16000]);
  });
});
