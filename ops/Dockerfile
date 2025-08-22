# Playwright-Python-Image: enthält Browser + System-Dependencies
FROM mcr.microsoft.com/playwright/python:v1.54.0

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

# Systemdienste
RUN apt-get update \
 && apt-get install -y --no-install-recommends nginx supervisor wget ca-certificates gettext-base \
 && rm -rf /var/lib/apt/lists/*

# Arbeitsverzeichnis
WORKDIR /app

# Upstream-API unverändert hinein (Kontext = Projekt-Root!)
COPY api /app/api

# Python-Abhängigkeiten der API (falls vorhanden)
WORKDIR /app/api
RUN if [ -f requirements.txt ]; then \
        pip install --no-cache-dir -r requirements.txt; \
    elif [ -f ebay-kleinanzeigen-api/requirements.txt ]; then \
        pip install --no-cache-dir -r ebay-kleinanzeigen-api/requirements.txt; \
    fi

# Nginx & Supervisor Konfigs (liegen unter ops/)
WORKDIR /app
COPY ops/nginx.conf /etc/nginx/nginx.conf
COPY ops/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY ops/start-nginx.sh /app/ops/start-nginx.sh
RUN chmod +x /app/ops/start-nginx.sh

# Frontend in Webroot (liegt unter web/)
COPY web /usr/share/nginx/html

# Nur Nginx nach außen exponieren
EXPOSE 80

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1/ || exit 1

# Start
CMD ["/usr/bin/supervisord","-c","/etc/supervisor/conf.d/supervisord.conf","-n"]

