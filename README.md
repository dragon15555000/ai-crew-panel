# AI Crew Panel

Lokalny panel do zarządzania i podglądu statusu aplikacji uruchomionych na tym
serwerze. Działa jako usługa `systemd --user`, więc nie wymaga logowania do
sesji graficznej ani uprawnień roota.

## Środowisko docelowe

* Host: `aidok` / `192.168.8.209` (sieć LAN), Tailscale `100.103.76.25`
* **Serwer bez kart graficznych** — brak `nvidia-smi`, jedyna karta to wirtualny
  VGA QEMU (`0x1234:0x1111`). Panel wykrywa to i pokazuje stan „Brak kart
  graficznych (CPU-only)” zamiast błędu; Ollama pracuje na CPU.
* Adres IP, na który wskazują linki aplikacji, jest **wykrywany automatycznie**
  z interfejsów sieciowych. Wymuszenie: `PUBLIC_HOST` w `.env`.

## Linki i endpointy

| Co | Adres |
|----|-------|
| Panel (w sieci) | <http://192.168.8.209:5057> |
| Panel (lokalnie) | <http://127.0.0.1:5057> |
| Health | `GET /health` |
| Lista aplikacji + statusy | `GET /api/apps` |
| Podsumowanie | `GET /api/summary` |
| Sprzęt (GPU/RAM/Ollama) | `GET /api/hardware` |
| Status aplikacji | `GET /api/apps/:appId/status` |
| Start / Stop / Restart | `POST /api/apps/:appId/start` · `/stop` · `/restart` |
| Restart wszystkich zarządzalnych | `POST /api/apps/restart-enabled` |
| Szczegóły / edycja wpisu | `GET /api/apps/:appId/details` · `PATCH /api/apps/:appId` |
| Skan portów | `POST /api/scan` |

Adres panelu w linkach jest budowany jako `http://{PUBLIC_HOST}:{port}`.
W katalogu aplikacji można użyć tokenu `{host}` (np. `http://{host}:5080`).

## Aplikacje na tym hoście

| Aplikacja | Port | Zarządzanie z panelu |
|-----------|------|----------------------|
| AI Crew Panel (self) | 5057 | `systemctl --user start/stop ai-crew-panel` |
| AI Crew Cockpit | 5500 | `systemctl --user start/stop ai-crew-cockpit` |
| new-api (LLM Gateway) | 3000 | Docker (`docker compose up -d` / `stop`) |
| n8n | 5678 | Docker (`docker compose up -d` / `stop`) |
| KRS Viewer | 5080 | Docker (compose w `/home/mg/projekty/krs_viewer_app`) |
| AI Analiza Dokumentów | 5000 | **tylko podgląd** — usługa systemowa `aianalizator.service` |
| Qdrant | 6333 | **tylko podgląd** — usługa systemowa `qdrant.service` |
| OpenCode Agent | 4097 | tylko podgląd (serwer lokalny) |
| GitLab / Control Center | 443 / 80 | zewnętrzne (`192.168.8.90`, `10.50.10.70`) |

> ⚠️ **AI Crew Cockpit (`:5500`) jest wystawiony na całą sieć LAN** —
> `AI_CREW_WEB_HOST=0.0.0.0` w `/home/mg/projekty/ai_crew/.env` — i **nie ma
> uwierzytelniania**, więc każde urządzenie w `192.168.8.0/24` może uruchamiać
> zadania agentów. Aby to ograniczyć, ustaw w tym pliku
> `AI_CREW_WEB_HOST=127.0.0.1` (tylko tunel SSH) albo `100.103.76.25`
> (tylko Tailscale) i wykonaj `systemctl --user restart ai-crew-cockpit`.

Pozostałe wpisy (Recoll, Open WebUI, Portainer, Syncthing, Document Analyzer,
Excel Form Mapper, Plan Finansowy, Gra MZK, 2KRS, ai_crew Docker) są oznaczone
jako **wyłączone**: to projekty archiwalne w `/home/mg/projekty/archiwalne/`
albo aplikacje, których nie ma w obecnej instalacji. Panel pokazuje je jako
`disabled` i nie odpytuje ich portów.

### Dlaczego AI Analiza i Qdrant są „tylko podgląd”

`aianalizator.service` i `qdrant.service` to usługi systemowe zarządzane przez
root. Użytkownik `mg` nie ma uprawnień (polkit zwraca `Interactive authentication
required`), więc panel nie może ich zatrzymać ani zrestartować. Ręcznie:

```bash
sudo systemctl restart aianalizator
sudo systemctl restart qdrant
```

Jeśli chcesz sterować nimi z panelu, dodaj regułę sudoers (`sudo visudo -f
/etc/sudoers.d/ai-crew-panel`):

```
mg ALL=(root) NOPASSWD: /usr/bin/systemctl restart aianalizator, /usr/bin/systemctl restart qdrant
```

i ustaw w `local_apps.json` komendy `sudo -n systemctl restart …`.

## Uruchamianie, restart, włączanie

Wszystkie ścieżki są instalowane przez `scripts/install-user-service.sh`.

```bash
# instalacja / aktualizacja jednostek + restart panelu
cd /home/mg/projekty/ai-crew-panel && ./scripts/install-user-service.sh

# panel
systemctl --user status  ai-crew-panel
systemctl --user restart ai-crew-panel
systemctl --user stop    ai-crew-panel
systemctl --user start   ai-crew-panel
systemctl --user enable  ai-crew-panel      # autostart po zalogowaniu/boocie (Linger=yes)

# watchdog (sprawdza /health co minutę i restartuje panel, gdy nie odpowiada)
./watchdog.sh -v
systemctl --user status ai-crew-panel-watchdog.timer
systemctl --user list-timers ai-crew-panel-watchdog.timer

# logi
journalctl --user -u ai-crew-panel -f
```

Pliki jednostek:

| Plik | Przeznaczenie |
|------|---------------|
| `ai-crew-panel.service` | sam panel (port z `.env`) |
| `ai-crew-panel-watchdog.service` | jednorazowy test `/health` |
| `ai-crew-panel-watchdog.timer` | uruchamia watchdog co minutę |
| `scripts/install-user-service.sh` | instalator wszystkich powyższych |

## Konfiguracja

Konfiguracja panelu: `.env` (wzór w `.env.example`).

* `PORT` / `HOST` — port i interfejs nasłuchu panelu (domyślnie `5057`, `0.0.0.0`).
* `PUBLIC_HOST` — `auto` (domyślnie) = adres wykrywany z interfejsów;
  ustaw ręcznie tylko dla nazwy DNS / reverse-proxy.
* `OLLAMA_URL`, `OLLAMA_PRIMARY_URL/NAME`, `OLLAMA_SECONDARY_URL/NAME` — endpointy
  i etykiety routera Ollama.
* `N8N_API_KEY` — klucz do zakładki n8n.
* `MAX_EVENTS` — długość bufora zdarzeń.

Katalog aplikacji: `local_apps.json` (edytowalny też z UI; plik jest pilnowany
i przeładowywany na żywo).

## Struktura kodu

| Plik | Rola |
|------|------|
| `server.js` | API HTTP, wykrywanie `PUBLIC_HOST`, proxy n8n/Ollama |
| `server-manager.js` | katalog aplikacji, statusy, start/stop/restart, skan portów |
| `gpu-monitor.js` | wykrywanie GPU (NVIDIA/AMD), RAM, status Ollama |
| `ollama-router.js` | wybór endpointu Ollama dla zadania |
| `dashboard.html` | GUI (zakładki: aplikacje + GPU, workflowy n8n) |
