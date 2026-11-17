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
4. **Stub provider.** `OPENMAX_STUB=1` routes every provider's transport through a deterministic in-process stub
   (and search through a stub index). Lanes, fallback and cooldowns still run for real, so tests and the smoke
   script exercise the real router.
5. **Vectors.** Embeddings are stored as float32 BLOBs with their dimension; similarity uses sqlite-vec's
   `vec_distance_cosine` (so different embedding models can coexist) and falls back to a JS cosine if the
   extension cannot load. If no embedding model is reachable, a deterministic hashed bag-of-words embedding
   is used so retrieval still works offline.
6. **Keys.** The first-run wizard writes keys into `.env` (self-hosted, single user) and never sends them back to
   the browser; the UI only sees "set / not set".
7. **TTS/STT fallbacks.** TTS order: Kokoro (HTTP, OpenAI-compatible) → Piper (binary) → macOS `say` → mock
   (silent WAV). STT: whisper.cpp → Groq hosted Whisper → mock (in stub mode only). Missing backends produce
   fix-it messages.
8. **Approval gates** are enforced in the tool executor: a gated call creates an `approvals` row and the run
   pauses until `POST /api/approvals/:id` with an explicit decision. The model cannot bypass this; there is no
   tool that approves.
9. **Sending email always needs approval** (sending is irreversible), not only for new recipients. New
   recipients are additionally flagged in the approval card.
10. **Card numbers** (Luhn-valid 13–19 digit runs) are redacted from every stored action log, memory and message.
11. **Mock video** output is an animated SVG so Studio and Storybook work with no GPU; real backends write
    PNG/MP4/WebM.
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
