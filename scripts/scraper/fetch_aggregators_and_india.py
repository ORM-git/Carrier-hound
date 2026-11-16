"""
Layer 3 Ingestion Module: Scheduled India Batch (JobSpy: LinkedIn Guest, Indeed, Naukri)
and Public JSON Aggregators (Arbeitnow, Adzuna).

Designed strictly for scheduled background batch runs (3x/day), never on live user requests.
All rows pass through normalize_company_alias() and compute_dedupe_hash() with source_priority = 2
so Direct ATS boards (source_priority = 1) always take precedence on active dedupe_hash.
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path
from typing import Any, Callable

import httpx

from .enrichment import (
    assign_company_category,
    detect_country_code,
    normalize_company_alias,
)
from .fetchers import build_normalized_job
from .rate_limiter import PerHostRateLimiter, request_with_backoff

INDIA_TARGET_ROLES: tuple[str, ...] = (
    "Software Engineer",
    "Fresher",
    "Graduate Engineer Trainee",
    "Data Analyst",
    "AI Engineer",
    "Cloud Engineer",
)

INDIA_TARGET_LOCATIONS: tuple[str, ...] = (
    "Bangalore, India",
    "Hyderabad, India",
    "Pune, India",
    "Bhubaneswar, India",
    "Chennai, India",
    "NCR, India",
    "Remote, India",
)

JOBSPY_SITES: tuple[str, ...] = ("linkedin", "indeed", "naukri")


def _slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "unknown").lower()).strip("-") or "unknown"


def _load_dotenv_vars() -> dict[str, str]:
    """Reads .env and .env.local if present without external dependency."""
    env_vars: dict[str, str] = {}
    root = Path(__file__).resolve().parents[2]
    for fname in (".env", ".env.local"):
        fpath = root / fname
        if not fpath.exists():
            continue
        try:
            for line in fpath.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                env_vars[k.strip()] = v.strip().strip('"').strip("'")
        except Exception:
            pass
    return env_vars


def normalize_aggregator_job(
    *,
    raw_company: str,
    title: str,
    location: str,
    apply_url: str,
    source: str,
    source_job_id: str,
    description_raw: str | None = None,
    posted_at: Any = None,
    explicit_remote: bool | None = None,
    country_code_hint: str | None = None,
    salary_min: float | None = None,
    salary_max: float | None = None,
    currency: str = "USD",
    ats_logo_url: str | None = None,
) -> dict[str, Any]:
    """
    Normalizes any aggregator/JobSpy record through company alias resolution,
    4-category classification, Aho-Corasick top_keywords, and SHA-256 dedupe_hash.
    """
    canon_name, alias_cat, canon_domain = normalize_company_alias(raw_company)
    detected_cc = (country_code_hint or detect_country_code(location) or "").upper() or None
    company_category = assign_company_category(
        alias_cat,
        canon_name,
        slug=_slugify(canon_name),
        source_layer="layer3",
        country_code=detected_cc,
    )
    seed = {
        "name": canon_name,
        "slug": _slugify(canon_name),
        "canonical_domain": canon_domain,
        "category": company_category,
    }
    return build_normalized_job(
        seed=seed,
        source=source,
        source_type="api",
        source_job_id=source_job_id,
        title=title,
        location=location,
        apply_url=apply_url,
        description_raw=description_raw,
        posted_at=posted_at,
        explicit_remote=explicit_remote,
        ats_logo_url=ats_logo_url,
        salary_min=salary_min,
        salary_max=salary_max,
        currency=currency,
        country_code_hint=detected_cc,
        source_layer="layer3",
        source_priority=2,  # Aggregator priority = 2 (Direct ATS = 1)
    )


async def fetch_jobspy_india_batch(
    *,
    roles: tuple[str, ...] = INDIA_TARGET_ROLES,
    locations: tuple[str, ...] = INDIA_TARGET_LOCATIONS,
    sites: tuple[str, ...] = JOBSPY_SITES,
    hours_old: int = 24,
    results_wanted: int = 25,
    scrape_fn: Callable[..., Any] | None = None,
) -> list[dict[str, Any]]:
    """
    Scheduled background batch fetcher (3x/day) using python-jobspy across
    LinkedIn Guest, Indeed, and Naukri for key roles across India with hours_old=24.
    """
    if scrape_fn is None:
        try:
            from jobspy import scrape_jobs as _jobspy_scrape  # type: ignore

            scrape_fn = _jobspy_scrape
        except ImportError:
            # shortcut: python-jobspy is optional in minimal CI containers; install python-jobspy in scraper worker
            return []

    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for role in roles:
        for loc in locations:
            is_remote_query = "remote" in loc.lower()
            try:
                raw_records = await asyncio.to_thread(
                    scrape_fn,
                    site_name=list(sites),
                    search_term=role,
                    location=loc,
                    results_wanted=results_wanted,
                    hours_old=hours_old,
                    country_indeed="india",
                    is_remote=is_remote_query,
                )
            except Exception:
                continue

            if hasattr(raw_records, "to_dict"):
                rows = raw_records.to_dict("records")
            elif isinstance(raw_records, list):
                rows = raw_records
            else:
                continue

            for item in rows:
                if not isinstance(item, dict):
                    continue
                apply_url = str(item.get("job_url") or item.get("job_url_direct") or "").strip()
                title = str(item.get("title") or "").strip()
                company = str(item.get("company") or "").strip()
                if not (apply_url and title and company) or apply_url in seen_urls:
                    continue
                seen_urls.add(apply_url)

                site = str(item.get("site") or "jobspy").lower().strip()
                job_id = str(item.get("id") or apply_url)
                item_loc = str(item.get("location") or loc).strip()
                sal_min = item.get("min_amount")
                sal_max = item.get("max_amount")
                curr = str(item.get("currency") or "INR").upper()

                results.append(
                    normalize_aggregator_job(
                        raw_company=company,
                        title=title,
                        location=item_loc,
                        apply_url=apply_url,
                        source=site,
                        source_job_id=f"{site}:{job_id}",
                        description_raw=item.get("description"),
                        posted_at=str(item.get("date_posted") or ""),
                        explicit_remote=bool(item.get("is_remote")) if item.get("is_remote") is not None else is_remote_query,
                        country_code_hint="IN",
                        salary_min=float(sal_min) if isinstance(sal_min, (int, float)) else None,
                        salary_max=float(sal_max) if isinstance(sal_max, (int, float)) else None,
                        currency=curr,
                        ats_logo_url=item.get("company_logo"),
                    )
                )

    return results


async def fetch_arbeitnow(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    *,
    max_pages: int = 2,
) -> list[dict[str, Any]]:
    """Arbeitnow Public JSON API: GET https://www.arbeitnow.com/api/job-board-api"""
    base_url = "https://www.arbeitnow.com/api/job-board-api"
    results: list[dict[str, Any]] = []

    for page in range(1, max_pages + 1):
        url = f"{base_url}?page={page}"
        resp = await request_with_backoff(client, limiter, "GET", url)
        payload = resp.json()
        data = payload.get("data") or []
        if not data:
            break

        for item in data:
            slug = item.get("slug")
            title = item.get("title")
            company = item.get("company_name")
            apply_url = item.get("url")
            if not (slug and title and company and apply_url):
                continue
            loc = item.get("location") or "Remote"
            is_remote = bool(item.get("remote"))
            tags = item.get("tags") or []
            desc = f"{item.get('description') or ''} {' '.join(str(t) for t in tags)}"

            results.append(
                normalize_aggregator_job(
                    raw_company=str(company),
                    title=str(title),
                    location=str(loc),
                    apply_url=str(apply_url),
                    source="arbeitnow",
                    source_job_id=str(slug),
                    description_raw=desc,
                    posted_at=item.get("created_at"),
                    explicit_remote=is_remote,
                )
            )

    return results


async def fetch_adzuna(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    *,
    app_id: str | None = None,
    app_key: str | None = None,
    countries: tuple[str, ...] = ("in", "us", "gb"),
    roles: tuple[str, ...] = ("Software Engineer", "Data Analyst", "AI Engineer", "Cloud Engineer"),
    results_per_page: int = 50,
) -> list[dict[str, Any]]:
    """Adzuna JSON API (active when ADZUNA_APP_ID and ADZUNA_APP_KEY exist in env or .env)."""
    dotenv_map = _load_dotenv_vars()
    resolved_id = app_id or os.environ.get("ADZUNA_APP_ID") or dotenv_map.get("ADZUNA_APP_ID")
    resolved_key = app_key or os.environ.get("ADZUNA_APP_KEY") or dotenv_map.get("ADZUNA_APP_KEY")
    if not (resolved_id and resolved_key):
        return []

    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    for country in countries:
        cc_upper = country.upper()
        currency = "INR" if cc_upper == "IN" else ("GBP" if cc_upper == "GB" else "USD")
        for role in roles:
            url = (
                f"https://api.adzuna.com/v1/api/jobs/{country.lower()}/search/1"
                f"?app_id={resolved_id}&app_key={resolved_key}"
                f"&results_per_page={results_per_page}&what={httpx.QueryParams({'q': role})['q']}"
                f"&max_days_old=1&content-type=application/json"
            )
            resp = await request_with_backoff(client, limiter, "GET", url)
            payload = resp.json()
            for item in payload.get("results") or []:
                job_id = str(item.get("id") or "").strip()
                title = str(item.get("title") or "").strip()
                company = str((item.get("company") or {}).get("display_name") or "").strip()
                apply_url = str(item.get("redirect_url") or "").strip()
                if not (job_id and title and company and apply_url) or job_id in seen_ids:
                    continue
                seen_ids.add(job_id)

                loc = str((item.get("location") or {}).get("display_name") or cc_upper)
                sal_min = item.get("salary_min")
                sal_max = item.get("salary_max")

                results.append(
                    normalize_aggregator_job(
                        raw_company=company,
                        title=title,
                        location=loc,
                        apply_url=apply_url,
                        source="adzuna",
                        source_job_id=f"{country}:{job_id}",
                        description_raw=item.get("description"),
                        posted_at=item.get("created"),
                        country_code_hint=cc_upper,
                        salary_min=float(sal_min) if isinstance(sal_min, (int, float)) else None,
                        salary_max=float(sal_max) if isinstance(sal_max, (int, float)) else None,
                        currency=currency,
                    )
                )

    return results
