import json
import pathlib

import pytest

from scripts.scraper.required_years import extract_required_years

FIXTURE = pathlib.Path(__file__).resolve().parents[2] / "src/lib/jobs/__tests__/fixtures/required-years-cases.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES, ids=lambda c: (c["text"][:40] or "empty"))
def test_matches_shared_fixture(case):
    got = extract_required_years(case["text"]) or (None, None)
    assert got == (case["min_experience_years"], case["max_experience_years"])


def test_nbsp_between_number_and_unit():
    assert extract_required_years("3+\u00a0years of experience") == (3, None)


def test_non_text_is_none():
    assert extract_required_years(None) is None
    assert extract_required_years(42) is None


# --- engine wiring: inert until the owner switch is on, never erases or downgrades a stored bound ---
from scripts.scraper import engine  # noqa: E402


def test_engine_years_columns_off_by_default(monkeypatch):
    monkeypatch.delenv(engine.YEARS_COLUMNS_ENV, raising=False)
    assert engine.years_columns_enabled() is False
    monkeypatch.setenv(engine.YEARS_COLUMNS_ENV, "1")
    assert engine.years_columns_enabled() is True


def test_apply_required_years_sets_only_when_stated():
    jobs = [{"description": "We need 3+ years of experience."}, {"description": "Strong communicator"}, {"description": None}]
    engine.apply_required_years(jobs)
    assert (jobs[0]["min_experience_years"], jobs[0]["max_experience_years"], jobs[0]["experience_years_source"]) == (3, None, "description")
    assert not any(f in jobs[1] for f in engine.YEARS_FIELDS)  # no explicit nulls
    assert not any(f in jobs[2] for f in engine.YEARS_FIELDS)


def test_keep_existing_years_never_erases_or_downgrades():
    existing = {"min_experience_years": 5, "max_experience_years": 8, "experience_years_source": "ats"}
    job = {"min_experience_years": 2, "max_experience_years": None, "experience_years_source": "description"}
    engine.keep_existing_years(job, existing)
    assert (job["min_experience_years"], job["max_experience_years"], job["experience_years_source"]) == (5, 8, "ats")
    # a bound parsed from text may refresh an older parsed bound
    job2 = {"min_experience_years": 4, "max_experience_years": None, "experience_years_source": "description"}
    engine.keep_existing_years(job2, {"min_experience_years": 3, "max_experience_years": None, "experience_years_source": "description"})
    assert job2["min_experience_years"] == 4
    # nothing extracted now: the stored bound is kept
    job3 = {}
    engine.keep_existing_years(job3, {"min_experience_years": 3, "max_experience_years": None, "experience_years_source": "description"})
    assert job3["min_experience_years"] == 3
    # no stored bound: untouched
    job4 = {"min_experience_years": 1}
    engine.keep_existing_years(job4, {})
    assert job4 == {"min_experience_years": 1}


def test_fingerprint_ignores_years_when_neither_side_has_them():
    row = {"title": "x", "company": "c"}
    assert engine.compute_content_fingerprint(row) == engine.compute_content_fingerprint(dict(row))
    assert engine.compute_content_fingerprint({**row, "min_experience_years": 3}) != engine.compute_content_fingerprint(row)
