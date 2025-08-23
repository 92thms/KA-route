"""API service for Klanavo.

Previously the application exposed only a health-check endpoint and returned
an empty payload for ``/inserate``.  This file now wires up the real
``ebay-kleinanzeigen-api`` scraper so that search queries return actual
classified ads instead of a static placeholder.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional
import inspect

import os

from fastapi import FastAPI, HTTPException, Request, Response
import httpx


# Make the bundled ``ebay-kleinanzeigen-api`` package importable.  The
# Dockerfile clones the upstream repository into ``api/ebay-kleinanzeigen-api``
# so we simply add that directory to ``sys.path`` here.
SCRAPER_DIR = Path(__file__).resolve().parent / "ebay-kleinanzeigen-api"
sys.path.insert(0, str(SCRAPER_DIR))

from scrapers.inserate import get_inserate_klaz  # type: ignore  # noqa: E402
from utils.browser import PlaywrightManager  # type: ignore  # noqa: E402


app = FastAPI()
"""FastAPI application used to expose the scraper."""

# Global Playwright browser so that it is not started for every request.  Starting
# and stopping Playwright is quite expensive, therefore we keep a single browser
# instance alive for the lifetime of the application and hand out new pages per
# request.
browser_manager: PlaywrightManager | None = None


@app.on_event("startup")
async def _startup() -> None:
    """Initialise the Playwright browser on application start."""
    global browser_manager
    browser_manager = PlaywrightManager()
    await browser_manager.start()


@app.on_event("shutdown")
async def _shutdown() -> None:  # pragma: no cover - defensive programming
    """Close the Playwright browser when the application shuts down."""
    if browser_manager is not None:
        await browser_manager.close()


@app.get("/health")
async def health() -> dict[str, str]:
    """Simple health check endpoint."""
    return {"status": "ok"}


@app.get("/inserate")
@app.get("/api/inserate")
async def inserate(
    query: str,
    location: str,
    radius: int = 10,
    category_id: Optional[int] = None,
    min_price: Optional[int] = None,
    max_price: Optional[int] = None,
    page_count: int = 1,
) -> dict[str, list]:
    """Return classifieds scraped from eBay Kleinanzeigen.

    Parameters
    ----------
    query:
        Search term for the classifieds.
    location:
        Postal code used as search origin.
    radius:
        Search radius in kilometres. Defaults to ``10``.
    category_id:
        Optional numeric category identifier used by Kleinanzeigen.
    min_price, max_price:
        Optional price filters in Euro.
    page_count:
        Number of result pages to fetch.  The upstream scraper supports up to
        20 pages.

    Returns
    -------
    dict
        A dictionary with a ``data`` key containing the scraped classifieds.
    """

    try:
        sig = inspect.signature(get_inserate_klaz)
        params = sig.parameters

        kwargs = {}
        if "browser_manager" in params:
            if browser_manager is None:  # pragma: no cover - should not happen
                raise HTTPException(status_code=503, detail="Browser not initialised")
            kwargs["browser_manager"] = browser_manager

        kwargs["query"] = query
        kwargs["location"] = location
        if "radius" in params:
            kwargs["radius"] = radius
        if "category_id" in params and category_id is not None:
            kwargs["category_id"] = category_id
        if "min_price" in params and min_price is not None:
            kwargs["min_price"] = min_price
        if "max_price" in params and max_price is not None:
            kwargs["max_price"] = max_price
        if "page_count" in params:
            kwargs["page_count"] = page_count

        results = await get_inserate_klaz(**kwargs)
    except Exception as exc:  # pragma: no cover - defensive programming
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {"data": results}


@app.get("/proxy")
async def proxy(u: str) -> Response:
    """Fetch ``u`` and return the raw response body.

    The route acts as a lightweight HTTP proxy used by the front-end to
    bypass CORS restrictions when fetching external resources such as
    Nominatim or individual Kleinanzeigen pages.
    """

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "de-DE,de;q=0.9",
        "Referer": "https://www.kleinanzeigen.de/",
        "Cache-Control": "no-cache",
    }

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(u, headers=headers)
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    content_type = resp.headers.get("content-type", "text/html")
    return Response(content=resp.content, status_code=resp.status_code, media_type=content_type)


@app.api_route("/ors/{path:path}", methods=["GET", "POST"])
async def ors_proxy(path: str, request: Request) -> Response:
    """Proxy requests to the OpenRouteService API using a server-side API key."""

    api_key = os.getenv("ORS_API_KEY")
    if not api_key:  # pragma: no cover - configuration issue
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    url = f"https://api.openrouteservice.org/{path}"
    headers = {"Authorization": api_key}
    if ct := request.headers.get("content-type"):
        headers["Content-Type"] = ct

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.request(
                request.method,
                url,
                params=dict(request.query_params),
                content=await request.body(),
                headers=headers,
            )
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    media_type = resp.headers.get("content-type", "application/json")
    return Response(content=resp.content, status_code=resp.status_code, media_type=media_type)
