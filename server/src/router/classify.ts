import type { Task } from "./config.js";

export type AttachmentKind = "image" | "pdf" | "audio" | "video" | "text";
export interface ClassifyInput { text: string; attachments?: AttachmentKind[]; tokenEstimate?: number }
export interface Classification { task: Task; confidence: number; signals: string[]; scores: Partial<Record<Task, number>> }

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

type Rule = { task: Task; re: RegExp; w: number; label: string };
const R = (task: Task, re: RegExp, w: number, label: string): Rule => ({ task, re, w, label });
const RULES: Rule[] = [
  // code
  R("code", /```/, 3, "code fence"),
  R("code", /\b(traceback|stack ?trace|exception|segfault|undefined is not|cannot read propert|TypeError|ReferenceError|SyntaxError|NullPointer|panic:)/i, 3, "stack trace / error"),
  R("code", /\b(function|refactor|compile|compiler|typescript|javascript|python|rust|golang|java\b|c\+\+|kotlin|swift|sql|regex|api endpoint|unit tests?|class|method|variable|bug|debug|implement|algorithm|npm|pip install|git (commit|rebase|merge)|docker|dockerfile|react component|css|html|json schema|endpoint|script)\b/i, 1.6, "programming keyword"),
  R("code", /\b\w+\.(ts|tsx|js|jsx|py|rs|go|java|cpp|c|rb|php|sh|sql|yml|yaml)\b/i, 1.5, "source file name"),
  R("code", /\b(write|create|build|fix|make) (me )?(a |an |the )?(function|script|program|component|class|app|api|cli|bot|query)/i, 2, "write code request"),
  // reasoning
  R("reasoning", /\b(prove|proof|derive|theorem|lemma|integral|derivative|probability|expected value|equation|solve for|calculate|compute)\b/i, 2, "math term"),
  R("reasoning", /[0-9]\s*[\^*/+-]\s*[0-9]|\bx\s*=|∑|∫|√|≤|≥/, 1.5, "math expression"),
  R("reasoning", /\b(step[- ]by[- ]step|think (carefully|through)|logic puzzle|riddle|trade-?offs?|reason about|analy[sz]e|pros and cons of the decision|why does|why is|explain why|brain ?teaser|strategy|optimi[sz]e)\b/i, 1.6, "reasoning phrase"),
  // research
  R("research", /\b(research|literature|sources?|citations?|survey of|state of the art|overview of|deep dive|compare .* (vs|versus|and)|comparison of|market (size|landscape)|history of|report on|white ?paper|what do (experts|studies)|evidence for)\b/i, 2, "research phrase"),
  R("research", /\bhttps?:\/\/\S+/i, 1.2, "contains URL"),
  // realtime
  R("realtime", /\b(today|tonight|right now|currently|latest|breaking|news|this (week|morning|month)|yesterday|live score|weather|forecast|stock price|share price|exchange rate|trending|release date of the new|who won|score of|price of)\b/i, 2.2, "freshness word"),
  R("realtime", /\b(2026|2027)\b/, 1.4, "current year"),
  // creative
  R("creative", /\b(poem|poetry|haiku|sonnet|lyrics|song|story|short story|fiction|screenplay|script for a (film|video|scene)|slogan|tagline|brainstorm|name ideas|character|worldbuilding|monologue|limerick|roleplay|bedtime story|write (me )?a (letter|speech|toast))\b/i, 2.2, "creative writing"),
  // agentic
  R("agentic", /\b(book (a|an|me|my|us|the (flight|hotel|table|appointment))|schedule|remind me|set a reminder|send (an? )?(email|message|text)|email (him|her|them)|order|buy|purchase|sign up|fill (out|in) (the|a) form|go to .* and|browse to|every (day|week|morning|monday|hour)|calendar (invite|event)|add to my calendar|automate|post (this|it) (to|on)|log ?in to|check out|reserve|make a reservation|cancel my)\b/i, 2.4, "errand / scheduling verb"),
  // long-context
  R("long-context", /\b(entire (document|book|codebase|repo|transcript)|whole (document|book|codebase|repo|transcript)|this (book|manuscript|long document)|across (all|the) (files|chapters|documents))\b/i, 2.5, "whole-document phrase"),
  // quick
  R("quick", /^\s*(hi|hello|hey|thanks|thank you|ok|okay|yo|sup|good (morning|evening|night))\b[\s!.?]*$/i, 4, "greeting"),
  R("quick", /\b(translate|define|definition of|synonym|spell|tl;?dr|convert \d|what does .{1,20} mean|how do you say|capital of|abbreviation)\b/i, 1.8, "quick lookup"),
];

export function classifyHeuristic(input: ClassifyInput): Classification {
  const { text } = input;
  const atts = input.attachments ?? [];
  const tokens = input.tokenEstimate ?? estimateTokens(text);
  const scores: Partial<Record<Task, number>> = {};
  const signals: string[] = [];
  const add = (t: Task, w: number, why: string) => { scores[t] = (scores[t] ?? 0) + w; signals.push(`${t}:${why}`); };

  // attachments decide the route outright
  const hasImage = atts.includes("image");
  const others = atts.filter((a) => a !== "image" && a !== "text");
  if (hasImage && others.length === 0) return { task: "vision", confidence: 0.97, signals: ["attachment:image"], scores: { vision: 10 } };
  if (others.length || (hasImage && others.length)) return { task: "multimodal", confidence: 0.96, signals: [`attachment:${atts.join("+")}`], scores: { multimodal: 10 } };

  if (tokens > 24_000) return { task: "long-context", confidence: 0.95, signals: [`tokens:${tokens}`], scores: { "long-context": 10 } };
  if (tokens > 8_000) add("long-context", 2.5, `large input (${tokens} tokens)`);

  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) add(r.task, r.w, r.label);
  }
  // multiple code-ish keywords stack a little, but cap
  const kw = (text.match(/\b(function|class|variable|bug|compile|typescript|python|sql|regex|api|test|npm|git|docker)\b/gi) ?? []).length;
  if (kw >= 3) add("code", 1, "keyword density");

  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const entries = Object.entries(scores).sort((a, b) => b[1]! - a[1]!) as [Task, number][];
  if (entries.length === 0) {
    if (words > 0 && words <= 8 && !/[`{}();=<>]/.test(text)) return { task: "quick", confidence: 0.66, signals: ["short, no signals"], scores: {} };
    return { task: words > 40 ? "reasoning" : "quick", confidence: 0.3, signals: ["no signals"], scores: {} };
  }
  const [top, topScore] = entries[0]!;
  const second = entries[1]?.[1] ?? 0;
  let conf = 0.42 + 0.14 * (topScore - second) + 0.04 * topScore;
  if (entries.length === 1) conf += 0.06;
  conf = Math.max(0.2, Math.min(0.96, conf));
  // a very short question that only matched a weak rule is probably still quick
  return { task: top, confidence: Math.round(conf * 100) / 100, signals, scores };
}
