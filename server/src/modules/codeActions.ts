import { runRouted, type RouteEvent } from "../router/router.js";
import type { Message } from "../providers/types.js";

export const ACTIONS = ["explain", "fix", "refactor", "tests", "docs", "custom"] as const;
export type CodeAction = (typeof ACTIONS)[number];

export interface FileBlock { path?: string; content: string }
/** Extracts the first ```file block (optionally "```file path=…"). The block ends at the last fence-only line. */
export function parseFileBlock(text: string): FileBlock | undefined {
  const open = /```file(?:[ :]+(?:path=)?["']?([^\s"'`]+)["']?)?[ \t]*\n/.exec(text);
  if (!open) return undefined;
  const start = open.index + open[0].length;
  const rest = text.slice(start);
  const close = rest.lastIndexOf("\n```");
  const content = close >= 0 ? rest.slice(0, close) : rest.replace(/\n?```\s*$/, "");
  return { path: open[1], content: content.replace(/\n$/, "") + "\n" };
}
/** Explanation text outside the file block. */
export function proseOutside(text: string): string { return text.replace(/```file[\s\S]*\n```/, "").trim(); }

const INSTR: Record<Exclude<CodeAction, "custom">, string> = {
  explain: "Explain what this code does: purpose, key parts, control flow, and anything surprising or risky. Do NOT output a file block.",
  fix: "Find and fix bugs in this code (including the issue the user describes, if any). Keep behaviour otherwise unchanged and make the smallest correct change. Briefly list what you changed first.",
  refactor: "Refactor for clarity and maintainability without changing behaviour: better names, smaller functions, no duplication, idiomatic style. Briefly list what you changed first.",
  tests: "Write thorough unit tests for this code using the project's existing test framework if you can tell, otherwise a standard one for the language. Output the TEST file as the file block (use a sensible path like foo.test.ts next to the source).",
  docs: "Add clear documentation: doc comments for public functions/classes and a short module header. Do not change any logic.",
};

export function buildCodeMessages(o: { action: CodeAction; path: string; content: string; instruction?: string; outline?: string; selection?: string }): Message[] {
  const base = o.action === "custom" ? (o.instruction?.trim() || "Improve this code.") : INSTR[o.action] + (o.instruction ? `\nUser note: ${o.instruction}` : "");
  const wantsFile = o.action !== "explain";
  const system = `You are an expert pair-programming assistant inside a code editor. ${base}
${wantsFile ? `Return the COMPLETE new contents of the file in exactly one fenced block that starts with \`\`\`file path=${o.path} on its own line and ends with a fence on its own line. No placeholders like "...rest unchanged". Put any explanation BEFORE the block and output nothing after it.` : "Answer in Markdown."}`;
  const user = `File: ${o.path}\n${o.outline ? `Project outline:\n${o.outline}\n\n` : ""}${o.selection ? `The user selected this part:\n\`\`\`\n${o.selection}\n\`\`\`\n\n` : ""}Full file:\n\`\`\`\n${o.content}\n\`\`\``;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

export async function* runCodeAction(o: { action: CodeAction; path: string; content: string; instruction?: string; outline?: string; selection?: string; mode?: string; localOnly?: boolean; signal?: AbortSignal }): AsyncGenerator<RouteEvent> {
  yield* runRouted({ task: "code", purpose: `code-${o.action}`, messages: buildCodeMessages(o), mode: o.mode, private: o.localOnly, signal: o.signal, temperature: 0.2 });
}
