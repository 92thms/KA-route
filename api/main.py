"""API service for :mod:`kleinanzeigen_suite`.

Previously the application exposed only a health-check endpoint and returned
an empty payload for ``/inserate``.  This file now wires up the real
``ebay-kleinanzeigen-api`` scraper so that search queries return actual
classified ads instead of a static placeholder.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException


# Make the bundled ``ebay-kleinanzeigen-api`` package importable.  The
# Dockerfile clones the upstream repository into ``api/ebay-kleinanzeigen-api``
# so we simply add that directory to ``sys.path`` here.
SCRAPER_DIR = Path(__file__).resolve().parent / "ebay-kleinanzeigen-api"
sys.path.insert(0, str(SCRAPER_DIR))

from scrapers.inserate import get_inserate_klaz  # type: ignore  # noqa: E402
from utils.browser import PlaywrightManager  # type: ignore  # noqa: E402


app = FastAPI()


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

    browser_manager = PlaywrightManager()
    await browser_manager.start()
    try:
        results = await get_inserate_klaz(
            browser_manager,
            query,
            location,
            radius,
            min_price,
            max_price,
            page_count,
        )
    except Exception as exc:  # pragma: no cover - defensive programming
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    finally:
        await browser_manager.close()

    return {"data": results}
