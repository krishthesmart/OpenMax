import { describe, expect, it } from "vitest";
import { classifyHeuristic } from "../src/router/classify.js";
import type { Task } from "../src/router/config.js";

const cases: Record<Task, string[]> = {
  code: [
    "Fix this bug:\n```ts\nconst x = foo.bar;\n```\nTypeError: Cannot read properties of undefined",
    "Write a Python function that merges two sorted lists and add unit tests",
    "Refactor utils.ts to remove the duplicated regex and make it compile with strict mode",
    "Traceback (most recent call last): File app.py line 3 NameError, why?",
  ],
  reasoning: [
    "Prove that the square root of 2 is irrational, step by step.",
    "Solve for x: 3x + 7 = 2x - 5 and explain why the solution is unique",
    "Analyze the trade-offs between these two chess strategies and think through the logic puzzle carefully",
  ],
  research: [
    "Research the state of the art in solid-state batteries and cite sources",
    "Give me a deep dive and comparison of Postgres vs MySQL replication with evidence",
    "Write a report on the history of the printing press with citations",
  ],
  realtime: [
    "What's the latest news on the Mars mission today?",
    "weather forecast for tonight in Austin",
    "Who won the match yesterday and what is the current price of bitcoin right now",
  ],
  creative: [
    "Write a haiku about autumn rain",
    "Brainstorm name ideas and a tagline for my coffee shop",
    "Write a short story about a lighthouse keeper who finds a message in a bottle",
  ],
  vision: [], multimodal: [],
  "long-context": [
    "Summarize the entire document and list every action item across all the chapters",
    "Find contradictions across the whole codebase and the entire transcript",
    "Read this whole book and outline each chapter's argument",
  ],
  agentic: [
    "Remind me to call the dentist every Monday morning and add to my calendar",
    "Send an email to Sam saying the meeting moved, then book a table for four on Friday",
    "Go to the airline website and sign up for alerts, then order the cheapest ticket",
  ],
  quick: ["hi", "thanks!", "translate 'good morning' to Spanish", "what is the capital of France", "define ephemeral"],
};

describe("heuristic classifier", () => {
  for (const [task, prompts] of Object.entries(cases) as [Task, string[]][]) {
    for (const p of prompts) {
      it(`${task}: ${p.slice(0, 48).replace(/\n/g, " ")}`, () => {
        const r = classifyHeuristic({ text: p });
        expect(r.task).toBe(task);
        expect(r.confidence).toBeGreaterThanOrEqual(0.6);
      });
    }
  }
  it("image attachment -> vision, pdf/audio/mixed -> multimodal", () => {
    expect(classifyHeuristic({ text: "what is this", attachments: ["image"] }).task).toBe("vision");
    expect(classifyHeuristic({ text: "summarize", attachments: ["pdf"] }).task).toBe("multimodal");
    expect(classifyHeuristic({ text: "transcribe", attachments: ["audio"] }).task).toBe("multimodal");
    expect(classifyHeuristic({ text: "compare", attachments: ["image", "pdf"] }).task).toBe("multimodal");
    expect(classifyHeuristic({ text: "x", attachments: ["image"] }).confidence).toBeGreaterThan(0.9);
  });
  it("huge input -> long-context", () => {
    expect(classifyHeuristic({ text: "summarize", tokenEstimate: 50_000 }).task).toBe("long-context");
  });
  it("ambiguous long text has low confidence (triggers LLM classifier)", () => {
    const r = classifyHeuristic({ text: "I have been thinking about how my team could organise its week better given that several people are remote and the timezone spread makes it awkward to find shared hours at all" });
    expect(r.confidence).toBeLessThan(0.6);
  });
});
