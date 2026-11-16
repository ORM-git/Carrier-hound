"""
Layer 3 Ingestion: Aggregators, India Tech Hubs & Long-tail Roles.

Fetches from:
1. python-jobspy (LinkedIn, Indeed, Naukri across India) - scheduled batch.
2. Arbeitnow Public JSON API.
3. Adzuna JSON API (when credentials are present).
Normalizes all jobs through alias mapping, 4-category classification, and SHA-256 dedupe hash.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import re
from typing import Any

import httpx

from .enrichment import (
    assign_company_category,
    detect_country_code,
    normalize_company_alias,
)
from .fetchers import build_normalized_job
from .rate_limiter import PerHostRateLimiter, redact_sensitive_params, request_with_backoff

INDIA_ROLES: tuple[str, ...] = (
    "Software Engineer",
    "Fresher",
    "Graduate Engineer Trainee",
    "Data Analyst",
    "AI Engineer",
    "Cloud Engineer",
)

INDIA_LOCATIONS: tuple[str, ...] = (
    "Bangalore, India",
    "Hyderabad, India",
    "Pune, India",
    "Bhubaneswar, India",
    "Chennai, India",
    "Delhi NCR, India",
    "Remote, India",
)

JOBSPY_SITES: tuple[str, ...] = ("linkedin", "indeed", "naukri")


def _slugify(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (value or "unknown").lower()).strip("-") or "unknown"


def find_repo_root() -> Path:
    """Finds repository root by searching upward for .git or package.json."""
    curr = Path(__file__).resolve().parent
    for _ in range(5):
        if (curr / ".git").exists() or (curr / "package.json").exists():
            return curr
        if curr.parent == curr:
            break
        curr = curr.parent
    return Path(__file__).resolve().parents[2]


def _load_dotenv_vars() -> dict[str, str]:
    """Reads .env and .env.local from repo root if present without external dependency."""
    env_vars: dict[str, str] = {}
    root = find_repo_root()
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
    source_type: str = "aggregator",
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
        source_type=source_type,
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


async def fetch_jobspy_india(
    *,
    roles: tuple[str, ...] = INDIA_ROLES,
    locations: tuple[str, ...] = INDIA_LOCATIONS,
    sites: tuple[str, ...] = JOBSPY_SITES,
    results_wanted: int = 25,
    hours_old: int = 24,
    scrape_timeout_seconds: float = 30.0,
) -> tuple[list[dict[str, Any]], str | None]:
    """
    Query LinkedIn Guest, Indeed, and Naukri across India with hours_old=24.
    Returns (results, error). If python-jobspy is not installed or scrape fails/times out,
    returns (results, error_message) so expiry can be safely withheld.
    """
    try:
        from jobspy import scrape_jobs as scrape_fn  # type: ignore
    except ImportError:
        try:
            from jobspy.scrapers import scrape_jobs as scrape_fn  # type: ignore
        except ImportError:
            return [], "python-jobspy not installed. Run 'pip install python-jobspy'"

    results: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    errors: list[str] = []

    for role in roles:
        for loc in locations:
            is_remote_query = "remote" in loc.lower()
            try:
                raw_records = await asyncio.wait_for(
                    asyncio.to_thread(
                        scrape_fn,
                        site_name=list(sites),
                        search_term=role,
                        location=loc,
                        results_wanted=results_wanted,
                        hours_old=hours_old,
                        country_indeed="india",
                        is_remote=is_remote_query,
                    ),
                    timeout=scrape_timeout_seconds,
                )
            except asyncio.TimeoutError:
                errors.append(f"JobSpy timed out after {scrape_timeout_seconds}s for {role} in {loc}")
                continue
            except Exception as exc:
                clean_err = redact_sensitive_params(str(exc))
                errors.append(f"JobSpy error for {role} in {loc}: {clean_err}")
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
                        source_type="jobspy",
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

    error_summary = "; ".join(errors[:3]) if errors else None
    return results, error_summary


async def fetch_arbeitnow(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    *,
    max_pages: int = 2,
) -> tuple[list[dict[str, Any]], str | None]:
    """Arbeitnow Public JSON API: GET https://www.arbeitnow.com/api/job-board-api"""
    base_url = "https://www.arbeitnow.com/api/job-board-api"
    results: list[dict[str, Any]] = []
    error_summary: str | None = None

    for page in range(1, max_pages + 1):
        url = f"{base_url}?page={page}"
        try:
            resp = await request_with_backoff(client, limiter, "GET", url)
            payload = resp.json()
        except Exception as exc:
            error_summary = f"Arbeitnow page {page} error: {redact_sensitive_params(str(exc))}"
            break

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
                    source_type="arbeitnow",
                    source_job_id=f"arbeitnow:{slug}",
                    description_raw=desc,
                    posted_at=item.get("created_at"),
                    explicit_remote=is_remote,
                )
            )

    return results, error_summary


async def fetch_adzuna(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    *,
    app_id: str | None = None,
    app_key: str | None = None,
    countries: tuple[str, ...] = ("in", "us", "gb"),
    roles: tuple[str, ...] = ("Software Engineer", "Data Analyst", "AI Engineer", "Cloud Engineer"),
    results_per_page: int = 50,
) -> tuple[list[dict[str, Any]], str | None]:
    """Adzuna JSON API (active when ADZUNA_APP_ID and ADZUNA_APP_KEY exist in env or .env)."""
    dotenv_map = _load_dotenv_vars()
    resolved_id = app_id or os.environ.get("ADZUNA_APP_ID") or dotenv_map.get("ADZUNA_APP_ID")
    resolved_key = app_key or os.environ.get("ADZUNA_APP_KEY") or dotenv_map.get("ADZUNA_APP_KEY")
    if not (resolved_id and resolved_key):
        return [], None

    results: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    errors: list[str] = []

    for country in countries:
        cc_upper = country.upper()
        currency = "INR" if cc_upper == "IN" else ("GBP" if cc_upper == "GB" else "USD")
        for role in roles:
            base_url = f"https://api.adzuna.com/v1/api/jobs/{country.lower()}/search/1"
            params = {
                "app_id": resolved_id,
                "app_key": resolved_key,
                "results_per_page": results_per_page,
                "what": role,
                "max_days_old": 1,
                "content-type": "application/json",
            }
            try:
                resp = await request_with_backoff(client, limiter, "GET", base_url, params=params)
                payload = resp.json()
            except Exception as exc:
                # STRIP SECRETS from error message!
                raw_err = str(exc)
                clean_err = redact_sensitive_params(raw_err)
                if resolved_key:
                    clean_err = clean_err.replace(resolved_key, "[REDACTED]")
                if resolved_id:
                    clean_err = clean_err.replace(resolved_id, "[REDACTED]")
                errors.append(f"Adzuna {country} error: {clean_err}")
                continue

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
                        source_type="adzuna",
                        source_job_id=f"adzuna:{country}:{job_id}",
                        description_raw=item.get("description"),
                        posted_at=item.get("created"),
                        country_code_hint=cc_upper,
                        salary_min=float(sal_min) if isinstance(sal_min, (int, float)) else None,
                        salary_max=float(sal_max) if isinstance(sal_max, (int, float)) else None,
                        currency=currency,
                    )
                )

    error_summary = "; ".join(errors[:3]) if errors else None
    return results, error_summary
