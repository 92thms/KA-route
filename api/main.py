"""API service for kleinanzeigen_suite.

This module exposes a minimal FastAPI application that currently provides a
health-check endpoint and a placeholder search endpoint used by the web
frontend.  The original implementation only offered ``/health`` which caused
404 errors when the frontend attempted to query ``/inserate``.  To avoid those
errors the corresponding route is now implemented and returns an empty result
set.  This keeps the interface stable until real search functionality is
implemented.
"""

from fastapi import FastAPI


app = FastAPI()


@app.get("/health")
async def health() -> dict[str, str]:
    """Simple health check endpoint."""
    return {"status": "ok"}


@app.get("/inserate")
@app.get("/api/inserate")
async def inserate(query: str, location: str, radius: int = 10) -> dict[str, list]:
    """Placeholder endpoint returning no classifieds.

    Parameters
    ----------
    query:
        Search term for the classifieds.
    location:
        Postal code used as search origin.
    radius:
        Search radius in kilometres. Defaults to ``10``.

    Returns
    -------
    dict
        A dictionary with a ``data`` key containing an empty list.  The shape
        matches the structure expected by the frontend which avoids runtime
        errors while the real implementation is pending.
    """

    return {"data": []}
