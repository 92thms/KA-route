"""API service for Klanavo.

Previously the application exposed only a health-check endpoint and returned
an empty payload for ``/inserate``.  This file now wires up the real
``ebay-kleinanzeigen-api`` scraper so that search queries return actual
classified ads instead of a static placeholder.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from typing import Optional
import math

from pydantic import BaseModel
import inspect

import os

from fastapi import FastAPI, HTTPException, Request, Response
import httpx


# Make the vendored ``ebay-kleinanzeigen-api`` package importable.  The project
# lives under ``api/ebay-kleinanzeigen-api`` within this repository, so we add
# that directory to ``sys.path``.
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

# Simple global rate limiter: process at most one request per second.
RATE_LIMIT_SECONDS = 1.0
_last_request: float = 0.0
_rate_lock = asyncio.Lock()

# Global cache for reverse geocoded postal codes
_plz_cache: dict[str, str | None] = {}


@app.middleware("http")
async def _rate_limit(request: Request, call_next) -> Response:
    """Delay requests so that at most one is handled per second."""
    global _last_request
    async with _rate_lock:
        now = time.monotonic()
        wait = RATE_LIMIT_SECONDS - (now - _last_request)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request = time.monotonic()
    return await call_next(request)


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


class RouteSearchRequest(BaseModel):
    start: str
    ziel: str
    radius: int = 10
    step: int = 10
    query: Optional[str] = None
    min_price: Optional[int] = None
    max_price: Optional[int] = None


async def _geocode_text(client: httpx.AsyncClient, api_key: str, text: str) -> tuple[float, float]:
    params = {"text": text, "boundary.country": "DE", "size": 1}
    try:
        resp = await client.get(
            "https://api.openrouteservice.org/geocode/search",
            params=params,
            headers={"Authorization": api_key},
        )
        resp.raise_for_status()
        data = resp.json()
        features = data.get("features") or []
        if features:
            coords = features[0]["geometry"]["coordinates"]
            return coords[0], coords[1]
    except Exception:
        pass

    try:
        resp = await client.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": text,
                "format": "jsonv2",
                "limit": 1,
                "countrycodes": "de",
            },
            headers={"User-Agent": "ka-route/1.0"},
        )
        resp.raise_for_status()
        data = resp.json()
        if data:
            return float(data[0]["lon"]), float(data[0]["lat"])
    except Exception:
        pass

    raise HTTPException(status_code=502, detail="Geocoding failed")


def _sample_route(coords: list[list[float]], step_m: float) -> list[list[float]]:
    samples: list[list[float]] = []
    acc = 0.0
    prev = coords[0]
    for cur in coords[1:]:
        dx = (cur[0] - prev[0]) * 111320 * math.cos(math.radians((cur[1] + prev[1]) / 2))
        dy = (cur[1] - prev[1]) * 110540
        dist = math.hypot(dx, dy)
        acc += dist
        if acc >= step_m:
            samples.append(cur)
            acc = 0.0
            prev = cur
        else:
            prev = cur
    return samples


async def _reverse_plz(client: httpx.AsyncClient, api_key: str, lat: float, lon: float) -> str | None:
    key = f"{lat:.3f}|{lon:.3f}"
    if key in _plz_cache:
        return _plz_cache[key]
    plz: str | None = None
    try:
        resp = await client.get(
            "https://api.openrouteservice.org/geocode/reverse",
            params={"point.lat": lat, "point.lon": lon, "size": 1},
            headers={"Authorization": api_key},
        )
        if resp.status_code == 200:
            data = resp.json()
            plz = (
                data.get("features", [{}])[0]
                .get("properties", {})
                .get("postalcode")
            )
    except Exception:
        pass
    if not plz:
        try:
            resp = await client.get(
                "https://nominatim.openstreetmap.org/reverse",
                params={
                    "lat": lat,
                    "lon": lon,
                    "format": "jsonv2",
                    "zoom": 10,
                    "addressdetails": 1,
                },
                headers={"User-Agent": "ka-route/1.0"},
            )
            if resp.status_code == 200:
                j = resp.json()
                plz = j.get("address", {}).get("postcode")
        except Exception:
            pass
    _plz_cache[key] = plz
    return plz


@app.post("/route-search")
@app.post("/api/route-search")
async def route_search(req: RouteSearchRequest) -> dict:
    if browser_manager is None:  # pragma: no cover - should not happen
        raise HTTPException(status_code=503, detail="Browser not initialised")
    api_key = os.getenv("ORS_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="ORS_API_KEY not configured")

    async with httpx.AsyncClient() as client:
        start_ll = await _geocode_text(client, api_key, req.start)
        ziel_ll = await _geocode_text(client, api_key, req.ziel)
        resp = await client.post(
            "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
            json={"coordinates": [start_ll, ziel_ll]},
            headers={"Authorization": api_key},
        )
        resp.raise_for_status()
        route = resp.json()
        coords = route["features"][0]["geometry"]["coordinates"]

        samples = _sample_route(coords, req.step * 1000)
        plzs: set[str] = set()
        for lon, lat in samples:
            plz = await _reverse_plz(client, api_key, lat, lon)
            if plz:
                plzs.add(plz)

        results: list[dict] = []
        seen: set[str] = set()
        for plz in plzs:
            try:
                items = await get_inserate_klaz(
                    browser_manager=browser_manager,
                    query=req.query,
                    location=plz,
                    radius=req.radius,
                    min_price=req.min_price,
                    max_price=req.max_price,
                )
            except Exception:
                continue
            for it in items:
                url = it.get("url")
                if url in seen:
                    continue
                seen.add(url)
                it["plz"] = plz
                results.append(it)

    return {"route": coords, "listings": results}


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
