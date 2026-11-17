# OpenMax

A self-hosted AI workbench: chat, research, notebooks, image/video studio, a coding workspace, background agents and a model router, running at **$0 recurring cost** on free cloud API tiers plus local open models. Paid flagship APIs are supported but stay hidden until you turn them on.

It is original code written from scratch. It is not affiliated with, and does not copy, any commercial product.

| Module | What it does |
|---|---|
| **Chat** | Conversations with branching (edit, regenerate, siblings), artifacts (code, docs, HTML, SVG, React rendered in a sandbox), memories, Gems (reusable assistants with private knowledge bases), attachments (images, PDFs, audio), push-to-talk voice |
| **Research** | Plans 2–5 searches, reads the best pages, writes a cited answer with source cards and follow-ups; deep mode adds a gap-analysis round |
| **Notebook** | Chat grounded only in your sources (PDF, URL, YouTube transcript, text) with clickable citations; study guide, FAQ, timeline, quiz, spaced-repetition flashcards, mind map, `.pptx` slides, two-host audio overview |
| **Studio** | Text→image, image→video, text→video, video→video, image edit through ComfyUI / Gemini image / fal backends; 18 motion and style presets; job queue, gallery, remix; 10-page illustrated Storybook exported to PDF |
| **Code** | File tree with path-escape protection, Monaco editor, explain/fix/refactor/tests/docs with a diff view and Apply/Reject |
| **Code tasks** | Hand off a task: sandbox clone → plan you approve → edits → tests (timeout) → up to 5 iterations → local branch and diff. Never pushes unless you click |
| **Canvas** | A document or program you and the model edit together via structured patches, with suggestions, tone/length controls, version history and live preview |
| **Agent** | Tool loop (max 25 steps) with search, page fetch, an isolated Playwright browser, a sandbox folder, SMTP email, ICS calendar and memory; cron schedules; Inbox; **approval gates enforced in code** |
| **Router** | Classifies each message (free heuristics, then a fast LLM only if unsure) and sends it to the strongest available model for that task, with fallbacks, cooldowns and a visible reason |
| **Think** | Several models draft in parallel and a judge picks or merges the best answer; shows the considered approaches and an estimated time first |
| **Usage** | Requests, tokens, tokens/sec, 429s, % of free-tier caps, local GPU time and electricity estimate, paid spend vs budget, and your cost vs the subscriptions it replaces |

## Quick start (your four free keys)

You need Node 22+ and, optionally, [Ollama](https://ollama.com) for local models.

```bash
git clone <this repo> openmax && cd openmax
cp .env.example .env          # then add keys below, or use the first-run wizard in the UI
npm install
npm run build && npm start    # http://127.0.0.1:8787
```

Get the free keys (all have free tiers at the time of writing; see "model IDs and terms change" below):

| Provider | Where | `.env` variable |
|---|---|---|
| NVIDIA | build.nvidia.com | `NVIDIA_API_KEY` |
| Google AI Studio (Gemini) | aistudio.google.com | `GEMINI_API_KEY` |
| OpenRouter (`:free` models only) | openrouter.ai/keys | `OPENROUTER_API_KEY` |
| Groq | console.groq.com | `GROQ_API_KEY` |

On first launch with no keys the **setup wizard** opens: paste keys → verify → ping every model in your lanes → apply suggested lane picks → detect hardware and `ollama pull` recommended local models → check search/media. Keys are written to `.env` (mode 600) and never sent back to the browser.

Then check your real setup from the terminal:

```bash
npm run live-check      # pings your real providers and prints which lane resolves to which model
npm run smoke           # end-to-end test against REAL services: Ollama, web search, a real browser, real SMTP, real speech
```

Other ways to run:

- **Development:** `npm run dev` (server on 8787, hot-reloading UI on 5173).
- **macOS native (recommended on Apple silicon):** `./scripts/run-mac.sh`. Runs Ollama (and ComfyUI, if you use it) natively so Metal acceleration works. Docker on macOS cannot use the GPU.
- **Docker:** `docker compose up -d` starts OpenMax and SearXNG. `docker compose --profile gpu up -d` also starts ComfyUI (needs an NVIDIA GPU and the NVIDIA container toolkit). Ollama is deliberately not in the compose file; run it on the host and the container reaches it at `host.docker.internal:11434`. The image installs Chromium for the agent browser; build with `--build-arg WITH_BROWSER=false` to skip it.

## What to expect (honest version)

| | Free cloud tiers | Local models (Ollama) | Paid flagships (optional) |
|---|---|---|---|
| Cost | $0, but rate-limited and terms can change | $0 plus electricity | Pay per token; capped by `MONTHLY_BUDGET_USD` |
| Quality | Strong open and "flash"-class models; the best ones are large | Depends on your RAM/VRAM. On 8–16 GB expect small/medium models: fine for quick tasks, notably weaker for hard coding and reasoning | Highest quality for coding, reasoning, agents |
| Speed | Fast (Groq) to moderate | Depends on hardware; first token after a cold load is slow | Fast |
| Limits | Per-minute and per-day caps; 429s are routed around automatically, but a busy day can exhaust a tier | None | Budget only |
| Privacy | Prompts go to the provider | Never leaves your machine | Prompts go to the provider |
| Best for | Default for everything non-private | Private content, offline, last-resort fallback | When you need the best answer and accept the cost |

Things this project does **not** claim:

- It is not a drop-in replacement for every feature of the commercial products it is inspired by. "Think" is a draft-and-judge pipeline over several models, not a specialised reasoning model. Studio's mock backend draws placeholders; real image/video quality is whatever your ComfyUI workflow and checkpoints produce.
- Free tiers can change or disappear. A lane that works today may fall through to another provider tomorrow; that is what the router and `live-check` are for.
- The agent is capable but not infallible. That is why anything irreversible needs your click.

## Free-tier limits and privacy

**Limits.** OpenMax keeps a per-provider rate-limit bucket from response headers (conservative per-minute defaults until it has seen them). On a 429 it falls through to the next model immediately and cools that provider down for the `retry-after` window (shown in the header as "groq 40s"). It tracks your daily usage against approximate free-tier caps in `data/prices.json` and warns at 80%. Those caps are defaults, not guarantees: check each provider's dashboard.

**Privacy.**

- Private Gems, private Notebooks, private chats, and any message with attachments are routed to **local models only**, including the classifier. If no local model is available you get a fix-it message and a per-message "send to cloud" override.
- Everything else is sent to whichever cloud provider the router picks. Do not paste secrets into non-private chats.
- Provider API keys live in `.env`. The agent and code tasks run untrusted commands with API keys and passwords stripped from the environment.
- The agent never types passwords, payment card numbers or government ID numbers, and card numbers are redacted from stored messages, memories, logs and files. The agent browser uses its own profile in `data/browser-profile`, never your own browser.
- OpenMax binds to `127.0.0.1` by default. If you expose it, set `OPENMAX_PASSWORD` (login screen plus HttpOnly cookie, or a Bearer header for scripts) and put it behind HTTPS.

**What always needs your explicit click** (enforced in code, not in prompts): sending email, deleting files, buying/submitting/publishing in the browser, typing personal data into forms, answering agent questions, approving a code-task plan, exporting a code-task branch to your repo, and `git push`.

## Paid flagships and the budget cap

Paid providers (Anthropic, OpenAI, xAI/Grok, Google paid key, DeepSeek, Meta, paid OpenRouter models, fal for media) exist in code but are hidden and unused until you enable them.

1. Settings → "Paid flagships": tick **Enable paid providers**, set a monthly budget, paste the keys. (Or edit `.env`: `ENABLE_PAID=true`, `MONTHLY_BUDGET_USD=20`, `ANTHROPIC_API_KEY=…`.)
2. Flagships are inserted at the top of the relevant lanes (`paidLanes` in `data/router.json`): Anthropic for code/reasoning/agentic, xAI for realtime, Google paid for long-context/vision, OpenAI as an extra Think candidate.
3. Spend is computed per request from `data/prices.json` (prices change; verify them). The Usage page warns at **80%** of the cap and at **100%** paid models are skipped automatically, so everything falls back to free and local models until next month.

## How to edit lanes

All model IDs live in two files, never in code: `data/router.json` (cloud lanes, classifier, judge, titles, embeddings, Think candidates, paid lanes) and `data/local-models.json` (Ollama recommendations per memory tier).

- **In the UI:** the **Router** page. Reorder, add or remove models per lane, click **Test providers** to mark dead models, use **apply suggestion** to adopt picks derived from your live model catalog, then **Save lanes**. Use **Explain** to see how any prompt would be classified and routed.
- **By hand:** edit `data/router.json`. A ref is `provider:model`, for example `groq:llama-3.3-70b-versatile` or `ollama:qwen3:8b`. The first live entry in a lane wins; errors and 429s fall through to the next. Every text lane automatically ends with `localDefault` (Ollama) as a last resort.
- **Per message:** the mode picker in the header: Auto, Local-first, Cost-saver, or pin one specific model. Clicking the route chip on any answer re-runs it with a different model.

Tasks: `code`, `reasoning`, `research`, `realtime`, `creative`, `vision`, `multimodal`, `long-context`, `agentic`, `quick`.

## Search, ComfyUI and other services

**Web search.** `SEARCH_BACKEND=auto` tries, in order: SearXNG (if running), Brave (if `BRAVE_API_KEY` is set), DuckDuckGo (only if it answers automated requests; it usually returns a bot challenge), then Wikipedia. Wikipedia always works but only covers encyclopedic topics, and the UI says when that is what you are getting. For real general web search run SearXNG (`docker compose up -d searxng`; `searxng/settings.yml` enables the JSON format OpenMax needs and binds to localhost; change its `secret_key`) or get a free Brave Search API key.

**ComfyUI (real image/video).**

1. Run ComfyUI (natively on macOS/Windows/Linux, or `docker compose --profile gpu up -d` on an NVIDIA machine) and set `MEDIA_PROVIDER=comfy` (and `COMFY_URL` if it is not `http://127.0.0.1:8188`).
2. `data/workflows/t2i.json` ships and expects `sd_xl_base_1.0.safetensors`; edit `ckpt_name` to a checkpoint you have.
3. Image→video, text→video, video→video and image-edit need workflows that match *your* nodes and models. In ComfyUI use **Save (API Format)**, replace the values Studio should control with `{{prompt}} {{negative}} {{seed}} {{width}} {{height}} {{frames}} {{image}} {{video}}`, and save as `data/workflows/i2v.json`, `t2v.json`, `v2v.json` or `edit.json`. Studio greys out any operation whose file is missing and says why. Details: `data/workflows/README.md`.
4. GPU jobs are exclusive (one at a time); after the queue drains OpenMax asks ComfyUI to unload its checkpoints so your LLMs have the memory back. The hot Ollama model stays loaded.

Image generation without a GPU: if your Gemini key lists an image-capable model, Studio uses a "Gemini image" backend automatically (stills only; see `data/media.json`). There is no mock or placeholder backend: with neither ComfyUI nor a Gemini key, Studio says what to set up and refuses jobs. (A free keyless hosted generator was evaluated and dropped because it now requires payment for new prompts.)

**Speech.** Text-to-speech uses Kokoro (HTTP) → Piper → macOS `say`, whichever works first (`TTS_BACKEND` forces one); if none is available you get a message saying how to install one, never silent audio. Speech-to-text uses whisper.cpp (`WHISPER_BIN`, `WHISPER_MODEL`) or Groq's hosted Whisper if you have a Groq key. For audio overviews, a working `ffmpeg` gives MP3 with embedded chapters; without one OpenMax writes a WAV and shows the chapters in the player.

**Agent browser.** Playwright needs a Chromium: `npx playwright install chromium` once (OpenMax will also use any Playwright Chromium already on your machine).

**Email.** Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (for Gmail use an app password). Every email asks for your approval first.

**Long-term memory over MCP.** Settings → Long-term memory: paste your MemoryOS MCP URL. OpenMax auto-detects its read/write tools; memories are always mirrored in the local table so you can review and delete them.

## Model IDs and free-tier terms change

Model names, availability, context limits and free-tier terms change often, sometimes without notice. The IDs shipped in `data/router.json` were taken from the public provider catalogs when this was written and **will go stale**. OpenMax reads each provider's live model list at startup, pings every model in your lanes, marks dead ones, and suggests replacements, but you confirm lane changes on the Router page. Re-run `npm run live-check` after changing keys or editing lanes, and re-verify `data/prices.json` (subscription prices and free-tier caps) before relying on the Usage comparison.

## Configuration

Everything is in `.env` (fully documented in `.env.example`). Data lives in `./data`: the SQLite database (`openmax.db`, with sqlite-vec for embeddings), media, uploads, notebooks, agent files and browser profile, plus `router.json`, `local-models.json`, `prices.json`, `media.json` and `workflows/`. Back up that folder to back up your workbench.

## Development

```bash
npm run typecheck      # server + web
npm test               # vitest: classifier, lanes, fallback, 429 cooldown, privacy, discovery parsing, Think judge,
                       # artifacts, canvas patches, notebook grounding, path safety, approval gates, meter math, …
npm run build          # web (Vite) then server (tsc)
npm run smoke          # end-to-end over HTTP against real services (needs Ollama running with a model)
npm run live-check     # your real providers
```

Layout: `server/src` (providers, router, modules, routes), `web/src` (pages, components), `data/` (editable config), `scripts/` (macOS runner). The server is Fastify 5 + better-sqlite3 + sqlite-vec with SSE streaming; the UI is Vite + React + Tailwind with a locally bundled Monaco editor (no CDN).

Native modules (better-sqlite3) need a Node version with a prebuilt binary; use Node 22 (`.nvmrc`).

## Known limitations

See `PROGRESS.md` ("Known gaps") for the current list. In short: only the text-to-image ComfyUI workflow ships; the ffmpeg MP3 path, SMTP delivery, YouTube transcripts, ComfyUI/fal/Gemini image generation and Docker images were not exercised against live services while building this; and the shipped model IDs need checking against your own provider catalogs.
