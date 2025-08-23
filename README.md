# Klanavo

Klanavo durchsucht eBay Kleinanzeigen entlang beliebiger Routen. Ein FastAPI-Backend liefert Inserate und ein leichtes Frontend zeigt sie direkt auf der Karte.

## Schnellstart

1. `cp .env.example .env` und den eigenen ORS_API_KEY eintragen (der Schlüssel bleibt auf dem Server und wird nicht im Frontend verwendet).
2. `docker-compose up --build`

Optionale Parameter wie SEARCH_RADIUS_KM und STEP_KM lassen sich in `.env` anpassen.

Um einen Wartungsmodus zu aktivieren, können `MAINTENANCE_MODE=1` und ein passender `MAINTENANCE_KEY` in der `.env` gesetzt werden. Ohne gültigen Schlüssel zeigt die Anwendung nur einen Hinweis auf Wartungsarbeiten.

Das Frontend steht anschließend unter http://localhost:8401 bereit.
