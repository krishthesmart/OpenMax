# OpenMax build plan

Self-hosted AI workbench. $0 by default (NVIDIA, Google AI Studio, OpenRouter `:free`, Groq, local Ollama);
paid flagships only with `ENABLE_PAID=true`. See DECISIONS.md for judgement calls and PROGRESS.md for status.

Gate for every phase: `npm run typecheck && npm test && npm run build` pass, then commit.

## Phase checklist

- [x] 1. Scaffold (npm workspaces: server + web), config (.env + zod), SQLite DB + migrations + sqlite-vec,
      provider registry (free + paid-hidden + stub), LLM interface (openai-compatible / anthropic / ollama dialects,
      stream / complete / completeJSON, tool calls + JSON-action fallback), model discovery + 1-token pings,
      `GET /api/health`, `POST /api/providers/test`
- [x] 2. Router: heuristic classifier + groq LLM classifier, lanes from data/router.json, fallback on error/429,
      token buckets + cooldowns + 80% cap warnings, privacy rule, modes (auto/local-first/cost-saver/manual),
      route SSE event, decision log, `/api/router/{config,explain,stats}`, /router page (lane editor + stats)
- [x] 3. Chat: conversations, search, auto-titles, stop, regenerate, edit-and-resend, branching; memories
      (local table or MemoryOS over MCP); artifacts panel; Gems (instructions, pinned lane/model, knowledge RAG
      with citations, starters, private); attachments (images, PDF, audio→STT); voice mode (PTT → STT → TTS)
- [x] 4. Research: plan → parallel search → dedupe → fetch → (deep) gap round → cited synthesis, step log, follow-ups
- [x] 5. Code: workspace tree with path-escape protection, Monaco, explain/fix/refactor/tests/docs/custom →
      ```file block → diff view → Apply/Reject
- [x] 6. Studio: mock / comfy / fal / free-provider image backends, t2i/i2v/t2v/v2v/edit, ~18 presets, controls,
      job queue + GPU scheduler, gallery, remix, delete; Storybook (10 pages → PDF)
- [x] 7. Notebook: sources (PDF/URL/text/YouTube), grounded chat with citations, audio overview (script → TTS →
      ffmpeg MP3 + chapters), study guide/FAQ/timeline, quiz + flashcards (SM-2), mind map, slides (.pptx)
- [x] 8. Canvas: doc/code editor beside chat, structured patch ops, inline suggestions, length/tone, versions,
      restore, live HTML/React preview
- [x] 9. Agent: tool loop (≤25 steps) with web_search, fetch_page, Playwright (isolated profile), sandboxed files,
      SMTP, ICS calendar, memory; approval gates enforced in code; action log + screenshots; cron schedules;
      Inbox
- [x] 10. Async code agent: repo + instruction → sandbox clone → plan approval → edits → tests (timeout) →
      ≤5 iterations → local branch + diff; push only on explicit click; parallel tasks; Inbox
- [x] 11. Think mode (multi-candidate + judge), usage meter (+caps, spend, budget, comparison), first-run wizard,
      hardware detection + local model recommendations, docker-compose (openmax, searxng, comfyui[gpu])
- [x] 12. Polish (shortcuts, responsive, fix-it errors), README, full smoke script, live check script
