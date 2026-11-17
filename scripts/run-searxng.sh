#!/usr/bin/env bash
# Docker-free SearXNG for OpenMax's web search (Python 3.11-3.13).
#   ./scripts/run-searxng.sh            install on first run, then serve on http://127.0.0.1:8080
#   ./scripts/run-searxng.sh install    install only
# Installed under .services/ (git-ignored). Uses searxng/settings.yml (JSON output on, localhost only).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"; DIR="$ROOT/.services/searxng"; VENV="$ROOT/.services/searx-venv"
PY=""
for c in python3.12 python3.13 python3.11 python3; do command -v "$c" >/dev/null 2>&1 && { PY="$c"; break; }; done
[ -n "$PY" ] || { echo "Python 3.11+ is required" >&2; exit 1; }

if [ ! -d "$DIR/searx" ]; then
  mkdir -p "$ROOT/.services"
  echo "Cloning SearXNG…"; git clone --depth 1 https://github.com/searxng/searxng.git "$DIR"
fi
if [ ! -x "$VENV/bin/python" ]; then
  echo "Creating virtualenv ($PY)…"; "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install -q -U pip setuptools wheel pyyaml msgspec typing_extensions pybind11
  echo "Installing SearXNG dependencies…"
  (cd "$DIR" && "$VENV/bin/pip" install -q --use-pep517 --no-build-isolation -e .)
fi
[ "${1:-}" = "install" ] && { echo "SearXNG installed."; exit 0; }

# keep the secret out of git: generate one on first run
SETTINGS="$ROOT/.services/searxng-settings.yml"
if [ ! -f "$SETTINGS" ]; then
  sed "s/change-me-openmax-searxng/$(openssl rand -hex 24)/" "$ROOT/searxng/settings.yml" > "$SETTINGS"
fi
export SEARXNG_SETTINGS_PATH="$SETTINGS" SEARXNG_PORT=8080 SEARXNG_BIND_ADDRESS=127.0.0.1
echo "SearXNG on http://127.0.0.1:8080 (Ctrl+C to stop)"
cd "$DIR" && exec "$VENV/bin/python" -m searx.webapp
