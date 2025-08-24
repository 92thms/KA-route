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
import inspect

import os

from fastapi import FastAPI, HTTPException, Request, Response
import httpx
import hashlib
import json
import re
from bs4 import BeautifulSoup


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

# Simple global rate limiter: process at most one request per second.
RATE_LIMIT_SECONDS = 1.0
_last_request: float = 0.0
_rate_lock = asyncio.Lock()

# Disk cache configuration (max. 8GB)
CACHE_DIR = Path(__file__).resolve().parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)
CACHE_LIMIT = 8 * 1024**3


def _cache_key(obj: dict) -> str:
    """Return a stable hash for ``obj``."""
    data = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(data).hexdigest()


def _cache_path(prefix: str, key: str) -> Path:
    return CACHE_DIR / f"{prefix}_{key}.json"


def _current_cache_size() -> int:
    return sum(p.stat().st_size for p in CACHE_DIR.glob("*.json"))


def _enforce_cache_limit() -> None:
    files = sorted(CACHE_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)
    size = _current_cache_size()
    while size > CACHE_LIMIT and files:
        p = files.pop(0)
        try:
            size -= p.stat().st_size
            p.unlink()
        except OSError:
            pass


def parse_listing_details(html: str) -> dict[str, str | None]:
    """Extract relevant fields from an eBay Kleinanzeigen detail page."""
    soup = BeautifulSoup(html, "html.parser")
    title = None
    if (meta := soup.find("meta", {"property": "og:title"})):
        title = meta.get("content")
    if not title and soup.title:
        title = soup.title.string

    image = None
    if (meta := soup.find("meta", {"property": "og:image"})):
        image = meta.get("content")

    postal = None
    city = None
    price = None

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "{}")
        except json.JSONDecodeError:
            continue
        if isinstance(data, list):
            items = data
        else:
            items = [data]
        for obj in items:
            if not isinstance(obj, dict):
                continue
            addr = (
                obj.get("address")
                or obj.get("itemOffered", {}).get("address")
                or obj.get("offers", {}).get("seller", {}).get("address")
            )
            if isinstance(addr, dict):
                postal = postal or addr.get("postalCode") or addr.get("postcode") or addr.get("zip")
                city = city or addr.get("addressLocality") or addr.get("city") or addr.get("town")
            if not image and (img := obj.get("image")):
                if isinstance(img, list):
                    image = img[0]
                elif isinstance(img, str):
                    image = img
            if not price:
                offers = obj.get("offers")
                if isinstance(offers, dict):
                    price = offers.get("price") or price

    if not postal:
        if m := re.search(r"\b(\d{5})\b", html):
            postal = m.group(1)

    return {
        "title": title.strip() if isinstance(title, str) else title,
        "image": image,
        "postal": postal,
        "city": city,
        "price": price,
    }


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

    cache_params = {
        "query": query,
        "location": location,
        "radius": radius,
        "min_price": min_price,
        "max_price": max_price,
        "page_count": page_count,
    }
    cache_file = _cache_path("inserate", _cache_key(cache_params))
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text())
        except Exception:
            cache_file.unlink(missing_ok=True)

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

    data = {"data": results}
    try:
        cache_file.write_text(json.dumps(data))
        _enforce_cache_limit()
    except OSError:
        pass
    return data


@app.get("/listing")
@app.get("/api/listing")
async def listing(url: str) -> dict[str, str | None]:
    """Fetch and parse a single Kleinanzeigen detail page."""
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
            resp = await client.get(url, headers=headers)
            resp.raise_for_status()
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    details = parse_listing_details(resp.text)
    return details


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

    parsed = httpx.URL(u)
    cache_file: Path | None = None
    if parsed.host == "nominatim.openstreetmap.org":
        cache_file = _cache_path("nominatim", _cache_key({"url": u}))
        if cache_file.exists():
            return Response(content=cache_file.read_bytes(), media_type="application/json")

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            resp = await client.get(u, headers=headers)
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    content_type = resp.headers.get("content-type", "text/html")

    if cache_file and resp.status_code == 200 and content_type.startswith("application/json"):
        try:
            cache_file.write_bytes(resp.content)
            _enforce_cache_limit()
        except OSError:
            pass

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

    body = await request.body()
    cache_params = {
        "path": path,
        "method": request.method,
        "query": dict(request.query_params),
        "body": body.decode("utf-8", errors="ignore"),
    }
    cache_file = _cache_path("ors", _cache_key(cache_params))
    if cache_file.exists():
        return Response(content=cache_file.read_bytes(), media_type="application/json")

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.request(
                request.method,
                url,
                params=dict(request.query_params),
                content=body,
                headers=headers,
            )
    except Exception as exc:  # pragma: no cover - network issues
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    media_type = resp.headers.get("content-type", "application/json")
    if resp.status_code == 200 and media_type.startswith("application/json"):
        try:
            cache_file.write_bytes(resp.content)
            _enforce_cache_limit()
        except OSError:
            pass
    return Response(content=resp.content, status_code=resp.status_code, media_type=media_type)
