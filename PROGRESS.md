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

## Known gaps
(none yet)
