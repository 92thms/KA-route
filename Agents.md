# Agents.md

> Leitplanken, Rollen, Aufgaben, Akzeptanzkriterien und Prompts für alle AI-Agenten, die an **ka-route** (Arbeitsname „Klanavo“) mitwirken.

## 0) Projekt-Kurzbeschreibung

- **Ziel:** Entlang frei wählbarer Routen Kleinanzeigen finden und auf einer Karte anzeigen.  
- **Architektur (aus dem Repo ersichtlich):**  
  - `api/` – FastAPI-Backend  
  - `web/` – leichtes Frontend  
  - `ops/` – Deployment/Infra  
  - `.env.example` – Beispiel-Konfiguration (u. a. `ORS_API_KEY`)  
  - `docker-compose.yml` – lokaler Stack
- **Wichtige nicht-funktionale Anforderungen (verbindlich):**
  1. **Web-UI ist immer deutsch.** Alle Labels, Texte, Fehlermeldungen, Validierungen im Web-UI ausschließlich auf Deutsch.
  2. **Geocoding/Routes nur serverseitig.** Client ruft niemals Dritt-APIs direkt auf.
  3. **Scraping nur im Backend.** Der Client lädt keine Detailseiten; er erhält nur bereits aufbereitete Daten.
  4. **API-Keys & Limits zentral im Backend.**
  5. **Caching & Throttling serverseitig:**  
     - Ergebnis-Cache (z. B. Schlüssel = `suchbegriff|plz|routeHash`).  
     - Max. **8 GB** belegter Plattenspeicher für Cache; vor Überschreitung löschen/eviktieren.  
     - Drosselung: **max. 1 Request/Sekunde pro Quell-API**; Queue + Backoff.

---

## 1) Globale Regeln für alle Agenten

1. **Keine Client-Side-Secrets.** Keine API-Keys, Tokens, Hostnamen im Browser, im Repo oder in Logs ausgeben.  
2. **Server-First Datenflüsse.** Alles, was externe Daten abruft oder rechnet, läuft im Backend; Frontend erhält nur verdichtete DTOs.  
3. **Deutsch im UI.** Neue UI-Strings immer in Deutsch anlegen; i18n-Platzhalter erlaubt, Default = „de“.  
4. **Deterministische Builds.** Reproduzierbare Docker-Builds; genaue Version-Pins in `requirements.txt`/`package.json`.  
5. **Testbarkeit.** Neue Funktionen nur mit klaren Schnittstellen, Mocks für externe Dienste, Minimierung flakiger Tests.  
6. **Observability.** Strukturierte Logs, Rate-Limit-Hits mitzählen, Cache-Trefferquote messen.  
7. **DSGVO/ToS-konform scrapen.** Robots/Terms beachten, aggressive Parallelisierung vermeiden.

---

## 2) Rollen & Verantwortungen

### 2.1 Backend-Agent (FastAPI)
**Ziele**
- Endpunkte für Suche, Routen-Abfrage, Ergebnisabruf bereitstellen.
- Caching, Throttling, Fehlerbehandlung implementieren.

**Aufgaben (Step-by-Step)**
1. Endpunkt-Verträge als Pydantic-Schemas definieren.  
2. Routen-/Geocoding-Calls über interne Service-Schicht kapseln.  
3. Ergebnis-Cache (LRU/TTL + 8 GB Limit) implementieren.  
4. Globales Rate-Limit (Token-Bucket oder Leaky-Bucket) pro Ziel-API.  
5. Strukturierte Logs + Metriken (Trefferquote, Latenz, 4xx/5xx).

**Akzeptanzkriterien**
- Frontend erhält niemals rohe HTML-Seiten der Quellen.  
- Bei Cache-Hit <100 ms Antwort; Cold-Path <3 s bei Normalfall.  
- Speichergrenze 8 GB wird nie überschritten; Eviction belegt testsicher.

---

### 2.2 Scraper-Agent
**Ziele**
- Serverseitiges Abrufen/Parsen der Kleinanzeigen.

**Aufgaben**
1. HTTP-Abruf mit respektvollem Crawl-Delay und Retry mit Exponential Backoff.  
2. Robuste Parser (HTML → strukturierte DTOs).  
3. Duplikat-Erkennung (anhand Anzeige-ID/URL).  
4. Normalisierung von Preis, Ort, Koordinaten, Zeitstempel.  
5. Übergabe nur bereinigter Felder an Backend-Service.

**Akzeptanzkriterien**
- Keine clientseitigen Fetches zu Quellportalen.  
- Parser toleriert gängige HTML-Abweichungen (Tests abdecken).  
- Opt-in Proxy/Rotating-User-Agent über Backend-Konfig steuerbar.

---

### 2.3 Caching/Rate-Limit-Agent
**Ziele**
- Performanz sichern, Missbrauch verhindern.

**Aufgaben**
1. Cache-Store wählen (z. B. Dateibasiert + Index oder Redis-Kompatibel).  
2. Keys: `query|plz|routeHash|page`.  
3. Eviction-Strategie: LRU + TTL; harte Obergrenze 8 GB.  
4. Rate-Limit: 1 RPS/Ziel-API; globale Queue; 429/Retry-After behandeln.

**Akzeptanzkriterien**
- Unit-Tests für Eviction bei Grenzwert.  
- Metriken: Hit-Rate, Bytes used, Drops durch Limit.

---

### 2.4 Frontend-Agent (Web)
**Ziele**
- Deutsche UI, nur mit Backend-DTOs arbeiten.

**Aufgaben**
1. Alle UI-Strings zentral deutsch definieren.  
2. Karten-Ansicht: Marker/Cluster aus Backend-DTOs.  
3. Kein direkter Aufruf externer APIs.  
4. Plausible Fehlermeldungen in Deutsch, ohne interne Details.

**Akzeptanzkriterien**
- Lighthouse-Performance > 90 lokal.  
- Null Vorkommen von API-Keys/Hostnames im Bundle.

---

### 2.5 DevOps-Agent
**Ziele**
- Lokaler Stack via `docker-compose`, reproduzierbar.

**Aufgaben**
1. `.env` aus `.env.example` ableiten; `ORS_API_KEY` nur serverseitig.  
2. Healthchecks für API/Web definieren.  
3. Logs/Volumes für Cache mit 8 GB Quota (Docker-Volume-Optionen) einrichten.  
4. Make-Targets/Skripte für `build`, `up`, `down`, `test`, `lint`.

**Akzeptanzkriterien**
- `docker compose up` startet den vollständigen Stack ohne manuelle Schritte.  
- Quotas und Healthchecks verifiziert.

---

## 3) Schnittstellen (Soll-Zustand)

> Konkrete Pfade sind Platzhalter; an bestehende Struktur in `api/` anpassen.

- `POST /api/search`  
  **Body:** `{ query: string, plz?: string, route: { waypoints: [latlon…] }, page?: number }`  
  **Antwort (DTO):** `{ results: [ { id, title, price, coords, link, thumbnail, distanceKm } ], meta: { total, page, cached: boolean } }`

- `POST /api/route/geocode`  
  **Body:** `{ addresses: string[] }`  
  **Antwort:** `{ waypoints: [ { lat, lon, label } ] }`

- `POST /api/route/calc`  
  **Body:** `{ waypoints: [latlon…] }`  
  **Antwort:** `{ polyline: string, distanceKm: number, durationMin: number }`

**Fehlerformat (einheitlich, deutsch):**
```json
{ "fehler": { "code": "RATE_LIMIT", "nachricht": "Zu viele Anfragen. Bitte später erneut versuchen." } }
```

---

## 4) Konfiguration & Secrets

- **Nur Backend liest `.env`:**  
  - `ORS_API_KEY=<dein_schluessel>`  
  - `CACHE_DIR=/var/app/cache`  
  - `CACHE_MAX_BYTES=8589934592`  # 8 GB  
  - `GLOBAL_RPS_PER_UPSTREAM=1`  
- **Frontend erhält keine Secrets.**  
- **CI/CD:** Environment-Secrets als geschützte Variablen, niemals als Klartext.

---

## 5) Caching-Design (Referenz)

- **Key-Schema:** `v1:{query}|{plz}|{routeHash}|{page}`  
- **Value:** kompaktes JSON (minified).  
- **Index:** Größe/Alter pro Eintrag; Eviction LRU + TTL (z. B. 24 h).  
- **Limit:** Bei `bytes_used + new_value > 8 GB` → solange eviktieren, bis Platz frei ist.  
- **Metriken:** `cache_hits_total`, `cache_misses_total`, `cache_bytes_used`.

---

## 6) Rate-Limiting & Resilience

- **Pro Upstream 1 RPS** via Token-Bucket.  
- **Retry-Policy:** 429/5xx mit Exponential Backoff (jitter), max. 4 Versuche.  
- **Queue:** Serverseitige Request-Queue (FIFO) mit Timeout und Abbruchpfad.

---

## 7) Tests & Qualität

- **Backend:**  
  - Unit-Tests für Parser, Cache, Limits.  
  - Contract-Tests für DTOs.  
- **Scraper:**  
  - HTML-Fixtures, DOM-Änderungen simulieren.  
- **Frontend:**  
  - i18n-Smoke-Test: Alle UI-Keys vorhanden und deutsch.  
- **Linter/Format:**  
  - Python: `ruff`, `black`.  
  - JS/TS: `eslint`, `prettier`.  
- **Security:**  
  - Secret-Scanner im CI, Abbruch bei Fund.  
  - Dependency-Audit.

---

## 8) Lokale Entwicklung (Schnellstart)

1. `.env` aus `.env.example` kopieren und Werte setzen (Backend-only).  
2. `docker compose up --build`.  
3. Web-UI aufrufen, deutsche Texte prüfen.  
4. Beispielsuche starten, Logs auf Cache/Rate-Limit prüfen.

---

## 9) Prompts für Agenten

### 9.1 Backend-Implementierung
```
Du bist Backend-Agent für ein FastAPI-Projekt. Implementiere einen serverseitigen Such-Endpunkt, der Scraper-Ergebnisse liefert, Ergebnisse im Filesystem-Cache speichert (harte Obergrenze 8 GB, LRU+TTL), und ein globales 1-RPS-Rate-Limit pro Upstream erzwingt. Keine externen APIs vom Client aus. Liefere nur bereinigte DTOs. Logge Cache-Hits/Misses strukturiert.
```

### 9.2 Scraper-Robustheit
```
Baue resilienten HTML-Parser mit Retry (429/5xx → Backoff mit Jitter, max 4), respektiere Crawl-Delay. Liefere DTOs: {id,title,price,coords,link,thumbnail,createdAt}. Keine Roh-HTMLs an den Client.
```

### 9.3 Frontend-Deutschpflicht
```
Prüfe, dass alle UI-Strings deutsch sind. Füge fehlende Übersetzungen hinzu. Entferne direkte Fetches an Dritt-APIs; nutze ausschließlich /api/*.
```

### 9.4 Cache-Eviction-Tests
```
Erzeuge Unit-Tests, die das Cache-Limit von 8 GB simulieren. Füge große Dummy-Einträge ein, prüfe LRU-Eviction und dass bytes_used <= 8 GB bleibt.
```

---

## 10) Definition of Done (DoD)

- UI ausschließlich deutsch, keine englischen Resttexte.  
- Kein Client-Side Zugriff auf Dritt-APIs, keine Secrets im Bundle.  
- Ergebnis-Cache aktiv, 8 GB garantiert eingehalten, Evictions getestet.  
- Rate-Limit wirksam; 429/Retry-After sauber behandelt.  
- Parser robust gegen gängige HTML-Varianten.  
- `docker compose up` startet ohne Handarbeit; Healthchecks grün.  
- Linter/Tests erfolgreich, Security-Scan ohne Funde.

---

## 11) Roadmap (Kurz)

- [ ] i18n-Audit und Deutsch-Fallback  
- [ ] Cache-Quoten über Docker-Volumes erzwingen  
- [ ] Observability-Dashboard (Logs + Metriken)  
- [ ] E2E-Test gegen Staging-Quellen  

---

## 12) Hinweise für Reviewer

- Blocke PRs, die UI-Texte nicht deutsch liefern.  
- Blocke PRs mit Client-Side Secrets/Upstream-Calls.  
- Verlange Messwerte (Hit-Rate, Latenz) bei Cache-/Limit-Änderungen.

---

*Stand: automatisch generiertes Agent-Briefing für dieses Repo. Bei Abweichungen bitte zuerst diese Datei aktualisieren und dann implementieren.*
