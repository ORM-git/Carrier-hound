from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx

from scripts.scraper.fetchers import (
    _explicit_country_code,
    _greenhouse_salary,
    enrich_greenhouse_pay_transparency,
    fetch_greenhouse,
)
from scripts.scraper.rate_limiter import PerHostRateLimiter


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "python-greenhouse-canary.json"


def test_greenhouse_country_tokens_are_unambiguous():
    assert _explicit_country_code("Remote US") == "US"
    assert _explicit_country_code("US-Remote") == "US"
    assert _explicit_country_code("Remote in US") == "US"
    assert _explicit_country_code("San Francisco, CA") is None
    assert _explicit_country_code("CA", allow_ambiguous_region_code=True) == "CA"


def test_greenhouse_salary_rounding_matches_typescript_math_round():
    salary = _greenhouse_salary({"pay_input_ranges": [{"min_cents": 10050, "max_cents": 20050, "currency_type": "USD"}]})
    assert salary["salary_min"] == 101
    assert salary["salary_max"] == 201


def test_selected_greenhouse_jobs_fetch_detail_pay_transparency():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, json={"pay_input_ranges": [{
            "min_cents": 12500000, "max_cents": 0, "currency_type": "USD", "title": "Annual salary",
        }]})

    job = {
        "source_id": "greenhouse:stripe", "source_job_id": "stripe-8172510",
        "salary_text": None, "salary_min": None, "salary_max": None,
    }

    async def hydrate():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await enrich_greenhouse_pay_transparency(
                client, PerHostRateLimiter(default_rps=100), {"token": "stripe"}, [job],
            )

    asyncio.run(hydrate())
    assert len(calls) == 1
    assert calls[0].endswith("/boards/stripe/jobs/8172510?pay_transparency=true")
    assert (job["salary_min"], job["salary_max"]) == (125000, None)
    assert job["currency"] == "USD"
    assert job["salary_period"] is None


def test_greenhouse_canary_normalizes_recorded_payload_without_inference_or_truncation():
    payload = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, json=payload)

    async def fetch():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await fetch_greenhouse(
                client,
                PerHostRateLimiter(default_rps=100),
                {"name": "Stripe", "slug": "stripe", "token": "stripe", "canonical_domain": "stripe.com"},
            )

    jobs = asyncio.run(fetch())
    by_id = {job["source_job_id"]: job for job in jobs}

    assert "content=true" in requested[0]
    assert "pay_transparency=true" in requested[0]
    assert len(jobs) == 9

    hourly = by_id["stripe-8172510"]
    assert hourly["source_id"] == "greenhouse:stripe"
    assert (hourly["salary_min"], hourly["salary_max"]) == (160000, 210000)
    assert hourly["currency"] == "USD"
    assert hourly["salary_period"] == "hourly"
    assert hourly["salary_text"] == "$160,000 - $210,000 /hr"
    assert hourly["posted_at"] == "2026-10-20T10:30:00+00:00"
    assert hourly["last_seen_at"] != hourly["posted_at"]
    assert len(hourly["description"]) > 4000
    assert "Benefits: health coverage and paid leave." in hourly["description"]
    assert "Qualifications:" in hourly["description"]
    assert "\n" in hourly["description"]
    assert "<" not in hourly["description"] and ">" not in hourly["description"]
    assert "alert('xss')" not in hourly["description"]
    assert hourly["country_code"] == "US"
    assert hourly["remote_eligibility"] == "country_restricted"

    mexico = by_id["stripe-8172511"]
    assert (mexico["salary_min"], mexico["salary_max"]) == (50000, None)
    assert mexico["currency"] == "MXN"
    assert mexico["country_code"] == "MX"
    assert mexico["posted_at"] is None

    one_sided = by_id["stripe-8172512"]
    assert (one_sided["salary_min"], one_sided["salary_max"]) == (None, 65000)
    assert one_sided["country_code"] is None
    assert one_sided["remote_eligibility"] == "unknown"
    assert one_sided["posted_at"] is None

    missing = by_id["stripe-8172513"]
    assert (missing["salary_text"], missing["salary_min"], missing["salary_max"]) == (None, None, None)
    assert missing["currency"] is None
    assert missing["salary_period"] is None
    assert missing["country_code"] is None
    assert missing["remote_eligibility"] == "worldwide"
    assert missing["posted_at"] is None

    explicit_us_token = by_id["stripe-8172514"]
    assert explicit_us_token["country_code"] == "US"
    assert explicit_us_token["remote_eligibility"] == "country_restricted"

    explicit_metadata = by_id["stripe-8172515"]
    assert explicit_metadata["country_code"] == "CA"
    assert explicit_metadata["remote_eligibility"] == "country_restricted"

    city_without_country = by_id["stripe-8172516"]
    assert city_without_country["country_code"] is None

    multi_country = by_id["stripe-8172517"]
    assert multi_country["country_code"] is None
    assert multi_country["location"] == "Remote US / Canada"
    assert multi_country["remote_scope"] == "remote"
    assert multi_country["remote_eligibility"] == "country_restricted"

    conflicting_metadata = by_id["stripe-8172518"]
    assert conflicting_metadata["country_code"] is None
    assert conflicting_metadata["location"] == "Remote US"
    assert conflicting_metadata["remote_eligibility"] == "country_restricted"

