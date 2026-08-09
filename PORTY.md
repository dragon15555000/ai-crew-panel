# Konfiguracja Portów - AI Crew Panel

## Aktualne Porty

| Usługa | Domyślny Port | Zmienna Środowiska |
|--------|---------------|--------------------|
| AI Crew Cockpit | 5055 | `PORT_AI_CREW_COCKPIT` |
| new-api | 3000 | `PORT_NEW_API` |
| DocPortal | 5056 | `PORT_DOC_PORTAL` |
| AI Analiza Dokumentów | 5000 | `PORT_AI_ANALIZA` |
| ai-crew-panel | 5057 | `PORT_PANEL` |
| n8n | 5678 | `PORT_N8N` |

## Zajęte Porty (skan z 2026-06-24)

```
Port 5000:  ZAJĘTY (Python - AI Analiza)
Port 5056:  ZAJĘTY (Flask - DocPortal)
Port 5057:  ZAJĘTY (Node - ai-crew-panel)
Port 5678:  ZAJĘTY (n8n)
Port 11434: ZAJĘTY (Ollama)
Port 11435: ZAJĘTY (Ollama)
Port 34219: ZAJĘTY
Port 38775: ZAJĘTY
```

## Zmiana Portów

### Metoda 1: Zmienne Środowiskowe

```bash
export PORT_AI_CREW_COCKPIT=5100
export PORT_NEW_API=3100
export PORT_DOC_PORTAL=5101
export PORT_AI_ANALIZA=5102
export PORT_PANEL=5103
export PORT_N8N=5104

node server.js
```

### Metoda 2: .env plik

Utwórz `.env` w katalogu projektu:
```
PORT_AI_CREW_COCKPIT=5100
PORT_NEW_API=3100
PORT_DOC_PORTAL=5101
PORT_AI_ANALIZA=5102
PORT_PANEL=5103
PORT_N8N=5104
```

Następnie załaduj:
```bash
source .env
node server.js
```

## Nowe Endpointy API

### 1. `/ports/config` - Aktualna Konfiguracja Portów

```bash
curl http://localhost:5057/ports/config
```

Odpowiedź:
```json
{
  "ok": true,
  "portConfig": {
    "AI_CREW_COCKPIT": 5055,
    "NEW_API": 3000,
    "DOC_PORTAL": 5056,
    "AI_ANALIZA": 5000,
    "PANEL": 5057,
    "N8N": 5678
  },
  "env": {
    "PORT_AI_CREW_COCKPIT": "not set",
    "PORT_NEW_API": "not set",
    "PORT_DOC_PORTAL": "not set",
    "PORT_AI_ANALIZA": "not set",
    "PORT_PANEL": "not set",
    "PORT_N8N": "not set"
  }
}
```

### 2. `/ports/available` - Skanowanie Dostępnych Portów

```bash
# Domyślnie skanuje 5000-50100, zwraca 20 dostępnych portów
curl http://localhost:5057/ports/available

# Z parametrami
curl 'http://localhost:5057/ports/available?start=6000&end=6100'
```

Odpowiedź:
```json
{
  "ok": true,
  "available": [5001, 5002, 5003, ...],
  "occupied": [5000, 5056, 5057, 5678, ...],
  "rangeStart": 5000,
  "rangeEnd": 50100,
  "message": "Found available ports in range"
}
```

## Dashboard UI

Panel (:5057) zawiera przycisk **"Port Config"** w sekcji "Status usług", 
który wyświetla aktualną konfigurację portów.

## Rekomendacje

1. **Sprawdź Dostępne Porty**: Użyj `/ports/available` aby znaleźć wolne porty
2. **Ustaw Zmienne**: Wybierz dostępne porty i ustaw zmienne środowiskowe
3. **Zrestartuj Usługi**: Przeznacz każdej usłudze nowy port

## Przykład Konfiguracji Alternatywnych Portów

Jeśli domyślne porty są zajęte, użyj:

```bash
export PORT_AI_CREW_COCKPIT=6055
export PORT_NEW_API=6000
export PORT_DOC_PORTAL=6056
export PORT_AI_ANALIZA=6100
export PORT_PANEL=6057
export PORT_N8N=6678

node server.js
```

Następnie zmień konfigurację w każdej usłudze (każdy serwis ma swoją konfigurację portów).
