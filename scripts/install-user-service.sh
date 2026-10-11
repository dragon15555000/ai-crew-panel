#!/usr/bin/env bash
# Instalacja ai-crew-panel jako usługi systemd --user.
#
# Instaluje:
#   ai-crew-panel.service           — sam panel (port z .env, domyślnie 5057)
#   ai-crew-panel-watchdog.service  — jednorazowy test /health
#   ai-crew-panel-watchdog.timer    — uruchamia watchdog co minutę
#
# Opcjonalne usługi z ai_crew (openapi-tools, openwebui) są instalowane tylko
# po ustawieniu INSTALL_OPTIONAL=1 — domyślnie pomijane, żeby instalator panelu
# nie zmieniał stanu innych usług.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_SRC="$ROOT/ai-crew-panel.service"
UNIT_DST="$UNIT_DIR/ai-crew-panel.service"
WATCHDOG_UNITS=("ai-crew-panel-watchdog.service" "ai-crew-panel-watchdog.timer")

require_file() {
  if [ ! -f "$1" ]; then
    echo "BŁĄD: brak pliku $1" >&2
    exit 1
  fi
}

assert_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "BŁĄD: brak wymaganego polecenia '$1' w PATH" >&2
    exit 1
  fi
}

assert_command systemctl
assert_command curl
require_file "$UNIT_SRC"
require_file "$ROOT/server.js"
require_file "$ROOT/local_apps.json"

# Panel czyta PORT z .env — ten sam port trafia do komunikatu i health checku.
PORT="$(sed -n 's/^[[:space:]]*PORT=\([0-9][0-9]*\).*/\1/p' "$ROOT/.env" 2>/dev/null | head -n1)"
PORT="${PORT:-5057}"

echo "== AI Crew Panel: instalacja usługi użytkownika =="
echo "Katalog:  $ROOT"
echo "Port:     $PORT"
echo "Jednostki: $UNIT_DIR"
echo

if [ ! -d "$ROOT/node_modules/express" ]; then
  echo "Brak node_modules — npm install..."
  (cd "$ROOT" && npm install)
fi

mkdir -p "$UNIT_DIR"
install -m 644 "$UNIT_SRC" "$UNIT_DST"
for unit in "${WATCHDOG_UNITS[@]}"; do
  require_file "$ROOT/$unit"
  install -m 644 "$ROOT/$unit" "$UNIT_DIR/$unit"
done

systemctl --user daemon-reload
systemctl --user enable ai-crew-panel.service
systemctl --user enable --now ai-crew-panel-watchdog.timer
systemctl --user restart ai-crew-panel.service
sleep 2

echo
echo "== Weryfikacja =="
if ! systemctl --user is-active --quiet ai-crew-panel.service; then
  echo "BŁĄD: usługa nie wystartowała. Logi:" >&2
  journalctl --user -u ai-crew-panel.service -n 30 --no-pager >&2
  exit 1
fi

HEALTH_URL="http://127.0.0.1:${PORT}/health"
echo "OK: ai-crew-panel działa"
curl -sf "$HEALTH_URL" || true
echo

PUBLIC_HOST="$(curl -sf "$HEALTH_URL" 2>/dev/null | sed -n 's/.*"publicHost":"\([^"]*\)".*/\1/p')"
echo "Panel lokalnie:   http://127.0.0.1:${PORT}"
[ -n "${PUBLIC_HOST:-}" ] && echo "Panel w sieci:    http://${PUBLIC_HOST}:${PORT}"

# Opcjonalne usługi z ai_crew (opt-in).
if [ "${INSTALL_OPTIONAL:-0}" = "1" ]; then
  echo
  echo "== Opcjonalne usługi ai_crew =="
  for name in openapi-tools openwebui; do
    src="$ROOT/../ai_crew/${name}.service"
    if [ ! -f "$src" ]; then
      echo "Pominięto ${name}.service: brak źródła $src"
      continue
    fi
    install -m 644 "$src" "$UNIT_DIR/${name}.service"
    systemctl --user daemon-reload
    systemctl --user enable --now "${name}.service" || true
    echo "Zainstalowano ${name}.service"
  done
fi

echo
if command -v loginctl >/dev/null 2>&1; then
  linger="$(loginctl show-user "$(whoami)" -p Linger --value 2>/dev/null || echo no)"
  if [ "$linger" = "yes" ]; then
    echo "Linger: włączony — panel wystartuje też po restarcie serwera."
  else
    echo "UWAGA: Linger wyłączony — panel zatrzyma się po wylogowaniu/reboot."
    echo "Włącz raz (sudo):  sudo loginctl enable-linger $(whoami)"
  fi
fi

echo
echo "Przydatne polecenia:"
echo "  systemctl --user status  ai-crew-panel"
echo "  systemctl --user restart ai-crew-panel"
echo "  systemctl --user list-timers ai-crew-panel-watchdog.timer"
echo "  journalctl --user -u ai-crew-panel -f"
