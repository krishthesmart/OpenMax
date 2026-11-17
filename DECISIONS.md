# Decisions

Judgement calls made while building, newest at the bottom.

1. **Location.** OpenMax is its own git repository at `~/OpenMax`, not inside the Krish repo, since it is an
   unrelated product.
2. **Node version.** The spec says Node 22; this machine has Node 20.20. `engines` is `>=20.19` and the
   Dockerfile uses Node 22. Nothing used requires 22.
3. **Model IDs** live only in `data/router.json` (cloud lanes, classifier, judge, embeddings, STT/TTS, image
   models) and `data/local-models.json` (Ollama tiers, local embedding/vision models). Code refers to lanes and
   roles, never to model names. Initial IDs come from the public NVIDIA and OpenRouter `/models` catalogs
   (fetched 2026-11-16); Groq and Gemini IDs are best guesses and are verified by discovery at boot.
4. **No mock or simulation modes anywhere in the product.** There is no stub provider, mock media backend, fake search or silent TTS. If a capability is not configured
   (no image backend, no TTS engine, no search backend, no SMTP) the feature refuses with a fix-it message instead of fabricating output. Tests run the *real* provider, search, media and
   speech code against local fixture servers that speak the real wire protocols (`server/test/fake.ts`, never imported by shipped code); `npm run smoke` uses only real services.
5. **Vectors.** Embeddings are stored as float32 BLOBs with their dimension; similarity uses sqlite-vec's
   `vec_distance_cosine` (so different embedding models can coexist) and falls back to a JS cosine if the
   extension cannot load. If no embedding model is reachable, a deterministic hashed bag-of-words embedding
   is used so retrieval still works offline.
6. **Keys.** The first-run wizard writes keys into `.env` (self-hosted, single user) and never sends them back to
   the browser; the UI only sees "set / not set".
7. **TTS/STT.** TTS order: Kokoro (HTTP, OpenAI-compatible) → Piper (binary) → macOS `say`; otherwise an error with install instructions. STT: whisper.cpp → Groq hosted Whisper;
   otherwise an error with setup instructions.
8. **Approval gates** are enforced in the tool executor: a gated call creates an `approvals` row and the run
   pauses until `POST /api/approvals/:id` with an explicit decision. The model cannot bypass this; there is no
   tool that approves.
9. **Sending email always needs approval** (sending is irreversible), not only for new recipients. New
   recipients are additionally flagged in the approval card.
10. **Card numbers** (Luhn-valid 13–19 digit runs) are redacted from every stored action log, memory and message.
11. **Media.** Only real backends: ComfyUI (local), Gemini image (free-tier key) and fal (paid). A free keyless host (Pollinations) was tried and removed because its anonymous
    endpoint now answers 402 Payment Required for any new prompt. With no backend, Studio says what to set up and refuses jobs.
12. **Single port** in production: Fastify serves `web/dist` and `/api/*` on `PORT` (8787). In dev, Vite proxies
    `/api` to the server.
13. **Attachments are local-only by default** (spec: "private Gems, private Notebooks and attachments go local-only unless I
    override per message"). With no local vision model the router returns a fix-it error and the chat UI offers a one-click
    "send to cloud for this message" override. Private content also never reaches the cloud *classifier*.
14. **Modes.** auto = lane order (paid flagships first when enabled and under budget); local-first = Ollama refs first, cloud as
    fallback; cost-saver = never paid, Ollama first for quick/creative; manual:`<ref>` = exactly that model, no fallback.
15. **Fallback only before the first token.** A failure mid-stream is reported, not retried on another model (it would duplicate
    output). Cooling-down providers and full per-minute windows are skipped, not waited on.
16. **Dead refs** (failed last "Test providers") are moved to the end of a lane rather than removed, so a transient failure
    never hard-disables a model.
17. **Agent hard blocks vs approvals.** The agent can never type passwords, payment card numbers or government ID numbers (hard block; no approval offered, the user does
    those themselves). Personal data (email, phone, address, DOB), submitting/Enter-in-form, destructive or publishing clicks, payment buttons, email sending and file
    deletes all require a human approval click. Gating lives in `modules/agent/gates.ts` (pure) and is applied by `executeTool` before any side effect.
18. **Unattended (scheduled) runs** never block: `send_email` and `file_delete` are queued as *deferred* approvals in the Inbox and execute only when the user approves
    later; browser actions that need approval are refused ("run it interactively"). Interactive runs wait on the approval.
19. **Chromium discovery.** Playwright 1.65 wants a newer Chromium than is installed here; `findChromium()` uses any installed Playwright Chromium (or
    PLAYWRIGHT_CHROMIUM_PATH). The agent browser always uses an isolated profile in `data/browser-profile`, never the user's Chrome.
20. **ffmpeg may be unusable** (this Mac has an Intel-only build): audio overviews fall back to pure-JS WAV concatenation (+ `afconvert` / `say` WAV output); chapters
    are then returned as data instead of embedded metadata.
21. **Auth.** `OPENMAX_PASSWORD` enables a login screen: the browser gets an HttpOnly, SameSite=Strict session cookie derived from the password (never the password itself);
    scripts can use a Bearer header. Cookies are needed because `<img>`/`<audio>` tags cannot send headers. `/api/health`, `/api/login` and `/api/auth/status` stay public.
22. **Ollama is the fallback for everything.** Every text lane gets `localDefault` appended if it has no local model (vision/multimodal excluded: a text model cannot see images).
23. **Tests never write into the repo.** The test helper uses a throwaway temp DATA_DIR; the DB itself is in-memory.
24. **Search chain (SEARCH_BACKEND=auto).** SearXNG if running → Brave if a key is set → DuckDuckGo HTML if it answers automated requests (it usually returns a bot challenge) →
    Wikipedia (always reachable, encyclopedic only; the UI and health say so). General web search therefore needs SearXNG or a free Brave key.
25. **Small-model robustness.** Ollama requests carry a repeat penalty; truncated JSON is repaired; flashcards recover front/back pairs from broken JSON; canvas edits fall back to a
    full-document rewrite when structured ops are unusable. These help weak local models; stronger models are simply better.
