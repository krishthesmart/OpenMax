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

## Known gaps
(none yet)
