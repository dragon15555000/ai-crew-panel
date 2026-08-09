#!/usr/bin/env bash
# Instalacja ai-crew-panel jako usługi systemd --user (port 5057)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_SRC="$ROOT/ai-crew-panel.service"
UNIT_DST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ai-crew-panel.service"
TOOLS_UNIT_SRC="$ROOT/../ai_crew/openapi-tools.service"
TOOLS_UNIT_DST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/openapi-tools.service"
WEBUI_UNIT_SRC="$ROOT/../ai_crew/openwebui.service"
WEBUI_UNIT_DST="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/openwebui.service"

mkdir -p "$(dirname "$UNIT_DST")"
cp "$UNIT_SRC" "$UNIT_DST"
cp "$TOOLS_UNIT_SRC" "$TOOLS_UNIT_DST"
cp "$WEBUI_UNIT_SRC" "$WEBUI_UNIT_DST"

if [ ! -d "$ROOT/node_modules/express" ]; then
  echo "Brak node_modules — npm install..."
  (cd "$ROOT" && npm install)
fi

systemctl --user daemon-reload
systemctl --user enable ai-crew-panel.service
systemctl --user enable openapi-tools.service
systemctl --user enable openwebui.service
systemctl --user restart ai-crew-panel.service
systemctl --user restart openapi-tools.service
systemctl --user restart openwebui.service
sleep 2

if systemctl --user is-active --quiet ai-crew-panel.service; then
  echo "OK: ai-crew-panel działa na http://127.0.0.1:5057"
  curl -sf "http://127.0.0.1:5057/health" | head -c 200 || true
  echo ""
else
  echo "BŁĄD: usługa nie wystartowała. Logi:"
  journalctl --user -u ai-crew-panel.service -n 30 --no-pager
  exit 1
fi

if systemctl --user is-active --quiet openapi-tools.service; then
  echo "OK: openapi-tools działa"
else
  echo "BŁĄD: openapi-tools nie wystartował. Logi:"
  journalctl --user -u openapi-tools.service -n 30 --no-pager
  exit 1
fi

if systemctl --user is-active --quiet openwebui.service; then
  echo "OK: openwebui działa na http://127.0.0.1:3001"
else
  echo "BŁĄD: openwebui nie wystartował. Logi:"
  journalctl --user -u openwebui.service -n 30 --no-pager
  exit 1
fi

if command -v loginctl >/dev/null 2>&1; then
  linger="$(loginctl show-user "$(whoami)" -p Linger --value 2>/dev/null || echo no)"
  if [ "$linger" != "yes" ]; then
    echo ""
    echo "UWAGA: Linger wyłączony — panel zatrzyma się po wylogowaniu/reboot."
    echo "Włącz raz (sudo):  sudo loginctl enable-linger $(whoami)"
  fi
fi
