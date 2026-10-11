# Restartowanie usług — AI Crew Panel

## Jak panel restartuje aplikacje

Panel nie zabija procesów „na ślepo”. Dla każdego wpisu w `local_apps.json`
używa strategii dopasowanej do tego, jak aplikacja jest uruchomiona:

| `stopCommand` / `stopStrategy` | Zachowanie |
|-------------------------------|-----------|
| `stopCommand` (np. `systemctl --user stop …`, `docker compose stop`) | wykonuje dokładnie tę komendę |
| `docker` | `docker stop <kontener>`, a gdy to zawiedzie — `docker compose stop` w katalogu wpisu |
| `sigterm` | SIGTERM (500 ms), potem SIGKILL na procesie trzymającym port |
| `none` | wpis tylko monitorowany — panel nie próbuje nic zatrzymywać |

Start = `startCommand` z `local_apps.json`. Restart = stop + 1 s przerwy + start.
Jeżeli katalog roboczy wpisu nie istnieje, panel uruchamia komendę w katalogu
domowym (nie blokuje to usług systemowych ani kontenerów Docker).

## API

```bash
# restart jednej aplikacji
curl -X POST http://127.0.0.1:5057/api/apps/ai-crew-cockpit/restart | jq

# start / stop
curl -X POST http://127.0.0.1:5057/api/apps/n8n/start | jq
curl -X POST http://127.0.0.1:5057/api/apps/n8n/stop  | jq

# restart wszystkich zarządzalnych wpisów z „enabled”
curl -X POST http://127.0.0.1:5057/api/apps/restart-enabled | jq

# historia operacji
curl -s "http://127.0.0.1:5057/api/operations/log?limit=20" | jq
```

`restart-enabled` pomija sam panel (przerwanie własnego żądania HTTP przerwałoby
pętlę) oraz wpisy bez `startCommand`.

Przykładowa odpowiedź restartu:

```json
{
  "ok": true,
  "message": "AI Crew Cockpit started",
  "duration": 805,
  "pid": 1923327,
  "stop": { "ok": true, "message": "AI Crew Cockpit stopped via stopCommand" }
}
```

## Co da się zrestartować z panelu na tym hoście

| Aplikacja | Komenda | Uwaga |
|-----------|---------|-------|
| AI Crew Panel | `systemctl --user restart ai-crew-panel` | usługa użytkownika |
| AI Crew Cockpit | `systemctl --user restart ai-crew-cockpit` | usługa użytkownika |
| new-api | `cd /home/mg/projekty/new-api && docker compose up -d` | kontener `new-api` |
| n8n | `cd /home/mg/projekty/n8n && docker compose up -d` | kontener `n8n` |
| KRS Viewer | `cd /home/mg/projekty/krs_viewer_app && docker compose up -d` | `express-server`, `krs-caddy`, `postgres-db` |

Wymaga `docker` w grupach użytkownika `mg` oraz `XDG_RUNTIME_DIR` w środowisku
usługi panelu — oba warunki spełnia `ai-crew-panel.service` z tego repo.

## Czego panel NIE zrestartuje

* `aianalizator.service` (AI Analiza Dokumentów) i `qdrant.service` — to usługi
  systemowe roota; polkit odmawia użytkownikowi `mg` (`Interactive authentication
  required`). Ręcznie: `sudo systemctl restart aianalizator`.
* Wpisy oznaczone `enabled: false` (projekty archiwalne, aplikacje nieobecne
  na tym hoście) — panel pokazuje je jako `disabled`.

Szczegóły i opcjonalna reguła sudoers: patrz `README.md`.

## Watchdog panelu

Panel bywa „żywy”, ale bez działającego nasłuchu HTTP — `Restart=always` tego nie
wykryje, bo proces się nie kończy. Dlatego `watchdog.sh` sprawdza `/health` i
restartuje usługę; uruchamia go `ai-crew-panel-watchdog.timer` co minutę.

```bash
./watchdog.sh          # cichy, raportuje tylko problem
./watchdog.sh -v       # raportuje zawsze
systemctl --user list-timers ai-crew-panel-watchdog.timer
journalctl --user -u ai-crew-panel-watchdog -n 20
```

## Troubleshooting

```bash
# czy port jest zajęty i kto go trzyma
ss -tlnp | grep -E '5057|5500|5678|3000|5080'
lsof -i :5057

# logi panelu
journalctl --user -u ai-crew-panel -n 50 --no-pager

# stan wszystkich jednostek panelu
systemctl --user status ai-crew-panel ai-crew-panel-watchdog.timer
```
