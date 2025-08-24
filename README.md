# Klanavo

Klanavo durchsucht eBay Kleinanzeigen entlang beliebiger Routen. Ein FastAPI-Backend liefert Inserate und ein leichtes Frontend zeigt sie direkt auf der Karte.

## Schnellstart

1. `cp .env.example .env` und den eigenen ORS_API_KEY eintragen (der Schlüssel bleibt auf dem Server und wird nicht im Frontend verwendet). Für Reverse-Geocoding wird standardmäßig Nominatim genutzt; wer einen passenden ORS-Zugang hat, kann in der `.env` zusätzlich `USE_ORS_REVERSE=1` setzen.
2. `docker-compose up --build`

Der optionale Parameter USE_ORS_REVERSE lässt sich in `.env` anpassen. Suchradius und Punktabstand werden direkt im UI eingestellt.

Um einen Wartungsmodus zu aktivieren, können `MAINTENANCE_MODE=1` und ein passender `MAINTENANCE_KEY` in der `.env` gesetzt werden. Ohne gültigen Schlüssel zeigt die Anwendung nur einen Hinweis auf Wartungsarbeiten.

Das Frontend steht anschließend unter http://localhost:8401 bereit.

## Bedienung

Während der Suche kann über den Button **Abbrechen** der Vorgang sofort gestoppt werden. Bereits gefundene Ergebnisse bleiben erhalten. Mit **Neustart** wird die Anwendung komplett zurückgesetzt und alle Eingabefelder geleert.

Der Quellcode befindet sich auf GitHub unter https://github.com/92thms/ka-route.
