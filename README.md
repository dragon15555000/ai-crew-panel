# AI Crew Panel

Szybki lokalny panel podglądu zdarzeń i decyzji przesyłanych przez n8n lub bezpośrednio z webhooków.

## Porty lokalne

Poniższe zestawienie przedstawia alokację portów w lokalnym środowisku deweloperskim:
* **3000** - `new-api` (Bramka/baza modeli LLM)
* **5055** - `ai_crew` Cockpit (Główny panel sterowania)
* **5056** - `DocPortal` (Gunicorn/Flask lista dokumentów)
* **5057** - `ai-crew-panel` (Ten panel zdarzeń)

## Instrukcje i przykłady integracji

### Adresy i endpointy panelu
* **Strona główna panelu:** [http://127.0.0.1:5057](http://127.0.0.1:5057)
* **Endpoint zapisu zdarzeń:** `POST http://127.0.0.1:5057/ai-crew-events`
* **Status usługi (Health):** `GET http://127.0.0.1:5057/health`
* **Zdarzenia w formacie JSON:** `GET http://127.0.0.1:5057/events`

### Konfiguracja n8n (HTTP Request Node)

* **Metoda:** `POST`
* **URL:** `http://127.0.0.1:5057/ai-crew-events` (lub `http://host.docker.internal:5057/ai-crew-events` jeśli n8n działa w Dockerze)
* **Content-Type:** `JSON`

#### JSON Body do wklejenia w n8n:
```json
{
  "jobId": "{{$json.jobId || $json.body?.jobId || $execution.id}}",
  "project": "{{$json.project || $json.body?.project || 'ai_crew'}}",
  "branch": "{{$json.branch || $json.body?.branch || ''}}",
  "riskLevel": "{{$json.riskLevel || $json.body?.riskLevel || 'unknown'}}",
  "isDestructive": "{{$json.isDestructive || false}}",
  "recommendedAction": "{{$json.recommendedAction || 'review'}}",
  "status": "waiting_approval",
  "summary": "{{$json.summary || $json.body?.summary || ''}}",
  "jobUrl": "{{$json.jobUrl || ''}}"
}
```
