"""Checklist #38 (missing/invalid source posting date): a source that gives no usable posting date must store a
null posted_at, never the ingestion time. Offline fixtures only; no network, no database."""
from __future__ import annotations

import asyncio
import json
import math
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from scripts.scraper import fetchers
from scripts.scraper.engine import SupabaseSetDiffWriter
from scripts.scraper.fetch_aggregators_and_india import normalize_aggregator_job

CLOCK_1 = "2026-11-25T08:00:00+00:00"
CLOCK_2 = "2026-11-26T08:00:00+00:00"

MISSING_OR_INVALID: list[Any] = [
    None, "", "   ", True, False, "not-a-date", "November 20, 2026", math.nan, math.inf, -math.inf,
    float("1e300"), ["2026-11-20"], {"date": "2026-11-20"},
]


def _seed() -> dict[str, Any]:
    return {"name": "Acme", "slug": "acme", "canonical_domain": "acme.com", "tenant": "acme", "site": "Careers"}


def _build(posted_at: Any, **kw: Any) -> dict[str, Any]:
    return fetchers.build_normalized_job(
        seed=_seed(), source="workday", source_type="workday", source_id="workday:acme:Careers",
        source_job_id="acme:Careers:R1", title="Backend Engineer", location="Austin, TX",
        apply_url="https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/R1", posted_at=posted_at, **kw,
    )


@pytest.mark.parametrize("raw", MISSING_OR_INVALID, ids=repr)
def test_missing_or_invalid_source_date_is_null_not_ingestion_time(raw: Any) -> None:
    with patch.object(fetchers, "_iso_now", return_value=CLOCK_1):
        assert fetchers._normalize_iso_date(raw) is None
        job = _build(raw)
    assert job["posted_at"] is None
    assert job["last_seen_at"] == CLOCK_1  # the observation time still advances


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2026-11-20T10:30:00Z", "2026-11-20T10:30:00+00:00"),
        ("2026-11-20T10:30:00+00:00", "2026-11-20T10:30:00+00:00"),
        ("2026-11-20T16:00:00+05:30", "2026-11-20T16:00:00+05:30"),  # offset kept, not rewritten
        ("2026-11-19T21:00:00-08:00", "2026-11-19T21:00:00-08:00"),
        (1763634600, "2025-11-20T10:30:00+00:00"),  # epoch seconds
        (1763634600000, "2025-11-20T10:30:00+00:00"),  # epoch milliseconds
    ],
)
def test_valid_explicit_source_dates_are_preserved(raw: Any, expected: str) -> None:
    with patch.object(fetchers, "_iso_now", return_value=CLOCK_1):
        assert _build(raw)["posted_at"] == expected


def test_timezone_less_timestamps_keep_current_behaviour() -> None:
    # Unresolved separate part of #38: a naive timestamp is still read as UTC. Not changed here.
    assert fetchers._normalize_iso_date("2026-11-20T10:30:00") == "2026-11-20T10:30:00+00:00"


def test_explicit_opt_in_still_available() -> None:
    with patch.object(fetchers, "_iso_now", return_value=CLOCK_1):
        assert fetchers._normalize_iso_date(None, missing_as_now=True) == CLOCK_1


def test_repeated_fetch_does_not_make_an_undated_job_look_newly_posted() -> None:
    with patch.object(fetchers, "_iso_now", return_value=CLOCK_1):
        first = _build(None)
    with patch.object(fetchers, "_iso_now", return_value=CLOCK_2):
        second = _build(None)
    assert first["posted_at"] is None and second["posted_at"] is None
    assert (first["last_seen_at"], second["last_seen_at"]) == (CLOCK_1, CLOCK_2)
    assert {k: v for k, v in first.items() if k != "last_seen_at"} == {k: v for k, v in second.items() if k != "last_seen_at"}


# --------------------------------------------------------------------------- providers (offline fixtures)

def _workday_fetch(clock: str) -> list[dict[str, Any]]:
    page = {"jobPostings": [{"title": "Backend Engineer", "externalPath": "/job/Austin/Backend-Engineer_R1",
                             "locationsText": "Austin, TX", "bulletFields": ["R1"], "postedOn": "Posted 30+ Days Ago"}]}

    async def run() -> list[dict[str, Any]]:
        with patch.object(fetchers, "_workday_post", AsyncMock(return_value=page)), \
             patch.object(fetchers, "get_workday_tenant_spacing_seconds", return_value=0.0), \
             patch.object(fetchers, "_iso_now", return_value=clock):
            return await fetchers.fetch_workday_cxs(MagicMock(), MagicMock(), _seed(), max_pages=1, polite_delay=0)

    return asyncio.run(run())


def test_workday_has_no_source_date_and_stores_null_on_every_fetch() -> None:
    first, second = _workday_fetch(CLOCK_1), _workday_fetch(CLOCK_2)
    assert [j["posted_at"] for j in first + second] == [None, None]
    assert first[0]["last_seen_at"] == CLOCK_1 and second[0]["last_seen_at"] == CLOCK_2
    assert first[0]["source_job_id"] == second[0]["source_job_id"] == "acme:Careers:R1"


def _lever_fetch(item: dict[str, Any]) -> dict[str, Any]:
    resp = MagicMock()
    resp.json.return_value = [{"id": "L1", "text": "Data Engineer", "hostedUrl": "https://jobs.lever.co/acme/L1",
                               "categories": {"location": "Remote"}, **item}]

    async def run() -> list[dict[str, Any]]:
        with patch.object(fetchers, "request_with_backoff", AsyncMock(return_value=resp)), \
             patch.object(fetchers, "_iso_now", return_value=CLOCK_1):
            return await fetchers.fetch_lever(MagicMock(), MagicMock(), {**_seed(), "token": "acme"})

    return asyncio.run(run())[0]


def test_lever_missing_created_at_is_null_and_valid_epoch_is_kept() -> None:
    assert _lever_fetch({})["posted_at"] is None
    assert _lever_fetch({"createdAt": 1763634600000})["posted_at"] == "2025-11-20T10:30:00+00:00"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", None),  # JobSpy passes str(date_posted or "")
        ("None", None),
        (None, None),
        ("2026-11-20T10:30:00Z", "2026-11-20T10:30:00+00:00"),  # Adzuna "created"
        (1763634600, "2025-11-20T10:30:00+00:00"),  # Arbeitnow "created_at" (epoch seconds)
    ],
)
def test_aggregator_caller(raw: Any, expected: str | None) -> None:
    with patch.object(fetchers, "_iso_now", return_value=CLOCK_1):
        job = normalize_aggregator_job(
            raw_company="Acme", title="Backend Engineer", location="Berlin, Germany",
            apply_url="https://example.test/apply/1", source="arbeitnow", source_job_id="arbeitnow:1", posted_at=raw,
        )
    assert job["posted_at"] == expected
    assert job["source"] == "arbeitnow"


# --------------------------------------------------------------------------- engine / payloads

def _sync(incoming: list[dict[str, Any]], existing_rows: list[dict[str, Any]]) -> tuple[dict[str, Any], list[tuple[str, dict[str, Any]]]]:
    writes: list[tuple[str, dict[str, Any]]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/jobs"):
            return httpx.Response(200, json=existing_rows)
        if request.method == "POST" and request.url.path.endswith("/jobs"):
            body = json.loads(request.content)
            writes.append(("POST", body))
            rows = body if isinstance(body, list) else [body]
            return httpx.Response(201, json=[{**r, "id": f"new-{i}"} for i, r in enumerate(rows)])
        if request.method == "PATCH" and request.url.path.endswith("/jobs"):
            body = json.loads(request.content)
            writes.append(("PATCH", body))
            ids = request.url.params.get("id", "").removeprefix("eq.").removeprefix("in.(").removesuffix(")")
            return httpx.Response(200, json=[{"id": i} for i in ids.split(",") if i])
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    async def run() -> dict[str, Any]:
        writer = SupabaseSetDiffWriter("https://unit-test-project.supabase.co", "fake-key")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await writer.sync_jobs_set_diff(client, incoming, {})

    return asyncio.run(run()), writes


def test_insert_payload_sends_explicit_null_so_the_db_default_now_never_applies() -> None:
    # public.jobs.posted_at is nullable with DEFAULT now(): only an OMITTED key would take now(); null is kept.
    job = _workday_fetch(CLOCK_1)[0]
    result, writes = _sync([job], [])
    assert not result["persistence_failed"]
    inserts = [row for method, body in writes if method == "POST" for row in (body if isinstance(body, list) else [body])]
    assert len(inserts) == 1
    assert "posted_at" in inserts[0] and inserts[0]["posted_at"] is None
    assert "first_seen_at" not in inserts[0]  # set once by the database on insert, never by the writer


def test_refetch_of_undated_job_only_touches_last_seen() -> None:
    first = _workday_fetch(CLOCK_1)[0]
    stored = {**{k: v for k, v in first.items()}, "id": "row-1", "first_seen_at": CLOCK_1}
    second = _workday_fetch(CLOCK_2)[0]
    result, writes = _sync([second], [stored])
    assert not result["persistence_failed"]
    assert result["updated"] == 0  # no synthetic repost / content change
    patches = [body for method, body in writes if method == "PATCH"]
    assert patches and all(set(p) == {"last_seen_at"} for p in patches)


def test_refetch_without_source_date_preserves_existing_valid_posted_at() -> None:
    valid = "2026-10-01T00:00:00+00:00"
    stored = {**_workday_fetch(CLOCK_1)[0], "id": "row-1", "posted_at": valid, "description": "Old description"}
    incoming = _workday_fetch(CLOCK_2)[0]
    result, writes = _sync([incoming], [stored])
    assert result["updated"] == 1
    patches = [body for method, body in writes if method == "PATCH" and "description" in body]
    assert patches and patches[0]["posted_at"] == valid
    assert "first_seen_at" not in patches[0]
