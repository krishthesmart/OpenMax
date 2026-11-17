# Progress

Resume rule: re-read PLAN.md, this file and DECISIONS.md, then continue at the first unchecked phase.
Use Node 22: `export PATH=~/.nvm/versions/node/v22.22.2/bin:$PATH` (native modules do not build on this machine's Node 20).

## Phase 1 — done
- Monorepo (server/web), config (zod), SQLite + sqlite-vec migrations, provider registry (4 free + ollama + 7 paid hidden),
  openai/anthropic/ollama dialects, stub transport, rate-limit module, discovery + pings + tool probe, hardware detection,
  health + `/api/providers/test`, search module, web shell (dark UI, header, health dots, Settings page).
- Verified: typecheck, 22 vitest tests, build, built server serves UI + /api/health in stub mode.

## Phase 2 — done
- Heuristic classifier (30 labelled prompts), groq/ollama LLM classifier fallback (<0.6), lanes + modes + privacy rule, budget gate,
  429 cooldowns + per-minute windows, route SSE event (`route`/`meta` events from `runRouted`), decision log, stats, /api/router/*, /router page.
- Verified: typecheck, 70 tests, build.

## Phase 3 — done
- Chat engine (tree: branching/regenerate/edit-and-resend), SSE, auto-titles, history search, artifacts (parser + sandboxed preview incl. offline React via
  bundled vendor + sucrase), citations, attachments (images/PDF/audio/text; scanned PDFs rasterized via pdftoppm/sips), local-only privacy rule,
  cloud-override flow, memories (local + MemoryOS over MCP with tool auto-pick), Gems (instructions, lane/model pin, RAG knowledge, starters, private),
  embeddings (nvidia/ollama, hashed fallback) in sqlite-vec, STT (whisper.cpp / Groq) + TTS (Kokoro/Piper/say/mock), voice PTT with sentence-streamed TTS.
- Verified: typecheck, 90 tests, build, browser check of chat against the stub server.
- Not verified live: real STT/TTS, MemoryOS against a real server (tested with an injected MCP client), real embeddings.

## Phase 4 — done
- Research: plan (2–5 queries) → parallel search → URL/title dedupe → page fetch (pool of 5, snippet fallback) → deep gap round → cited streaming synthesis
  (invalid [n] stripped) → follow-ups; persisted history; live step log + source cards UI.
- Verified: typecheck, 97 tests (stub search/pages), build. Not verified live against real SearXNG.

## Phase 5 — done
- Code: workspace tree with realpath/symlink/`..`/absolute/NUL escape protection, size/binary guards, confirmed-only delete, Monaco bundled locally (no CDN),
  explain/fix/refactor/tests/docs/custom → ```file block → Monaco diff with Apply/Reject, local-only toggle.
- Verified: typecheck, 113 tests, build, browser check (Monaco loads from local bundle). The async code agent (Jules-style) is Phase 10.

## Phase 6 — done
- Studio: backends mock (animated SVG), comfy (API-format workflow templates with {{tokens}}, upload/poll/download, `/free` unload after queue drains),
  fal (paid, hidden unless ENABLE_PAID), Gemini image (free tier, auto-detected from the key's model list). 18 presets, aspect/seed/duration/count,
  job queue + progress, gallery, remix, delete, prompt enhance; unsupported ops greyed out with the reason. GPU scheduler: GPU jobs exclusive, LLM calls never gated.
- Storybook: LLM story JSON (10 pages) → fixed character bible repeated verbatim in every page prompt (+ page-1 reference image on Gemini) → pdfkit PDF.
- Verified: typecheck, 130 tests, build, browser check. Only `t2i.json` ComfyUI workflow ships; video/edit workflows are user-supplied (documented in data/workflows/README.md).
- Not verified live: ComfyUI, fal, Gemini image generation.

## Phase 7 — done
- Notebook: sources (PDF, text files, URL, YouTube transcript via caption tracks, pasted text) → chunk + embed; chat grounded only in retrieved excerpts with [n] citations,
  invented citations stripped, ungrounded answers flagged, passage offsets so the UI highlights the cited text; private notebooks never reach cloud models (chat and generators).
- Generators: study guide, FAQ, timeline, quiz, flashcards (SM-2 spaced repetition), mind map (SVG), slides (.pptx via pptxgenjs), two-host audio overview
  (script → per-line TTS → ffmpeg MP3/AAC with embedded chapters; pure-JS WAV concat + afconvert/`say` fallback when ffmpeg is missing).
- Verified: typecheck, 148 tests, build. NOTE: this Mac's /usr/local/bin/ffmpeg is an Intel binary ("Bad CPU type"), so the ffmpeg encode path (MP3 + embedded chapters)
  was NOT exercised here; the WAV fallback is tested. Not verified live: YouTube transcript fetch, real TTS voices.

## Phase 8 — done
- Canvas: structured patch ops (replace/insert/delete/replace_lines/append/set; atomic, exact-unique matching, actionable errors), model-driven edit with one
  feedback retry, inline suggestions (validated, accept/reject, never auto-applied), length/tone/reading-level transforms on selection or whole doc, versions + restore,
  Monaco editor + live sandboxed preview for HTML/React/SVG/Markdown, "Open in Canvas" from chat artifacts.
- Verified: typecheck, 160 tests, build.

## Phase 9 — done
- Agent: tool loop (≤25 steps; native tool calling with automatic JSON-action fallback; repeated-call guard), tools web_search, fetch_page, isolated Playwright browser
  (numbered element refs, screenshot per browser step), sandboxed files, SMTP email, ICS calendar, memory, ask_user, finish. Approval gates enforced in code
  (`gates.ts` + executor ordering validate → precheck → inspect → GATE → wait for human → run); hard blocks for passwords/cards/IDs; full step log with screenshots;
  card numbers redacted from logs/approvals/files. node-cron schedules (persisted), unattended runs with deferred approvals, Inbox with unread/pending badge.
- Verified: typecheck, 199 tests (gate matrix, executor enforcement with spies, loop, JSON fallback, deferred approvals, scheduler, ICS), build, and the real Playwright
  driver against a local test page.
- Not verified live: SMTP delivery, cron firing on a real clock.

## Phase 10 — done
- Async code agent: task = project folder in CODE_WORKSPACE (or plain https/ssh git URL) + instruction → sandbox clone (original never modified; non-git folders get a baseline
  snapshot; node_modules reused read-only via symlink) → model picks files, writes a plan → **waits for human plan approval** (test command editable) → edit rounds
  (full-file or patch-op edits, all-or-nothing, path-escape/.git refused) → tests in a secret-stripped environment with hard timeout + process-group kill →
  feedback loop up to 5 iterations → commit on a local branch + diff → Inbox. Up to 3 tasks in parallel. Branch export to the user's repo and `git push`
  are explicit-confirm HTTP actions only (single push call site, no force, asserted in a test); agent loop has no way to push.
- Verified: typecheck, 218 tests (real git repos, bare remote, timeouts, cancel/retry, parallel), build.

## Phase 11 — done
- Think mode: parallel drafts (nvidia + google + openrouter, + groq for short tasks, + paid flagships when allowed, local-only for private content; one local model is sampled
  twice at different temperatures), Gemini judge picks or merges, graceful fallbacks (failed drafts, unparseable/down judge), "considered approaches" panel persisted in message
  meta, time estimate from this machine's own latencies shown before running.
- Usage meter: per provider/model requests, tokens, tok/s, 429s; % of known free-tier daily caps with 80% warning (also on the header dots); local GPU hours + electricity estimate;
  paid spend vs monthly cap (warn 80%, auto free/local at 100% enforced in lane selection); subscriptions-vs-actual comparison panel from data/prices.json.
- First-run wizard (keys → test providers → apply lane suggestions → hardware + one-click `ollama pull` with progress → search/media check), keys written to .env (0600), never echoed.
  Paid providers + budget editable in Settings.
- Docker: Dockerfile (Node 22, optional Chromium), docker-compose.yml (openmax, searxng, comfyui under the `gpu` profile; validated with `docker-compose config`), searxng/settings.yml
  (JSON enabled), scripts/run-mac.sh native path.
- Verified: typecheck, 245 tests, build. Not run: `docker build` / `docker compose up` (not exercised in this environment).

## Phase 12 — done
- Polish: password login (OPENMAX_PASSWORD → HttpOnly SameSite=Strict cookie or Bearer header, login screen in the UI), Ollama appended as the last-resort fallback of every text lane,
  hardware tier boundaries fixed (a 16 GB Mac gets the 16 GB tier), test helper no longer leaks files into the repo, keyboard shortcuts + responsive layout + fix-it error cards throughout.
- `npm run smoke`: 12/12 checks over real HTTP (health, provider discovery, router explain for all 10 tasks + privacy rule, chat SSE, Think, research incl. deep gap round,
  Studio mock image+video, notebook grounding, canvas patch+restore, workspace path escapes, usage/setup, and an agent run against a local test page in a real Chromium where
  the personal-data, payment and email gates all fired, nothing happened before approval, the password field was blocked and the rejected email was never sent).
- `npm run live-check` exists and was run for real against local Ollama only (no cloud keys were used): 4/10 lanes resolve with Ollama alone; with keys the rest resolve.
- README complete (quick start with the four free keys, honest expectations table, limits/privacy, paid + budget cap, editing lanes, SearXNG/ComfyUI, model-ID caveat).

## No-mock pass (after Phase 12)
Requirement: no mock, simulation, placeholder or demo mode anywhere; everything must really work or say clearly what is missing.
- Removed from shipped code: the stub LLM provider and `OPENMAX_STUB`, the mock SVG media backend, silent mock TTS, fake STT, stub search/pages, stub YouTube, stub Ollama pull, mock lanes.
- Tests now run the real provider/search/media/speech code against local fixture servers that speak the real wire protocols (`server/test/fake.ts`, never imported by shipped code).
- `npm run smoke` rewritten to use only real services: real Ollama inference, real web search + page fetch, real macOS `say` speech, a real Chromium on a local page through the real tool executor with
  real approvals over HTTP, and a real local SMTP server receiving nodemailer mail. Model-dependent steps are "soft" (retry; reported as warnings, never faked).
- Real-service findings that changed the product: DuckDuckGo blocks automated requests (bot challenge) so search is now SearXNG → Brave → DuckDuckGo → Wikipedia and says which one is active;
  Pollinations' free image endpoint now answers 402 Payment Required so it was removed (Studio needs ComfyUI or a Gemini key and refuses jobs with a fix-it message otherwise); Think now falls back to
  local drafts when no cloud provider is available; error `fix` hints were being dropped by the HTTP error handler; the shipped ComfyUI workflow path depended on the working directory (now ROOT-based);
  small local models loop/truncate JSON (repeat penalty, truncated-JSON repair, flashcard pair recovery, canvas full-rewrite fallback added); ComfyUI polling is faster at first.

## Final verification (all run at the end)
- `npm run typecheck` clean · `npm test` 258 tests / 18 files pass · `npm run build` ok.
- `npm run smoke` (real services): 15-16 of 17 pass; the remaining warnings are the 1B local model failing to emit valid JSON / drive tools on some runs (it varies run to run).
- Studio image/video generation was NOT run for real here: no ComfyUI, no Gemini key, no paid fal key on this machine (the check verifies the honest refusal instead).

## Known gaps
Not exercised against the real service in this environment (no keys / hardware / daemon available):
- **Cloud providers** (NVIDIA, Gemini, OpenRouter, Groq, paid ones): no key was used, so those calls are verified only against protocol fixtures. Groq/Gemini model IDs in data/router.json are
  best guesses (NVIDIA/OpenRouter IDs came from public catalogs on 2026-11-16); `npm run live-check` shows which are dead once you add keys. Meta's API is assumed OpenAI-compatible.
- **Image/video generation**: ComfyUI, Gemini image and fal were not run (none available here). Only the t2i ComfyUI workflow ships.
- **General web search**: only Wikipedia was usable here (DuckDuckGo challenged, Docker daemon not running so SearXNG could not start, no Brave key).
- **ffmpeg MP3 path** (embedded chapters): this Mac's ffmpeg is Intel-only and cannot run; the WAV path was exercised for real.
- **Speech-to-text** (needs whisper.cpp or a Groq key), **Kokoro/Piper TTS** (macOS `say` was used), **YouTube transcripts**, **Docker image build/up**, **cron firing on a real clock**.
- **Model quality**: only `llama3.2:1b` is installed, which cannot reliably produce JSON or drive tools; those smoke steps pass intermittently. A stronger local model (e.g. `ollama pull qwen3:8b`
  on this 16 GB machine) or any cloud key fixes that.
- The web UI has no automated tests (spot-checked manually); mobile layout is functional but not polished.
