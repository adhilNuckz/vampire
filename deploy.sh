#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  deploy.sh — kept for backwards compatibility.
#
#  All the logic now lives in install.sh, which supports two entry points:
#
#    From a checkout:   sudo bash deploy.sh          (this script)
#    One-liner:         curl -fsSL https://raw.githubusercontent.com/adhilNuckz/vampire/main/install.sh | sudo bash
#
#  Both install in place / update the existing install, open port 5050, and
#  start the bot under PM2.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$HERE/install.sh" ]; then
  echo "install.sh not found next to deploy.sh — get it with:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/adhilNuckz/vampire/main/install.sh | sudo bash" >&2
  exit 1
fi

exec bash "$HERE/install.sh" "$@"
