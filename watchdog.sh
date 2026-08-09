#!/usr/bin/env bash
# Watchdog dla ai-crew-panel: proces potrafi zostać "żywy", ale bez działającego
# nasłuchu HTTP (systemd Restart=always tego nie wykrywa, bo proces się nie kończy).
# Ten skrypt sprawdza realną odpowiedź /health i restartuje usługę, jeśli jej brak.

set -euo pipefail

URL="http://127.0.0.1:5057/health"
SERVICE="ai-crew-panel"

if ! curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
  echo "$(date -Is) ai-crew-panel/health nie odpowiada — restart usługi ${SERVICE}"
  systemctl --user restart "$SERVICE"
fi
