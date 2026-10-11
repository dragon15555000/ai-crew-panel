#!/usr/bin/env bash
# Watchdog dla ai-crew-panel.
#
# Proces potrafi zostać "żywy", ale bez działającego nasłuchu HTTP — systemd z
# Restart=always tego nie wykryje, bo proces się nie kończy. Ten skrypt sprawdza
# realną odpowiedź /health i restartuje usługę, jeśli jej brak.
#
# Uruchamiany cyklicznie przez ai-crew-panel-watchdog.timer (patrz README).
# Ręcznie:  ./watchdog.sh        (raportuje tylko przy problemie)
#           ./watchdog.sh -v     (raportuje zawsze)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$ROOT/.env"
VERBOSE=0
[[ "${1:-}" == "-v" || "${1:-}" == "--verbose" ]] && VERBOSE=1

# Port panelu czytamy z .env, żeby nie dublować konfiguracji.
PORT="$(sed -n 's/^[[:space:]]*PORT=\([0-9][0-9]*\).*/\1/p' "$ENV_FILE" 2>/dev/null | head -n1)"
PORT="${PORT:-5057}"

SERVICE="${PANEL_SERVICE:-ai-crew-panel}"
URL="${PANEL_HEALTH_URL:-http://127.0.0.1:${PORT}/health}"

if curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
  [[ "$VERBOSE" == "1" ]] && echo "$(date -Is) ${SERVICE}: OK (${URL})"
  exit 0
fi

echo "$(date -Is) ${SERVICE}: brak odpowiedzi ${URL} — restart usługi"
systemctl --user restart "$SERVICE"
sleep 2

if curl -fsS --max-time 5 "$URL" >/dev/null 2>&1; then
  echo "$(date -Is) ${SERVICE}: restart udany"
  exit 0
fi

echo "$(date -Is) ${SERVICE}: restart NIE pomógł — sprawdź: journalctl --user -u ${SERVICE} -n 50" >&2
exit 1
