from urllib.parse import urlencode

from fastapi import HTTPException

from utils.browser import PlaywrightManager


async def get_inserate_klaz(
    browser_manager: PlaywrightManager,
    query: str | None = None,
    location: str | None = None,
    radius: int | None = None,
    category_id: int | None = None,
    min_price: int | None = None,
    max_price: int | None = None,
    page_count: int = 1,
):
    base_url = "https://www.kleinanzeigen.de"

    if min_price is not None or max_price is not None:
        min_price_str = str(min_price) if min_price is not None else ""
        max_price_str = str(max_price) if max_price is not None else ""
        if location:
            location_slug = location.replace(" ", "-")
            if category_id is not None:
                search_path = (
                    f"/s-{location_slug}/preis:{min_price_str}:{max_price_str}/c{category_id}/seite:{{page}}"
                )
            else:
                search_path = (
                    f"/s-{location_slug}/preis:{min_price_str}:{max_price_str}/seite:{{page}}"
                )
        else:
            if category_id is not None:
                search_path = (
                    f"/s-preis:{min_price_str}:{max_price_str}/c{category_id}/seite:{{page}}"
                )
            else:
                search_path = f"/s-preis:{min_price_str}:{max_price_str}/seite:{{page}}"
    else:
        if location:
            location_slug = location.replace(" ", "-")
            if category_id is not None:
                search_path = f"/s-{location_slug}/c{category_id}/seite:{{page}}"
            else:
                search_path = f"/s-{location_slug}/seite:{{page}}"
        else:
            if category_id is not None:
                search_path = f"/s-/c{category_id}/seite:{{page}}"
            else:
                search_path = "/s-seite:{page}"

    params: dict[str, str] = {}
    if query:
        params["keywords"] = query
    if location and not (min_price or max_price):
        params["locationStr"] = location
    if radius:
        params["radius"] = str(radius)

    search_url = base_url + search_path + ("?" + urlencode(params) if params else "")

    page = await browser_manager.new_context_page()
    try:
        await page.goto(search_url.format(page=1), timeout=120000)
        results: list[dict[str, str]] = []

        for i in range(page_count):
            page_results = await get_ads(page)
            results.extend(page_results)

            if i < page_count - 1:
                try:
                    await page.goto(search_url.format(page=i + 2), timeout=120000)
                    await page.wait_for_load_state("networkidle")
                except Exception as e:  # pragma: no cover - network errors
                    print(f"Failed to load page {i + 2}: {str(e)}")
                    break
        return results
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await browser_manager.close_page(page)


async def get_ads(page):
    try:
        items = await page.query_selector_all(
            ".ad-listitem:not(.is-topad):not(.badge-hint-pro-small-srp)"
        )
        results = []
        for item in items:
            article = await item.query_selector("article")
            if article:
                data_adid = await article.get_attribute("data-adid")
                data_href = await article.get_attribute("data-href")
                title_element = await article.query_selector("h2.text-module-begin a.ellipsis")
                title_text = await title_element.inner_text() if title_element else ""
                price = await article.query_selector("p.aditem-main--middle--price-shipping--price")
                price_text = await price.inner_text() if price else ""
                price_text = (
                    price_text.replace("€", "").replace("VB", "").replace(".", "").strip()
                )
                description = await article.query_selector("p.aditem-main--middle--description")
                description_text = await description.inner_text() if description else ""
                if data_adid and data_href:
                    data_href = f"https://www.kleinanzeigen.de{data_href}"
                    results.append(
                        {
                            "adid": data_adid,
                            "url": data_href,
                            "title": title_text,
                            "price": price_text,
                            "description": description_text,
                        }
                    )
        return results
    except Exception as e:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail=str(e))
