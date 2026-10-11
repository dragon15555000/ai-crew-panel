# Konfiguracja portów — AI Crew Panel

## Porty usług lokalnych (stan faktyczny 2026-09-28, host 192.168.8.209)

| Usługa | Port | Zmienna `.env` | Zarządzanie |
|--------|------|----------------|-------------|
| AI Crew Panel | 5057 | `PORT` / `PORT_PANEL` | `systemctl --user restart ai-crew-panel` |
| AI Crew Cockpit | 5500 | `PORT_AI_CREW_COCKPIT` | `systemctl --user restart ai-crew-cockpit` |
| new-api (LLM Gateway) | 3000 | `PORT_NEW_API` | Docker |
| n8n | 5678 | `PORT_N8N` | Docker |
| KRS Viewer | 5080 | — | Docker |
| AI Analiza Dokumentów | 5000 | `PORT_AI_ANALIZA` | usługa systemowa (root) |
| Qdrant | 6333 / 6334 | — | usługa systemowa (root) |
| Ollama | 11434 | `OLLAMA_URL` | usługa systemowa (root) |
| bitrix_planowanie (uvicorn) | 8077 | — | poza panelem |
| Nginx (proxy → :5000) | 80 / 443 | — | usługa systemowa |
| Postgres KRS | 5433 | — | Docker (`postgres-db`) |
| Postgres test KRS | 5434 | — | Docker (`krs-postgres-test-db`) |

Porty zarezerwowane w katalogu, ale aktualnie wolne (wpisy wyłączone):
`5056` (Document Analyzer), `5058` (Excel Form Mapper), `5555` (Plan Finansowy),
`8088` (2KRS), `8090` (Gra MZK), `9000` (Portainer), `3001` (Open WebUI),
`8384` (Syncthing), `8765` (Recoll MCP), `9090` (Recoll WebUI), `5059` (ai_crew Docker).

## Zmiana portu panelu

### Metoda 1: `.env` (zalecane)

```bash
cd /home/mg/projekty/ai-crew-panel
# edytuj PORT w .env
systemctl --user restart ai-crew-panel
curl -s http://127.0.0.1:NEW_PORT/health
```

### Metoda 2: jednorazowo ze zmienną środowiskową

```bash
PORT=5103 node server.js
```

Watchdog czyta port z `.env`, więc nie trzeba go osobno przestawiać.

## Endpointy diagnostyczne

### `GET /health`

```json
{
  "ok": true,
  "service": "ai-crew-panel",
  "managerReady": true,
  "publicHost": "192.168.8.209",
  "publicHostSource": "auto",
  "requestHost": null,
  "panelUrl": "http://192.168.8.209:5057"
}
```

`publicHostSource` przyjmuje wartości `auto` (adres wykryty z interfejsów)
albo `env` (wymuszony przez `PUBLIC_HOST`).

### `POST /api/scan`

Skanuje zakres 3000–9000 i zapisuje porty nieprzypisane do żadnego wpisu
w katalogu. Wynik trafia do sekcji „Wykryte porty”.

## Jak panel wybiera adres IP

1. `PUBLIC_HOST` / `SERVER_HOST` z `.env`, jeśli ustawione i różne od `auto`.
2. W przeciwnym razie pierwszy nie-wewnętrzny adres IPv4, w kolejności
   preferencji: `192.168.x.x` → `10.x.x.x` → inne → `172.16-31.x.x` (Docker)
   → `100.x.x.x` (Tailscale).

Dzięki temu kopia panelu przeniesiona na inny serwer sama wygeneruje poprawne
linki do aplikacji — bez edycji kodu i bez zaszytego na stałe IP.
