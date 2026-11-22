"""Layer 1 (Public ATS) and Layer 2 (Workday CXS, Amazon, Microsoft) async fetchers."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import math
import re
from typing import Any

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
from .rate_limiter import PerHostRateLimiter, redact_sensitive_params, request_with_backoff

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


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_iso_date(raw: Any, *, missing_as_now: bool = True) -> str | None:
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
    countries = _explicit_country_codes(location)
    metadata = item.get("metadata")
    if isinstance(metadata, list):
        for entry in metadata:
            if not isinstance(entry, dict) or not re.search(r"\bcountry\b", str(entry.get("name") or ""), re.I):
                continue
            value = entry.get("value")
            if isinstance(value, str):
                countries.update(_explicit_country_codes(value, allow_ambiguous_region_code=True))
    return countries


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
        return {"salary_text": None, "salary_min": None, "salary_max": None, "currency": None, "salary_period": None}

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
    return {"salary_text": salary_text, "salary_min": salary_min, "salary_max": salary_max, "currency": currency, "salary_period": period}


def _detect_remote(title: str, location: str, explicit_remote: bool | None = None) -> bool:
    if isinstance(explicit_remote, bool):
        return explicit_remote
    combined = f"{title} {location}".lower()
    return any(w in combined for w in ("remote", "work from home", "wfh", "anywhere", "distributed"))


def _detect_job_type(title: str, raw_type: str = "") -> str:
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
    salary_period: str | None = "year",
    country_code_hint: str | None = None,
    infer_country_from_location: bool = True,
    country_unknown_as_location: bool = True,
    posted_at_missing_as_now: bool = True,
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

    clean_desc = strip_html(description_raw) if description_raw else (f"{clean_title} at {company_name}" if description_fallback else "")
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
        "job_type": _detect_job_type(clean_title, department or ""),
        "category": legacy_category,
        "role_category": role_category,
        "top_keywords": top_keywords,
        "skills": top_keywords,
        "salary_text": salary_text,
        "salary_min": salary_min,
        "salary_max": salary_max,
        "currency": currency,
        "salary_period": salary_period,
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
) -> None:
    """Fetch documented per-job pay ranges for selected Greenhouse identities in place."""
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
    for job, result in zip(pending, results):
        if isinstance(result, BaseException):
            failures.append(
                f"{job.get('source_job_id')}: {redact_sensitive_params(str(result))}"
            )
            continue
        _job, salary = result
        job.update(salary)
    if failures:
        raise RuntimeError("Greenhouse pay-transparency lookup failed: " + "; ".join(failures))


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
                posted_at=item.get("createdAt"),
                explicit_remote=explicit_remote,
                salary_min=float(sal_min) if isinstance(sal_min, (int, float)) else None,
                salary_max=float(sal_max) if isinstance(sal_max, (int, float)) else None,
                currency=sal_curr,
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


async def fetch_workday_cxs(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
    *,
    max_pages: int = 2,
) -> list[dict[str, Any]]:
    """Workday CXS: POST https://{tenant}.{wd_cluster}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs"""
    tenant = seed["tenant"]
    cluster = seed.get("wd_cluster", "wd5")
    site = seed["site"]
    base_host = f"https://{tenant}.{cluster}.myworkdayjobs.com"
    url = f"{base_host}/wday/cxs/{tenant}/{site}/jobs"
    results: list[dict[str, Any]] = []

    for page_idx in range(max_pages):
        offset = page_idx * 20
        body = {"limit": 20, "offset": offset, "searchText": ""}
        resp = await request_with_backoff(
            client,
            limiter,
            "POST",
            url,
            json=body,
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        data = resp.json()
        postings = data.get("jobPostings") or []
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
        resp = await request_with_backoff(client, limiter, "GET", url)
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
    """Microsoft Careers JSON: GET https://gcsservices.careers.microsoft.com/search/api/v1/search"""
    base_url = seed.get("url", "https://gcsservices.careers.microsoft.com/search/api/v1/search")
    page_size = int(seed.get("page_size", 20))
    results: list[dict[str, Any]] = []

    for page_num in range(1, max_pages + 1):
        url = f"{base_url}?l=en_us&pg={page_num}&pgSz={page_size}&o=Recent&flt=true"
        resp = await request_with_backoff(client, limiter, "GET", url)
        data = resp.json()
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
