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

## Known gaps
(none yet)
