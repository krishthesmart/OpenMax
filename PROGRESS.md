# Progress

Resume rule: re-read PLAN.md, this file and DECISIONS.md, then continue at the first unchecked phase.
Use Node 22: `export PATH=~/.nvm/versions/node/v22.22.2/bin:$PATH` (native modules do not build on this machine's Node 20).

## Phase 1 — done
- Monorepo (server/web), config (zod), SQLite + sqlite-vec migrations, provider registry (4 free + ollama + 7 paid hidden),
  openai/anthropic/ollama dialects, stub transport, rate-limit module, discovery + pings + tool probe, hardware detection,
  health + `/api/providers/test`, search module, web shell (dark UI, header, health dots, Settings page).
- Verified: typecheck, 22 vitest tests, build, built server serves UI + /api/health in stub mode.

## Known gaps
(none yet)
