# AI Crew Panel

Lokalny panel do zarządzania i podglądu statusu aplikacji uruchomionych w środowisku deweloperskim.

## Porty lokalne

Poniższe zestawienie przedstawia alokację portów w lokalnym środowisku deweloperskim:
* **3000** - `new-api` (Bramka/baza modeli LLM)
* **5055** - `ai_crew` Cockpit (Główny panel sterowania)
* **5056** - `DocPortal` (Gunicorn/Flask lista dokumentów)
* **5058** - `ai-crew-panel` (Ten panel)

## Funkcje panelu

* Podgląd stanu aplikacji i usług w jednym miejscu
* Szybkie akcje: start, stop, restart, health check
* Ręczny skan portów i dodawanie wykrytych wpisów do katalogu
* Podsumowanie stanu środowiska, filtracja i wyszukiwanie
* Historia operacji i lista problemów do sprawdzenia

## Adresy i endpointy panelu

* **Strona główna panelu:** [http://127.0.0.1:5058](http://127.0.0.1:5058)
* **Health:** `GET http://127.0.0.1:5058/health`
* **Lista aplikacji:** `GET http://127.0.0.1:5058/api/apps`
* **Status pojedynczej aplikacji:** `GET http://127.0.0.1:5058/api/apps/:appId/status`
* **Start aplikacji:** `POST http://127.0.0.1:5058/api/apps/:appId/start`
* **Stop aplikacji:** `POST http://127.0.0.1:5058/api/apps/:appId/stop`
* **Restart aplikacji:** `POST http://127.0.0.1:5058/api/apps/:appId/restart`
* **Restart włączonych aplikacji:** `POST http://127.0.0.1:5058/api/apps/restart-enabled`
* **Szczegóły aplikacji:** `GET http://127.0.0.1:5058/api/apps/:appId/details`
* **Edycja konfiguracji aplikacji:** `PATCH http://127.0.0.1:5058/api/apps/:appId`
* **Log operacji:** `GET http://127.0.0.1:5058/api/operations/log`
* **Dodanie wykrytego portu do katalogu:** `POST http://127.0.0.1:5058/api/apps/discover/:port`
* **Ręczny skan portów:** `POST http://127.0.0.1:5058/api/scan`
* **Odświeżenie danych panelu:** `POST http://127.0.0.1:5058/api/refresh`

## Autostart

W repo znajduje się gotowy unit `ai-crew-panel.service` dla `systemd`. Po instalacji w `/etc/systemd/system/` i włączeniu `systemctl enable --now ai-crew-panel.service` panel startuje automatycznie przy starcie systemu.

Przykład instalacji:

```bash
sudo install -Dm644 ai-crew-panel.service /etc/systemd/system/ai-crew-panel.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-crew-panel.service
```

## Konfiguracja

Domyślny port panelu to `5058`. Możesz go nadpisać zmienną środowiskową `PORT`.
Panel domyślnie wiąże się do `127.0.0.1`. Jeśli chcesz wystawić go szerzej, ustaw `HOST=0.0.0.0`.

## OpenCode i lokalne Ollama

OpenCode w kontenerze `opencode-test` ma skonfigurowane dwa lokalne providery Ollama:

* `ollama-amd` - AMD/Vulkan na `http://172.17.0.1:11435/v1`
* `ollama-nvidia` - NVIDIA GTX 1080 na `http://172.17.0.1:11434/v1`

Domyślny działający model OpenCode to `ollama-amd/qwen2.5:3b`. NVIDIA jest widoczna w OpenCode jako provider rezerwowy i przyszły mocniejszy backend, ale obecne modele `ollama-nvidia/llama3:8b` oraz `ollama-nvidia/deepseek-coder:6.7b` nie raportują obsługi tool-callingu wymaganej dla głównego agenta kodującego OpenCode.

Backup poprzedniej konfiguracji OpenCode znajduje się w kontenerze:

```bash
/root/.config/opencode/opencode.jsonc.bak.20260707131450
```
