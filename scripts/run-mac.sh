#!/usr/bin/env bash
# Native macOS run path (Metal-accelerated Ollama / ComfyUI outside Docker).
#   ./scripts/run-mac.sh          build (if needed) and start on http://127.0.0.1:8787
#   ./scripts/run-mac.sh dev      start the dev servers (hot reload; UI on :5173)
set -euo pipefail
cd "$(dirname "$0")/.."

# Node 22 (native modules such as better-sqlite3 need a matching prebuilt binary)
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use >/dev/null 2>&1 || nvm install >/dev/null; fi
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "Node 22 or newer is required (found $(node -v)). Install it with nvm or Homebrew." >&2; exit 1; }

[ -f .env ] || { cp .env.example .env; chmod 600 .env; echo "Created .env from .env.example (add your free API keys, or use the setup wizard in the UI)."; }
[ -d node_modules ] || npm install

# Web search: start the native SearXNG (installed by ./scripts/run-searxng.sh install) if it is not already running
if [ -d .services/searxng/searx ] && ! curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
  echo "Starting SearXNG…"; (nohup ./scripts/run-searxng.sh >/tmp/searxng.log 2>&1 &); sleep 4
elif [ ! -d .services/searxng/searx ]; then
  echo "Tip: ./scripts/run-searxng.sh install   # real general web search without Docker (Python 3.11+)"
fi

# Agent browser: Playwright uses an installed Chromium; install one once if none exists
ls "$HOME/Library/Caches/ms-playwright" 2>/dev/null | grep -q chromium || echo "Tip: run 'npx playwright install chromium' once to enable the agent's browser tool."

if [ "${1:-}" = "dev" ]; then exec npm run dev; fi
[ -f web/dist/index.html ] && [ -f server/dist/index.js ] || npm run build
exec npm start
