from __future__ import annotations

from pydantic import BaseModel


class InserateRequest(BaseModel):
    query: str
    location: str
    radius: int = 10
    min_price: int | None = None
    max_price: int | None = None
    page_count: int = 1


class InserateResponse(BaseModel):
    data: list[dict]


class ListingRequest(BaseModel):
    url: str


class ListingResponse(BaseModel):
    title: str | None = None
    image: str | None = None
    postal: str | None = None
    city: str | None = None
    price: str | None = None
