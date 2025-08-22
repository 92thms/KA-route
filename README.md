# Klanavo

Klanavo durchsucht eBay Kleinanzeigen entlang beliebiger Routen. Ein FastAPI-Backend liefert Inserate und ein leichtes Frontend zeigt sie direkt auf der Karte.

## Schnellstart

1. `cp .env.example .env` und den eigenen ORS_API_KEY eintragen.
2. `docker-compose up --build`

Optionale Parameter wie SEARCH_RADIUS_KM und STEP_KM lassen sich in `.env` anpassen.

Das Frontend steht anschließend unter http://localhost:8401 bereit.
