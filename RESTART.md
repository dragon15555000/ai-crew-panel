# Funkcje Restartowania Usług - AI Crew Panel

## Przegląd

Panel zawiera wbudowane funkcje do restartowania usług bez potrzeby ręcznego logowania na serwer.

## API Endpointy

### 1. `POST /restart/:serviceName` - Restart usługi

Restartuje usługę poprzez zabienie procesu na porcie.

```bash
# Restart AI Analiza Dokumentów
curl -X POST http://localhost:5057/restart/AI%20Analiza%20Dokumentów

# Restart n8n
curl -X POST http://localhost:5057/restart/n8n
```

**Odpowiedź:**
```json
{
  "ok": true,
  "service": "AI Analiza Dokumentów",
  "log": {
    "ts": "2026-06-24T10:03:45.123Z",
    "service": "AI Analiza Dokumentów",
    "port": 5000,
    "status": "killed",
    "message": "Found process PID 1234 on port 5000 → killed",
    "duration": 523
  }
}
```

### 2. `GET /restart/log` - Historia restartów

Wyświetla ostatnie 50 prób restartowania usług.

```bash
curl http://localhost:5057/restart/log
```

**Odpowiedź:**
```json
{
  "ok": true,
  "log": [
    {
      "ts": "2026-06-24T10:03:45.123Z",
      "service": "n8n",
      "port": 5678,
      "status": "killed",
      "message": "Found process PID 5432 on port 5678 → Force killing PID 5432",
      "duration": 850
    },
    ...
  ],
  "total": 15
}
```

### 3. `GET /restart/services` - Lista usług do restartowania

```bash
curl http://localhost:5057/restart/services
```

**Odpowiedź:**
```json
{
  "ok": true,
  "services": [
    { "name": "ai_crew Cockpit", "port": 5055 },
    { "name": "new-api", "port": 3000 },
    { "name": "DocPortal", "port": 5056 },
    { "name": "AI Analiza Dokumentów", "port": 5000 },
    { "name": "ai-crew-panel", "port": 5057 },
    { "name": "n8n", "port": 5678 }
  ]
}
```

## UI Dashboard

### Przycisk Restart

W tabeli "Status usług" każda usługa ma przycisk **"⟳ Restart"**:

1. Kliknij przycisk
2. Panel znajduje proces na porcie
3. Wysyła sygnał SIGTERM (graceful shutdown)
4. Po 500ms, jeśli jeszcze działa, wysyła SIGKILL (force kill)
5. Toast notification pokazuje wynik

### Przycisk Restart Log

W nagłówku "Status usług" jest przycisk **"Restart Log"** który wyświetla historię ostatnich restartów.

## Konfiguracja Automatycznego Restartowania

Aby automatycznie uruchomić usługę po zabójciu procesu, ustaw zmienne środowiskowe:

```bash
export CMD_AI_CREW="cd /path/to/ai_crew && npm start &"
export CMD_NEW_API="cd /path/to/new-api && python main.py &"
export CMD_DOC_PORTAL="cd /path/to/doc_portal && gunicorn app:app &"
export CMD_AI_ANALIZA="cd /path/to/ai_analiza && python app.py &"
export CMD_PANEL="cd /path/to/panel && node server.js &"
export CMD_N8N="cd /path/to/n8n && n8n start &"

node server.js
```

## Statusy Restartowania

| Status | Znaczenie |
|--------|-----------|
| `killed` | Proces znaleziony i zabity |
| `no_process` | Brak procesu na porcie |
| `restarted` | Proces zabity + komendy restartowania wykonane |
| `restart_failed` | Proces zabity, ale restart nie powiódł się |
| `error` | Błąd podczas restartowania |
| `pending` | Restart w trakcie |

## Zachowanie Restartowania

1. **Znalezienie procesu**: `lsof -i :PORT -t` - znajduje PID procesu na porcie
2. **SIGTERM**: Najpierw wysyła sygnał SIGTERM (graceful shutdown)
3. **Czekanie**: Czeka 500ms na zamknięcie procesu
4. **SIGKILL**: Jeśli proces wciąż działa, wysyła SIGKILL (force kill)
5. **Czekanie**: Czeka 300ms na pełne zamknięcie
6. **Restart (opcjonalny)**: Jeśli jest ustawiona komenda restartowania, ją wykonuje

## Przykłady

### Restart usługi z CLI

```bash
# Restart n8n
curl -X POST http://localhost:5057/restart/n8n

# Restart AI Analiza Dokumentów
curl -X POST http://localhost:5057/restart/AI%20Analiza%20Dokumentów
```

### Pobierz historię restartów

```bash
curl http://localhost:5057/restart/log | jq '.log[0]'
```

### Skrypt do masowego restartowania

```bash
#!/bin/bash
PANEL="http://localhost:5057"
SERVICES=(
  "ai_crew Cockpit"
  "new-api"
  "DocPortal"
  "AI Analiza Dokumentów"
  "n8n"
)

for service in "${SERVICES[@]}"; do
  echo "Restarting: $service"
  curl -X POST "$PANEL/restart/$(echo "$service" | sed 's/ /%20/g')"
  sleep 2
done
```

## Bezpieczeństwo

- Restart można wykonać z UI panelu (URL `http://localhost:5057`)
- Dostęp do endpointów `/restart/*` jest publiczny
- **⚠️ W produkcji** dodaj autentykację (JWT, OAuth2 itp.)

## Troubleshooting

### Restart nie działa

1. Sprawdź czy usługa rzeczywiście działa:
   ```bash
   curl http://localhost:5000/health  # Dla AI Analiza
   ```

2. Sprawdź czy port jest zajęty:
   ```bash
   lsof -i :5000
   ```

3. Sprawdź logi restartów:
   ```bash
   curl http://localhost:5057/restart/log
   ```

### Usługa nie restartuje się automatycznie

Ustaw komendę restartowania:
```bash
export CMD_AI_ANALIZA="cd /home/user/ai-analiza && python app.py > /tmp/ai-analiza.log 2>&1 &"
node server.js
```

## Integracja z n8n

Możesz stworzyć workflow w n8n, który wywoła restart usługi:

```json
{
  "nodes": [
    {
      "name": "HTTP Request",
      "type": "n8n-nodes-base.httpRequest",
      "parameters": {
        "method": "POST",
        "url": "http://localhost:5057/restart/n8n",
        "authentication": "none"
      }
    }
  ]
}
```

