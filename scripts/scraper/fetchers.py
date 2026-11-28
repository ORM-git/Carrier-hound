"""Layer 1 (Public ATS) and Layer 2 (Workday CXS, Amazon, Microsoft) async fetchers."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import math
import os
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx

from .enrichment import (
    assign_company_category,
    assign_legacy_category,
    assign_role_category,
    compute_dedupe_hash,
    detect_country_code,
    extract_top_keywords,
    resolve_logo_url,
    strip_html,
)
from .persistence import normalize_salary_period
from .rate_limiter import RequestHTTPError, PerHostRateLimiter, parse_retry_after, redact_sensitive_params, request_with_backoff

COUNTRY_NAMES = {
    "US": "United States",
    "IN": "India",
    "GB": "United Kingdom",
    "CA": "Canada",
    "DE": "Germany",
    "SG": "Singapore",
    "IE": "Ireland",
    "FR": "France",
    "NL": "Netherlands",
    "AU": "Australia",
    "JP": "Japan",
    "BR": "Brazil",
    "PL": "Poland",
    "ES": "Spain",
    "IL": "Israel",
    "MX": "Mexico",
}

_US_STATE_COUNTRY_CODE_COLLISIONS = frozenset({
    "AL", "AR", "AZ", "CA", "CO", "DE", "GA", "ID", "IL", "IN", "KY", "LA",
    "MA", "MD", "ME", "MN", "MO", "MS", "MT", "NC", "NE", "PA", "SC", "SD",
    "TN", "VA",
})


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_iso_date(raw: Any, *, missing_as_now: bool = False) -> str | None:
    # A missing/invalid source date stays unknown (None): ingestion time is not a posting date (#38).
    if raw is None or raw == "" or isinstance(raw, bool):
        return _iso_now() if missing_as_now else None
    if isinstance(raw, (int, float)):
        if not math.isfinite(float(raw)):
            return _iso_now() if missing_as_now else None
        ts = raw / 1000.0 if abs(raw) > 1e11 else float(raw)
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return _iso_now() if missing_as_now else None
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return _iso_now() if missing_as_now else None
        try:
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.isoformat()
        except ValueError:
            return _iso_now() if missing_as_now else None
    return _iso_now() if missing_as_now else None


def _greenhouse_country_code(item: dict[str, Any], location: str) -> str | None:
    """Return a country only when every explicit source/location clue agrees."""
    countries = _greenhouse_country_evidence(item, location)
    return next(iter(countries)) if len(countries) == 1 else None


def _greenhouse_country_evidence(item: dict[str, Any], location: str) -> set[str]:
    countries = _greenhouse_location_country_evidence(location)
    metadata = item.get("metadata")
    if isinstance(metadata, list):
        for entry in metadata:
            if not isinstance(entry, dict) or not re.search(r"\bcountry\b", str(entry.get("name") or ""), re.I):
                continue
            value = entry.get("value")
            if isinstance(value, str):
                countries.update(_explicit_country_codes(value, allow_ambiguous_region_code=True))
    return countries


def _greenhouse_location_country_evidence(location: str) -> set[str]:
    # Two-letter ISO codes that also name US states are ambiguous inside a
    # location string, regardless of punctuation or qualifiers. Accept these
    # codes only as the complete location; structured metadata is parsed apart.
    stripped = location.strip()
    if re.fullmatch(r"[A-Za-z]{2}", stripped):
        return _explicit_country_codes(stripped, allow_ambiguous_region_code=True)
    collision_pattern = r"\b(?:" + "|".join(sorted(_US_STATE_COUNTRY_CODE_COLLISIONS)) + r")\b"
    country_text = re.sub(collision_pattern, " ", location, flags=re.I)
    return _explicit_country_codes(country_text)


def _explicit_country_code(value: str, *, allow_ambiguous_region_code: bool = False) -> str | None:
    countries = _explicit_country_codes(value, allow_ambiguous_region_code=allow_ambiguous_region_code)
    return next(iter(countries)) if len(countries) == 1 else None


def _explicit_country_codes(value: str, *, allow_ambiguous_region_code: bool = False) -> set[str]:
    text = value.strip().lower()
    codes = {
        "us": "US", "usa": "US", "u.s.": "US", "u.s.a.": "US", "united states": "US",
        "mx": "MX", "mexico": "MX", "ca": "CA", "canada": "CA", "in": "IN", "india": "IN",
        "gb": "GB", "uk": "GB", "united kingdom": "GB", "de": "DE", "germany": "DE",
        "fr": "FR", "france": "FR", "ie": "IE", "ireland": "IE", "es": "ES", "spain": "ES",
        "br": "BR", "brazil": "BR", "au": "AU", "australia": "AU", "jp": "JP", "japan": "JP",
        "nl": "NL", "netherlands": "NL", "sg": "SG", "singapore": "SG", "pl": "PL", "poland": "PL",
        "il": "IL", "israel": "IL",
    }
    if text in codes:
        if text in {"ca", "in"} and not allow_ambiguous_region_code:
            return set()
        return {codes[text]}
    countries: set[str] = set()
    if re.search(r"\bmexico city\b", text):
        countries.add("MX")
    for token, code in codes.items():
        if len(token) > 2 and re.search(rf"\b{re.escape(token)}\b", text):
            countries.add(code)
    # CA and IN are also common region/preposition tokens, so only accept them as exact
    # metadata values above; never infer Canada from "San Francisco, CA" or India from "in US".
    for token, code in codes.items():
        if len(token) <= 2 and token not in {"ca", "in"} and re.search(rf"\b{re.escape(token)}\b", text):
            countries.add(code)
    return countries


def _greenhouse_remote_eligibility(location: str, is_remote: bool, country_evidence: set[str]) -> str:
    if not is_remote:
        return "unknown"
    has_worldwide_scope = re.search(r"\b(anywhere|worldwide|global|all regions|work from anywhere)\b", location, re.I)
    if has_worldwide_scope and not country_evidence:
        return "worldwide"
    return "country_restricted" if country_evidence else "unknown"


def _positive_number(raw: Any) -> float | None:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(float(raw)) or raw <= 0:
        return None
    return float(raw)


def _greenhouse_salary(item: dict[str, Any]) -> dict[str, Any]:
    ranges = item.get("pay_input_ranges")
    chosen = next((
        row for row in ranges if isinstance(row, dict) and (
            _positive_number(row.get("min_cents")) or _positive_number(row.get("max_cents"))
        )
    ), None) if isinstance(ranges, list) else None
    if not chosen:
        return {"salary_text": None, "salary_min": None, "salary_max": None, "currency": None, "salary_period": None,
                "salary_period_stated": False}

    raw_min = _positive_number(chosen.get("min_cents"))
    raw_max = _positive_number(chosen.get("max_cents"))
    salary_min = math.floor(raw_min / 100 + 0.5) if raw_min is not None else None
    salary_max = math.floor(raw_max / 100 + 0.5) if raw_max is not None else None
    if salary_min is not None and salary_max is not None and salary_min > salary_max:
        salary_min, salary_max = salary_max, salary_min

    currency_raw = chosen.get("currency_type")
    currency = currency_raw.strip().upper() if isinstance(currency_raw, str) and currency_raw.strip() else None
    context = f"{chosen.get('title') or ''} {chosen.get('blurb') or ''}"
    period = "hourly" if currency == "USD" and re.search(r"\b(hour|hourly|/hr)\b", context, re.I) else None
    format_currency = currency or "USD"
    prefix = {"USD": "$", "EUR": "€", "GBP": "£", "INR": "₹", "CAD": "CA$", "AUD": "AU$", "SGD": "SG$", "CHF": "CHF "}.get(format_currency, f"{format_currency} ")
    suffix = " /hr" if period == "hourly" else " /yr"
    number = lambda amount: f"{amount:,}"
    if salary_min is not None and salary_max is not None and salary_min != salary_max:
        salary_text = f"{prefix}{number(salary_min)} - {prefix}{number(salary_max)}{suffix}"
    else:
        amount = salary_min if salary_min is not None else salary_max
        salary_text = f"{prefix}{number(amount or 0)}{suffix}"
    # The pay range's own title/blurb saying "hour" is source salary text, so that period counts as stated.
    return {"salary_text": salary_text, "salary_min": salary_min, "salary_max": salary_max, "currency": currency, "salary_period": period,
            "salary_period_stated": period is not None}


def _lever_salary_period(interval: Any) -> str | None:
    """Lever salaryRange.interval (per-year-salary, per-month-salary, per-hour-wage, ...): same rule as scripts/adapters/lever.ts.
    Anything else (per-day-wage, per-week-salary, one-time) stays None: never relabelled as another period."""
    raw = interval.lower() if isinstance(interval, str) else ""
    if "hour" in raw:
        return "hourly"
    if "month" in raw:
        return "monthly"
    if "year" in raw or "annual" in raw:
        return "yearly"
    return None


def _detect_remote(title: str, location: str, explicit_remote: bool | None = None) -> bool:
    if isinstance(explicit_remote, bool):
        return explicit_remote
    combined = f"{title} {location}".lower()
    return any(w in combined for w in ("remote", "work from home", "wfh", "anywhere", "distributed"))


# Mirror of src/lib/jobs/employmentTypeMap.ts (checklist #17): only unambiguous synonyms, else 'other'.
_CANONICAL_JOB_TYPES = frozenset({"job", "internship", "full-time", "part-time", "contract", "other"})
_EMPLOYMENT_SYNONYMS = {
    "full time": "full-time", "fulltime": "full-time", "permanent": "full-time", "part time": "part-time", "parttime": "part-time",
    "contractor": "contract", "freelance": "contract", "intern": "internship", "co-op": "internship",
}


def map_employment_type(raw: Any) -> str:
    """A source's dedicated employment-type field -> canonical job_type. Never guesses for ambiguous values."""
    key = " ".join(raw.split()).lower() if isinstance(raw, str) else ""
    if key in _CANONICAL_JOB_TYPES:
        return key
    return _EMPLOYMENT_SYNONYMS.get(key, "other")


def _detect_job_type(title: str, raw_type: str = "", employment_type: Any = None) -> str:
    if isinstance(employment_type, str) and employment_type.strip():
        return map_employment_type(employment_type)
    # shortcut: no structured field -> legacy guess ('full-time' unless intern); 'job' would shrink the Full-time filter, owner decision.
    combined = f"{title} {raw_type}".lower()
    if any(w in combined for w in ("intern", "internship", "co-op", "apprentice", "trainee")):
        return "internship"
    return "full-time"


def build_normalized_job(
    *,
    seed: dict[str, Any],
    source: str,
    source_type: str,
    source_job_id: str,
    source_id: str | None = None,
    title: str,
    location: str,
    apply_url: str,
    description_raw: str | None = None,
    department: str | None = None,
    posted_at: Any = None,
    explicit_remote: bool | None = None,
    ats_logo_url: str | None = None,
    salary_text: str | None = None,
    salary_min: float | None = None,
    salary_max: float | None = None,
    currency: str | None = "USD",
    salary_period: str | None = None,
    salary_period_stated: bool = False,
    employment_type: str | None = None,
    country_code_hint: str | None = None,
    infer_country_from_location: bool = True,
    country_unknown_as_location: bool = True,
    posted_at_missing_as_now: bool = False,
    description_limit: int | None = 4000,
    description_fallback: bool = True,
    remote_eligibility: str | None = None,
    source_layer: str = "layer1",
    source_priority: int = 1,
) -> dict[str, Any]:
    """Constructs a normalized job dictionary ready for set-diff upsert into public.jobs."""
    company_name = (seed.get("name") or seed.get("slug") or "Unknown").strip()
    company_slug = (seed.get("slug") or seed.get("token") or company_name.lower()).strip().lower()
    canonical_domain = seed.get("canonical_domain")
    company_category = assign_company_category(
        seed.get("category"),
        company_name,
        company_slug,
        source_layer=source_layer,
    )

    clean_title = (title or "Untitled Position").strip()
    clean_location = (location or "Remote").strip() or "Remote"
    is_remote = _detect_remote(clean_title, clean_location, explicit_remote)
    inferred_country_code = detect_country_code(clean_location) if infer_country_from_location else None
    country_code = (country_code_hint or inferred_country_code or "").upper() or None
    country_name = COUNTRY_NAMES.get(country_code, "")
    if country_unknown_as_location and not country_code and is_remote:
        country_name = clean_location

    clean_desc = strip_html(description_raw) if (description_raw and isinstance(description_raw, str)) else (f"{clean_title} at {company_name}" if description_fallback else "")
    if description_limit is not None:
        clean_desc = clean_desc[:description_limit]
    top_keywords = extract_top_keywords(clean_title, clean_desc, max_keywords=8)
    role_category = assign_role_category(clean_title, department, top_keywords)
    legacy_category = assign_legacy_category(clean_title, role_category)
    logo_url = resolve_logo_url(ats_logo_url or seed.get("logo_url"), canonical_domain)
    dedupe_hash = compute_dedupe_hash(company_name, clean_title, country_code or country_name, clean_location)
    now_iso = _iso_now()

    job = {
        "company": company_name,
        "company_slug": company_slug,
        "canonical_domain": canonical_domain,
        "company_category": company_category,
        "logo_url": logo_url,
        "title": clean_title,
        "location": clean_location,
        "country": country_name or "",
        "country_code": country_code,
        "remote": is_remote,
        "is_remote": is_remote,
        "remote_scope": "remote" if is_remote else "onsite",
        "job_type": _detect_job_type(clean_title, department or "", employment_type),
        "category": legacy_category,
        "role_category": role_category,
        "top_keywords": top_keywords,
        "skills": top_keywords,
        "salary_text": salary_text,
        "salary_min": salary_min,
        "salary_max": salary_max,
        "currency": currency,
        # Truthful null when no salary is stated; known aliases (year/month/hour) map to the DB enum.
        "salary_period": normalize_salary_period(salary_period) if (salary_text or salary_min is not None or salary_max is not None) else None,
        # True only when the fetcher read the period from the source's own field or salary text (checklist #21).
        "salary_period_stated": bool(salary_period_stated) and salary_period is not None
        and (salary_text is not None or salary_min is not None or salary_max is not None),
        "description": clean_desc,
        "apply_url": apply_url.strip(),
        "source": source,
        "source_type": source_type,
        "source_id": str(source_id or f"{source_type}:{company_slug}").strip(),
        "source_job_id": str(source_job_id).strip(),
        "source_url": apply_url.strip(),
        "source_priority": source_priority,
        "dedupe_hash": dedupe_hash,
        "verified": source_priority == 1,
        "posted_at": _normalize_iso_date(posted_at, missing_as_now=posted_at_missing_as_now),
        "last_seen_at": now_iso,
        "is_active": True,
        "status": "active",
    }
    if remote_eligibility is not None:
        job["remote_eligibility"] = remote_eligibility
    return job


# ---------------------------------------------------------------------------
# LAYER 1: PUBLIC ATS APIs ('HIGH_PRODUCT_YC', 'OTHER_STARTUPS', etc.)
# ---------------------------------------------------------------------------


async def fetch_greenhouse(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
) -> list[dict[str, Any]]:
    """Greenhouse: GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true"""
    token = seed["token"]
    url = f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true&pay_transparency=true"
    resp = await request_with_backoff(client, limiter, "GET", url)
    payload = resp.json()
    jobs_raw = payload.get("jobs") or []
    results: list[dict[str, Any]] = []

    for item in jobs_raw:
        job_id = item.get("id")
        title = item.get("title")
        apply_url = item.get("absolute_url")
        if not (job_id and title and apply_url):
            continue
        loc = (item.get("location") or {}).get("name") or "Remote"
        depts = item.get("departments") or []
        dept_name = depts[0].get("name") if depts and isinstance(depts[0], dict) else None
        salary = _greenhouse_salary(item)
        country_evidence = _greenhouse_country_evidence(item, loc)
        country_code = next(iter(country_evidence)) if len(country_evidence) == 1 else None
        is_remote = _detect_remote(title, loc)
        results.append(
            build_normalized_job(
                seed=seed,
                source="greenhouse",
                source_type="greenhouse",
                source_id=f"greenhouse:{token}",
                source_job_id=f"{token}-{job_id}",
                title=title,
                location=loc,
                apply_url=apply_url,
                description_raw=item.get("content"),
                department=dept_name,
                posted_at=item.get("first_published"),
                explicit_remote=is_remote,
                salary_text=salary["salary_text"],
                salary_min=salary["salary_min"],
                salary_max=salary["salary_max"],
                currency=salary["currency"],
                salary_period=salary["salary_period"],
                salary_period_stated=salary["salary_period_stated"],
                country_code_hint=country_code,
                infer_country_from_location=False,
                country_unknown_as_location=False,
                posted_at_missing_as_now=False,
                description_limit=None,
                description_fallback=False,
                remote_eligibility=_greenhouse_remote_eligibility(loc, is_remote, country_evidence),
                source_layer="layer1",
                source_priority=1,
            )
        )
    return results


async def enrich_greenhouse_pay_transparency(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
    jobs: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """Enrich pay in place; quarantine detail-404 rows, never infer vacancy deletion.

    Other HTTP/schema failures remain fatal. Callers must omit quarantined identities
    from writes and withhold that board's expiry. The original listing is not evidence
    that a missing detail response can safely refresh or expire a persisted vacancy.
    """
    token = str(seed["token"])
    source_id = f"greenhouse:{token}"
    prefix = f"{token}-"
    pending = [
        job for job in jobs
        if job.get("source_id") == source_id
        and job.get("salary_min") is None
        and job.get("salary_max") is None
    ]
    semaphore = asyncio.Semaphore(8)

    async def fetch_detail(job: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        source_job_id = str(job.get("source_job_id") or "")
        if not source_job_id.startswith(prefix) or not source_job_id[len(prefix):]:
            raise ValueError(f"invalid Greenhouse source_job_id for pay lookup: {source_job_id}")
        provider_job_id = source_job_id[len(prefix):]
        url = f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{provider_job_id}?pay_transparency=true"
        async with semaphore:
            response = await request_with_backoff(client, limiter, "GET", url)
        payload = response.json()
        if not isinstance(payload, dict) or "pay_input_ranges" not in payload:
            raise ValueError("Greenhouse pay-transparency response did not include pay_input_ranges")
        return job, _greenhouse_salary(payload)

    results = await asyncio.gather(*(fetch_detail(job) for job in pending), return_exceptions=True)
    failures: list[str] = []
    warnings: list[dict[str, str]] = []
    for job, result in zip(pending, results):
        if isinstance(result, RequestHTTPError) and result.status_code == 404:
            warnings.append({
                "source_id": source_id,
                "source_job_id": str(job.get("source_job_id") or ""),
                "code": "greenhouse_detail_404",
                "action": "row_withheld_board_expiry_skipped",
                "reason": "Pay detail returned 404; listing status unverified, not marked deleted",
            })
            continue
        if isinstance(result, BaseException):
            failures.append(
                f"{job.get('source_job_id')}: {redact_sensitive_params(str(result))}"
            )
            continue
        _job, salary = result
        job.update(salary)
    if failures:
        raise RuntimeError("Greenhouse pay-transparency lookup failed: " + "; ".join(failures))
    return warnings


async def fetch_lever(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
) -> list[dict[str, Any]]:
    """Lever: GET https://api.lever.co/v0/postings/{token}?mode=json"""
    token = seed["token"]
    url = f"https://api.lever.co/v0/postings/{token}?mode=json"
    resp = await request_with_backoff(client, limiter, "GET", url)
    postings = resp.json()
    if not isinstance(postings, list):
        return []
    results: list[dict[str, Any]] = []

    for item in postings:
        job_id = item.get("id")
        title = item.get("text")
        apply_url = item.get("hostedUrl") or item.get("applyUrl")
        if not (job_id and title and apply_url):
            continue
        categories = item.get("categories") or {}
        loc = categories.get("location") or (categories.get("allLocations") or ["Remote"])[0]
        dept = categories.get("department") or categories.get("team")
        workplace = (item.get("workplaceType") or "").lower()
        explicit_remote = True if workplace == "remote" else (False if workplace == "onsite" else None)
        salary_range = item.get("salaryRange") or {}
        sal_min = salary_range.get("min")
        sal_max = salary_range.get("max")
        sal_curr = salary_range.get("currency") or "USD"
        sal_period = _lever_salary_period(salary_range.get("interval"))
        raw_interval = salary_range.get("interval")
        if isinstance(raw_interval, str) and raw_interval.strip() and sal_period is None:
            # The source states a period we do not store (daily, weekly, one-time...): salary unknown, never relabelled.
            sal_min = sal_max = sal_curr = None
        desc = f"{item.get('descriptionPlain') or item.get('description') or ''} {item.get('additionalPlain') or ''}"

        results.append(
            build_normalized_job(
                seed=seed,
                source="lever",
                source_type="lever",
                source_id=f"lever:{token}",
                source_job_id=f"{token}:{job_id}",
                title=title,
                location=str(loc),
                apply_url=apply_url,
                description_raw=desc,
                department=dept,
                employment_type=categories.get("commitment"),
                posted_at=item.get("createdAt"),
                explicit_remote=explicit_remote,
                salary_min=float(sal_min) if isinstance(sal_min, (int, float)) else None,
                salary_max=float(sal_max) if isinstance(sal_max, (int, float)) else None,
                currency=sal_curr,
                salary_period=sal_period,
                salary_period_stated=sal_period is not None,
                source_layer="layer1",
                source_priority=1,
            )
        )
    return results


async def fetch_ashby(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
) -> list[dict[str, Any]]:
    """Ashby: GET https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true"""
    token = seed["token"]
    url = f"https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true"
    resp = await request_with_backoff(client, limiter, "GET", url)
    payload = resp.json()
    jobs_raw = payload.get("jobs") or []
    results: list[dict[str, Any]] = []

    for item in jobs_raw:
        job_id = item.get("id") or item.get("jobUrl")
        title = item.get("title")
        apply_url = item.get("jobUrl") or item.get("applyUrl")
        if not (job_id and title and apply_url):
            continue
        loc = item.get("location") or "Remote"
        comp = item.get("compensation") or {}
        salary_text = comp.get("compensationTierSummary") or comp.get("scrapeableCompensationSalarySummary")
        is_remote = item.get("isRemote") if isinstance(item.get("isRemote"), bool) else None
        address = ((item.get("address") or {}).get("postalAddress") or {})
        country_hint = address.get("addressCountry")

        results.append(
            build_normalized_job(
                seed=seed,
                source="ashby",
                source_type="ashby",
                source_id=f"ashby:{token}",
                source_job_id=f"{token}:{job_id}",
                title=title,
                location=loc,
                apply_url=apply_url,
                description_raw=item.get("descriptionHtml") or item.get("descriptionPlain"),
                department=item.get("department") or item.get("team"),
                employment_type=item.get("employmentType"),
                posted_at=item.get("publishedAt"),
                explicit_remote=is_remote,
                salary_text=salary_text,
                country_code_hint=country_hint if isinstance(country_hint, str) and len(country_hint) == 2 else None,
                source_layer="layer1",
                source_priority=1,
            )
        )
    return results


async def fetch_smartrecruiters(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
) -> list[dict[str, Any]]:
    """SmartRecruiters: GET https://api.smartrecruiters.com/v1/companies/{token}/postings"""
    token = seed["token"]
    url = f"https://api.smartrecruiters.com/v1/companies/{token}/postings"
    resp = await request_with_backoff(client, limiter, "GET", url)
    payload = resp.json()
    content = payload.get("content") or []
    results: list[dict[str, Any]] = []

    for item in content:
        job_id = item.get("id") or item.get("uuid")
        title = item.get("name")
        if not (job_id and title):
            continue
        loc_obj = item.get("location") or {}
        city = loc_obj.get("city") or ""
        country_code = (loc_obj.get("country") or "").upper()
        is_remote = bool(loc_obj.get("remote"))
        loc_str = ", ".join(filter(None, [city, country_code])) or ("Remote" if is_remote else "Global")
        apply_url = f"https://jobs.smartrecruiters.com/{token}/{job_id}"
        dept = (item.get("department") or {}).get("label")

        results.append(
            build_normalized_job(
                seed=seed,
                source="smartrecruiters",
                source_type="smartrecruiters",
                source_id=f"smartrecruiters:{token}",
                source_job_id=f"{token}:{job_id}",
                title=title,
                location=loc_str,
                apply_url=apply_url,
                description_raw=title,
                department=dept,
                employment_type=(item.get("typeOfEmployment") or {}).get("label") if isinstance(item.get("typeOfEmployment"), dict) else None,
                posted_at=item.get("releasedDate"),
                explicit_remote=is_remote,
                country_code_hint=country_code if len(country_code) == 2 else None,
                source_layer="layer1",
                source_priority=1,
            )
        )
    return results


# ---------------------------------------------------------------------------
# LAYER 2: UNAUTHENTICATED ENTERPRISE & BIG TECH JSON APIs ('MNC_BIGTECH')
# ---------------------------------------------------------------------------

_WORKDAY_LOCK = asyncio.Lock()
# Shared across every Workday tenant in this process: once Workday rate-limits us, all boards wait out the
# server's Retry-After (or fail fast if it is longer than we are willing to wait) instead of retrying elsewhere.
_WORKDAY_COOLDOWN_UNTIL = 0.0
_WORKDAY_TENANT_NEXT: dict[str, float] = {}   # tenant host -> earliest monotonic time of its next request
_WORKDAY_LAST_TENANT_START = 0.0

def get_workday_tenant_spacing_seconds() -> float:
    """Configurable conservative spacing between Workday tenant starts (default: 60s, range: 60-120s)."""
    raw = os.getenv("WORKDAY_TENANT_SPACING_SECONDS")
    if raw is not None:
        try:
            s = float(raw)
            if os.getenv("WORKDAY_ALLOW_SHORT_SPACING_FOR_TESTS") == "1":
                return max(0.0, s)
            return max(60.0, min(120.0, s))
        except ValueError:
            pass
    return 60.0

WORKDAY_TENANT_SPACING_SECONDS = 2.0
WORKDAY_MAX_RETRIES = 4          # per page: at most 5 requests, all through the per-host limiter
WORKDAY_MAX_COOLDOWN_SECONDS = 30.0            # a single Retry-After longer than this fails the board at once
WORKDAY_MAX_BACKOFF_PER_PAGE_SECONDS = 60.0    # deadline for all of a page's waiting (cooldown, spacing, backoff)


class WorkdayRateLimited(RuntimeError):
    """Workday rate-limited this run beyond its retry/cooldown budget; the board is reported failed."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after  # seconds the server asked for; persisted so later runs defer


def new_workday_metrics() -> dict[str, Any]:
    """Per-board request observations, filled by fetch_workday_cxs/_workday_post (measurement only, never read back).

    http_requests: attempts, counted just before client.post, so a network exception still counts; status_counts
      counts responses received only, so its sum is lower than http_requests by the network errors.
    pages_requested: logical pages entered, not HTTP requests; a page stopped before any request (cooldown_active,
      page_budget) shows pages_requested 1 and http_requests 0.
    retry_after_seconds_seen: values parsed from a Retry-After header that was present and parseable; the fallback
      delay the code computes when it is missing or unparseable is not recorded.
    elapsed_seconds: set by the caller; wall time of the whole board, not latency (see run_ingestion).
    """
    return {"request_host": None, "http_requests": 0, "status_counts": {}, "network_errors": 0,
            "retry_after_seconds_seen": [], "pages_requested": 0, "jobs_fetched": 0, "elapsed_seconds": None,
            "last_status": None, "trigger_status": None, "error_class": None}


def _workday_end(metrics: dict[str, Any] | None, trigger: int | str | None, error_class: str) -> None:
    if metrics is not None:
        metrics.update(trigger_status=trigger, error_class=error_class)


async def _workday_post(client: httpx.AsyncClient, limiter: PerHostRateLimiter, url: str, body: dict[str, Any], headers: dict[str, str],
                        metrics: dict[str, Any] | None = None) -> dict[str, Any]:
    """One page request under the shared budget: limiter-paced, Retry-After respected, no transport switching."""
    global _WORKDAY_COOLDOWN_UNTIL
    tenant_host = urlparse(url).hostname or url
    if metrics is not None:
        metrics["request_host"] = urlparse(url).hostname  # host only: never a path, query, cookie or header
    page_budget = float(os.getenv("WORKDAY_PAGE_WAIT_BUDGET_SECONDS", str(WORKDAY_MAX_BACKOFF_PER_PAGE_SECONDS)))
    deadline = time.monotonic() + page_budget  # all retry/cooldown waiting for this page
    retry_at = 0.0  # network-error backoff, waited out at the top of the loop under the same deadline
    for attempt in range(WORKDAY_MAX_RETRIES + 1):
        now = time.monotonic()
        cooldown = _WORKDAY_COOLDOWN_UNTIL - now
        if cooldown > WORKDAY_MAX_COOLDOWN_SECONDS:
            _workday_end(metrics, None, "cooldown_active")
            raise WorkdayRateLimited(f"Workday cooldown active for {cooldown:.0f}s more; not requesting {url}", cooldown)
        wait = max(cooldown, _WORKDAY_TENANT_NEXT.get(tenant_host, 0.0) - now, retry_at - now)
        if now + wait > deadline:
            _workday_end(metrics, None, "page_budget")
            raise WorkdayRateLimited(
                f"Workday page budget of {page_budget:.0f}s would be exceeded waiting {wait:.0f}s more; "
                f"not requesting {url} after {attempt} request(s)"
            )
        if wait > 0:
            await asyncio.sleep(wait)
        await limiter.acquire(url)
        _WORKDAY_TENANT_NEXT[tenant_host] = time.monotonic() + WORKDAY_TENANT_SPACING_SECONDS
        if metrics is not None:
            metrics["http_requests"] += 1
        try:
            resp = await client.post(url, json=body, headers=headers)
        except (httpx.TimeoutException, httpx.NetworkError) as exc:
            if metrics is not None:
                metrics["network_errors"] += 1
            if attempt >= WORKDAY_MAX_RETRIES:
                _workday_end(metrics, "network", "network")
                raise RuntimeError(f"Workday network error for {url}: {redact_sensitive_params(str(exc))}") from None
            retry_at = time.monotonic() + 2.0 * (2 ** attempt)
            continue
        if metrics is not None:
            code = str(resp.status_code)
            metrics["status_counts"][code] = metrics["status_counts"].get(code, 0) + 1
            metrics["last_status"] = resp.status_code
            seen = parse_retry_after(resp.headers.get("Retry-After"), default_delay=None)  # type: ignore[arg-type]
            if seen is not None:  # only a header that was present and parseable, never the computed fallback
                metrics["retry_after_seconds_seen"].append(round(seen, 3))
        if resp.status_code == 429 or resp.status_code in (502, 503, 504):
            delay = parse_retry_after(resp.headers.get("Retry-After"), default_delay=2.0 * (2 ** attempt))
            # Honor server requested delay without shortening longer waits
            _WORKDAY_COOLDOWN_UNTIL = max(_WORKDAY_COOLDOWN_UNTIL, time.monotonic() + delay)
            if attempt >= WORKDAY_MAX_RETRIES or delay > WORKDAY_MAX_COOLDOWN_SECONDS or (time.monotonic() + delay > deadline):
                _workday_end(metrics, resp.status_code, "rate_limited_429" if resp.status_code == 429 else "server_5xx")
                # The effective wait may be our exponential fallback, not a source Retry-After header.
                header_delay = parse_retry_after(resp.headers.get("Retry-After"), default_delay=None)  # type: ignore[arg-type]
                delay_label = "Retry-After" if header_delay is not None else "fallback backoff"
                raise WorkdayRateLimited(
                    f"Workday HTTP {resp.status_code} for {url} ({delay_label} {delay:.0f}s) after {attempt + 1} request(s)",
                    delay,
                )
            continue
        if not resp.is_success:
            _workday_end(metrics, resp.status_code, "server_5xx" if resp.status_code >= 500 else "other")
        resp.raise_for_status()
        try:
            return resp.json()
        except ValueError:
            _workday_end(metrics, resp.status_code, "malformed")
            raise
    raise WorkdayRateLimited(f"Workday retry budget exhausted for {url}")



async def fetch_workday_cxs(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
    *,
    max_pages: int = 2,
    polite_delay: float = 1.0,
    metrics: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Workday CXS: POST https://{tenant}.{wd_cluster}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
    
    Executes one board at a time under _WORKDAY_LOCK with conservative tenant spacing. Every request goes through the
    per-host limiter and the shared Workday retry/cooldown budget (_workday_post); a rate limit is never
    retried with a different transport or fingerprint. When the budget is exhausted the board raises, so
    the source is reported failed and the run-level guard withholds writes.
    """
    async with _WORKDAY_LOCK:
        global _WORKDAY_LAST_TENANT_START
        now = time.monotonic()
        if _WORKDAY_LAST_TENANT_START > now:
            _WORKDAY_LAST_TENANT_START = 0.0
        spacing = get_workday_tenant_spacing_seconds()
        wait_tenant = max(0.0, (_WORKDAY_LAST_TENANT_START + spacing) - now)
        if _WORKDAY_LAST_TENANT_START > 0.0 and wait_tenant > 0.0:
            await asyncio.sleep(wait_tenant)
        _WORKDAY_LAST_TENANT_START = time.monotonic()

        tenant = seed["tenant"]
        cluster = seed.get("wd_cluster", "wd5")
        site = seed["site"]
        base_host = f"https://{tenant}.{cluster}.myworkdayjobs.com"
        url = f"{base_host}/wday/cxs/{tenant}/{site}/jobs"
        results: list[dict[str, Any]] = []

        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        }

        for page_idx in range(max_pages):
            if page_idx > 0 or polite_delay > 0:
                await asyncio.sleep(polite_delay)

            offset = page_idx * 20
            body = {"limit": 20, "offset": offset, "searchText": ""}
            if metrics is not None:
                metrics["pages_requested"] += 1
            resp_data = await _workday_post(client, limiter, url, body, headers, metrics)
            if not isinstance(resp_data, dict) or not isinstance(resp_data.get("jobPostings"), list):
                _workday_end(metrics, metrics["last_status"] if metrics is not None else None, "malformed")
                raise RuntimeError(f"Workday malformed page {page_idx} for {url}: no jobPostings list")  # never success-empty

            postings = resp_data["jobPostings"]
            if not postings:
                break

            for item in postings:
                title = item.get("title")
                external_path = item.get("externalPath") or ""
                bullet_fields = item.get("bulletFields") or []
                req_id = bullet_fields[0] if bullet_fields else external_path
                if not (title and (external_path or req_id)):
                    continue
                apply_url = f"{base_host}/en-US/{site}{external_path}" if external_path.startswith("/") else f"{base_host}/{site}"
                loc = item.get("locationsText") or "Global"
                desc = " ".join(str(b) for b in bullet_fields)

                results.append(
                    build_normalized_job(
                        seed=seed,
                        source="workday",
                        source_type="workday",
                        source_id=f"workday:{tenant}:{site}",
                        source_job_id=f"{tenant}:{site}:{req_id}",
                        title=title,
                        location=loc,
                        apply_url=apply_url,
                        description_raw=f"{title} {desc}",
                        posted_at=None,
                        source_layer="layer2",
                        source_priority=1,
                    )
                )
            if metrics is not None:
                metrics["jobs_fetched"] = len(results)
            if len(postings) < 20:
                break

        return results


async def fetch_amazon_jobs(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
    *,
    max_pages: int = 1,
) -> list[dict[str, Any]]:
    """Amazon Jobs JSON: GET https://www.amazon.jobs/en/search.json?offset=0&result_limit=100"""
    base_url = seed.get("url", "https://www.amazon.jobs/en/search.json")
    limit = int(seed.get("result_limit", 100))
    results: list[dict[str, Any]] = []

    for page_idx in range(max_pages):
        offset = page_idx * limit
        url = f"{base_url}?offset={offset}&result_limit={limit}"
        # Specify Accept-Encoding to prevent zstd negotiation which triggers httpx.DecodingError
        resp = await request_with_backoff(
            client,
            limiter,
            "GET",
            url,
            headers={"Accept-Encoding": "gzip, deflate, br"},
        )
        data = resp.json()
        jobs_list = data.get("jobs") or []
        if not jobs_list:
            break

        for item in jobs_list:
            job_id = item.get("id_icims") or item.get("id")
            title = item.get("title")
            job_path = item.get("job_path") or f"/en/jobs/{job_id}"
            if not (job_id and title):
                continue
            apply_url = job_path if job_path.startswith("http") else f"https://www.amazon.jobs{job_path}"
            loc = item.get("normalized_location") or item.get("location") or item.get("city") or "Seattle, WA, USA"
            country_code = (item.get("country_code") or "").upper()
            desc = f"{item.get('description_short') or ''} {item.get('basic_qualifications') or ''} {item.get('preferred_qualifications') or ''}"

            results.append(
                build_normalized_job(
                    seed=seed,
                    source="amazon_jobs",
                    source_type="amazon",
                    source_id="amazon",
                    source_job_id=f"amazon:{job_id}",
                    title=title,
                    location=loc,
                    apply_url=apply_url,
                    description_raw=desc,
                    department=item.get("job_category"),
                    posted_at=item.get("posted_date"),
                    country_code_hint=country_code if len(country_code) == 2 else None,
                    source_layer="layer2",
                    source_priority=1,
                )
            )
        if len(jobs_list) < limit:
            break

    return results


async def fetch_microsoft_jobs(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
    *,
    max_pages: int = 2,
) -> list[dict[str, Any]]:
    """Microsoft Careers JSON: GET https://apply.careers.microsoft.com/api/pcsx/search"""
    base_url = seed.get("url", "https://apply.careers.microsoft.com/api/pcsx/search")
    page_size = int(seed.get("page_size", 20))
    results: list[dict[str, Any]] = []

    for page_num in range(1, max_pages + 1):
        if "pcsx" in base_url:
            start = (page_num - 1) * page_size
            url = f"{base_url}?domain=microsoft.com&start={start}&num={page_size}"
        else:
            url = f"{base_url}?l=en_us&pg={page_num}&pgSz={page_size}&o=Recent&flt=true"

        resp = await request_with_backoff(client, limiter, "GET", url)
        data = resp.json()

        # Handle Eightfold / PCSX endpoint (https://apply.careers.microsoft.com/api/pcsx/search)
        if isinstance(data, dict) and "data" in data and isinstance(data["data"], dict) and "positions" in data["data"]:
            positions = data["data"].get("positions") or []
            if not positions:
                break
            for item in positions:
                job_id = item.get("atsJobId") or item.get("displayJobId") or item.get("id")
                title = item.get("name") or item.get("title")
                if not (job_id and title):
                    continue
                locs = item.get("locations") or []
                std_locs = item.get("standardizedLocations") or []
                loc = locs[0] if locs else (std_locs[0] if std_locs else "Redmond, WA, USA")
                pos_url = item.get("positionUrl") or f"/careers/job/{job_id}"
                apply_url = f"https://apply.careers.microsoft.com{pos_url}" if pos_url.startswith("/") else pos_url
                desc = item.get("department") or title
                work_opt = (item.get("workLocationOption") or "").lower()
                explicit_remote = True if "remote" in work_opt else (False if "onsite" in work_opt else None)
                posted_ts = item.get("postedTs")
                posted_at = datetime.fromtimestamp(posted_ts, tz=timezone.utc).isoformat() if posted_ts else None

                results.append(
                    build_normalized_job(
                        seed=seed,
                        source="microsoft_careers",
                        source_type="microsoft",
                        source_id="microsoft",
                        source_job_id=f"microsoft:{job_id}",
                        title=title,
                        location=loc,
                        apply_url=apply_url,
                        description_raw=desc,
                        department=item.get("department"),
                        posted_at=posted_at,
                        explicit_remote=explicit_remote,
                        source_layer="layer2",
                        source_priority=1,
                    )
                )
            if len(positions) < page_size:
                break
            continue

        # Legacy GCS endpoint fallback
        op_res = (data.get("operationResult") or {}).get("result") or {}
        jobs_list = op_res.get("jobs") or data.get("jobs") or []
        if not jobs_list:
            break

        for item in jobs_list:
            job_id = item.get("jobId") or item.get("id")
            title = item.get("title")
            if not (job_id and title):
                continue
            props = item.get("properties") or {}
            locs = props.get("locations") or [ props.get("primaryLocation") ]
            loc = next((x for x in locs if isinstance(x, str) and x.strip()), None) or item.get("location") or "Redmond, WA, USA"
            desc = props.get("description") or item.get("description") or title
            work_site = (props.get("workSiteFlexibility") or "").lower()
            explicit_remote = True if "100%" in work_site or "remote" in work_site else None
            apply_url = f"https://jobs.careers.microsoft.com/global/en/job/{job_id}"

            results.append(
                build_normalized_job(
                    seed=seed,
                    source="microsoft_careers",
                    source_type="microsoft",
                    source_id="microsoft",
                    source_job_id=f"microsoft:{job_id}",
                    title=title,
                    location=loc,
                    apply_url=apply_url,
                    description_raw=desc,
                    department=props.get("discipline") or props.get("profession"),
                    posted_at=item.get("postingDate"),
                    explicit_remote=explicit_remote,
                    source_layer="layer2",
                    source_priority=1,
                )
            )
        if len(jobs_list) < page_size:
            break

    return results
