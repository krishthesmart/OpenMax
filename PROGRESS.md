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

## Known gaps
(none yet)
