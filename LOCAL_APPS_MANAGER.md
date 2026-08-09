# Local Apps Manager

## 📦 Przegląd

Centralne centrum zarządzania lokalnymi aplikacjami. Manager umożliwia:

- **Rejestr aplikacji** - lista wszystkich znanych aplikacji z konfiguracją
- **Status aplikacji** - monitorowanie portów, health checks, procesów
- **Bezpieczne operacje** - Start/Stop/Restart tylko dla zarejestrowanych aplikacji
- **Zależności** - Qdrant i inne usługi jako zależności
- **Scanner portów** - automatyczne skanowanie portów 3000-9000 co 4 godziny
- **Historia operacji** - log wszystkich akcji start/stop/restart

## 📂 Struktura Plików

```
ai-crew-panel/
├── server.js                   # Backend Express API
├── server-manager.js           # Logika managera (klasa LocalAppsManager)
├── local_apps.json             # Rejestr aplikacji
├── dashboard.html              # UI - karty aplikacji
├── tests.js                    # Testy jednostkowe
├── RESTART.md                  # Dokumentacja restartowania
├── PORTY.md                    # Konfiguracja portów
└── LOCAL_APPS_MANAGER.md       # Ta dokumentacja
```

## 🚀 Uruchomienie

```bash
cd /home/dragon/projekty/ai-crew-panel
npm install  # jeśli potrzebne

PORT=5057 node server.js
```

Otworz: **http://localhost:5057**

## 📋 Rejestr Aplikacji (`local_apps.json`)

Każda aplikacja ma konfigurację:

```json
{
  "id": "ai-crew-cockpit",
  "name": "AI Crew Cockpit",
  "path": "/home/dragon/projekty/ai_crew",
  "port": 5055,
  "type": "python",
  "startCommand": "cd ... && python -m server",
  "stopStrategy": "sigterm",
  "healthUrl": "/ping",
  "description": "...",
  "dependencies": ["qdrant"],
  "enabled": true,
  "status": "unknown"
}
```

### Aplikacje w Rejestrze

| ID | Nazwa | Port | Typ | Status |
|----|----|------|-----|--------|
| `ai-crew-cockpit` | AI Crew Cockpit | 5055 | python | configured |
| `ai-analiza-dokumentow` | AI Analiza Dokumentów | 5000 | python | configured |
| `new-api` | new-api (LLM Gateway) | 3000 | go | configured |
| `doc-portal` | Doc Portal | 5056 | python | configured |
| `n8n` | n8n | 5678 | node | configured |
| `document-analyzer` | Document Analyzer | — | python | missing_port |
| `gra-mzk` | Gra MZK | — | unknown | not_configured |
| `excel-form-mapper` | Excel Form Mapper | — | python | missing_port |
| `plan-finansowy` | Plan Finansowy | — | unknown | not_configured |

### Zależności

```json
{
  "qdrant": {
    "name": "Qdrant Vector DB",
    "port": 6333,
    "type": "service",
    "startCommand": "docker run -d --name qdrant -p 6333:6333 qdrant/qdrant",
    "status": "not_running"
  },
  "sqlserver": {
    "name": "SQL Server",
    "port": 1433,
    "type": "service",
    "status": "external_service"
  }
}
```

## 🔌 API Endpointy

### Status Aplikacji

```bash
# Get all apps
GET /api/apps

# Get single app status
GET /api/apps/{appId}/status

# Responses
{
  "id": "ai-crew-cockpit",
  "name": "AI Crew Cockpit",
  "port": 5055,
  "status": "running|stopped|missing_port|missing_path|error|unknown",
  "details": {
    "portOpen": true,
    "healthOk": true
  }
}
```

### Operacje Start/Stop/Restart

```bash
# Start
POST /api/apps/{appId}/start
# Response: { ok: true, message: "...", duration: 523 }

# Stop
POST /api/apps/{appId}/stop
# Response: { ok: true, message: "Process on port 5055 stopped", pid: 1234, duration: 850 }

# Restart
POST /api/apps/{appId}/restart
# Response: { ok: true, message: "..." }
```

**Bezpieczeństwo:**
- Start: wymaga `enabled=true`, `startCommand` i `path`
- Stop: wymaga `stopStrategy="sigterm"` i otwartego portu
- Restart: wymaga spełnienia warunków dla both start i stop

### Historia Operacji

```bash
GET /api/operations/log?limit=50

# Response
{
  "log": [
    {
      "ts": "2026-06-24T11:30:45.123Z",
      "appId": "ai-crew-cockpit",
      "action": "start|stop|restart",
      "result": "success|failed",
      "error": null,
      "duration": 523
    },
    ...
  ]
}
```

### Dodawanie Nowych Aplikacji

```bash
# Discover i dodaj do rejestru
POST /api/apps/discover/{port}
Content-Type: application/json
{"name": "Moja aplikacja"}

# Response
{
  "ok": true,
  "app": {
    "id": "discovered-3000-1719238245000",
    "name": "Moja aplikacja",
    "port": 3000,
    "status": "discovered"
  }
}
```

## 🎨 UI Dashboard

### Karty Aplikacji

Każda aplikacja pokazana jest jako karta z:
- **Nazwa i status** (running/stopped/unknown)
- **Port, typ, ścieżka**
- **Zależności** (jeśli są)
- **Przyciski akcji:**
  - `▶ Start` - dostępny jeśli app enabled i ma startCommand
  - `⏹ Stop` - dostępny jeśli app running i ma safe stop
  - `🔍 Check` - sprawdzenie health endpoint

### Sekcje

1. **Zarejestrowane Aplikacje** - wszystkie wpisy z local_apps.json
2. **Wykryte Porty** - wyniki z skanera portów (każda godzina co 4h)
3. **Historia Operacji** - ostatnie 20 operacji start/stop/restart

## 🔍 Scanner Portów

- **Zakres:** 3000-9000
- **Częstotliwość:** co 4 godziny (automatycznie)
- **Działanie:**
  - Skanuje wolno (timeouty 100ms)
  - Wyklucza porty znanych aplikacji
  - Zapisuje wyniki do `local_apps.json["discovered"]`
  - UI oferuje dodanie do rejestru

### Statusy Skanowania

- `port_open` - port otwarty ale brak HTTP
- `http_ok` - HTTP 2xx/3xx/4xx
- `port_closed` - brak odpowiedzi

## 🛡️ Bezpieczeństwo

### Co jest bezpieczne

✅ Operacje na aplikacjach z rejestru  
✅ SIGTERM graceful shutdown  
✅ Health checks na localhost  
✅ Logowanie wszystkich akcji  
✅ Bez sudo, systemctl, Dockera (bez konfiguracji)  

### Co jest zakazane

❌ Zabijanie dowolnych procesów po porcie  
❌ Uruchamianie nieznanych komend  
❌ Ujawnianie .env, tokenów, kluczy  
❌ Dostęp do płatnych API  
❌ Modyfikacja konfiguracji app  

## 🧪 Testy

```bash
node tests.js

# Results
✓ Test 1: Load config
✓ Test 2: Port check
✓ Test 3: Missing app check
✓ Test 4: Operation logging
✓ Test 5: Safe stop validation
✓ Test 6: Add discovered app
```

## 📊 Braki Konfiguracji

Aplikacje wymagające konfiguracji:

| App | Problem | Rozwiązanie |
|-----|---------|------------|
| `document-analyzer` | `missing_port` | Określić port w konfiguracji |
| `gra-mzk` | `not_configured` | Znaleźć startCommand i port |
| `excel-form-mapper` | `missing_port` | Określić port w konfiguracji |
| `plan-finansowy` | `not_configured` | Znaleźć startCommand i port |

## 📝 Zmienione Pliki

### Nowe pliki
- `server.js` - Backend (3.8 KB)
- `server-manager.js` - Logika managera (7.0 KB)
- `local_apps.json` - Rejestr (4.8 KB)
- `dashboard.html` - UI (13 KB)
- `tests.js` - Testy (3.8 KB)
- `LOCAL_APPS_MANAGER.md` - Ta dokumentacja

### Istniejące pliki
- `PORTY.md` - Niezmieniony
- `RESTART.md` - Niezmieniony
- `.env.example` - Niezmieniony

## 🔄 Workflow

1. **Startup**
   - Manager wczytuje `local_apps.json`
   - Uruchamia skaner portów (pierwszy raz natychmiast)
   - Dashboard dostępny na http://localhost:5057

2. **Monitoring**
   - Co 5 sekund: świeża lista statusów aplikacji
   - Co 5 sekund: historia operacji

3. **Operacja Start/Stop/Restart**
   - User kliknie przycisk
   - API waliduje możliwość operacji
   - Wykonuje SIGTERM/SIGKILL/start
   - Loguje wynik
   - UI odświeża status

4. **Scanner Portów**
   - Każde 4 godziny: skanowanie 3000-9000
   - Wyniki w `discovered[]`
   - User może dodać do rejestru

## 🚨 Troubleshooting

### Panel nie startuje
```bash
node -c server.js     # Sprawdzenie składni
node server.js        # Uruchomienie bez tła
```

### Aplikacja nie startuje
- Sprawdzić `enabled: true` w local_apps.json
- Sprawdzić `startCommand` i `path`
- Czytać Historia Operacji w UI

### Port już zajęty
- Sprawdzić `netstat -tulpn | grep PORT`
- Zabić stary proces: `pkill -f "node.*server.js"`

### Brak health check
- Część aplikacji może nie mieć `/health` endpoint
- Manager próbuje root `/` jeśli `healthUrl` null
- Zawsze pokazuje `port_open` nawet bez HTTP

## 📦 Konfiguracja Qdrant

Aby uruchomić Qdrant:

```bash
# Automatycznie (jeśli Docker zainstalowany)
# Z UI: kliknij "Start" na karcie Qdrant

# Ręcznie
docker run -d --name qdrant -p 6333:6333 qdrant/qdrant

# Sprawdzenie
curl http://localhost:6333/health
```

## 🔮 Co Dalej

Backlog:
1. Konkretne komendy startowe dla `document-analyzer`, `gra-mzk`, `plan-finansowy`
2. Konfiguracja Qdrant (Docker vs lokalnie)
3. UI do edycji rejestru
4. Monitoring CPU/Memory
5. Alerting jeśli app pada

