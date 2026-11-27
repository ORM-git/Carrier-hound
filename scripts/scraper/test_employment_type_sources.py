"""Row 17: Python fetchers against documented provider values and the repo's own fixtures.

Doc sources (read 27 Nov 2026):
- Ashby employmentType enum "FullTime", "PartTime", "Intern", "Contract", "Temporary":
  https://developers.ashbyhq.com/docs/public-job-posting-api
- Lever categories.commitment: not enumerated (account text); README filter example uses "Fulltime" and "Intern":
  https://github.com/lever/postings-api
- SmartRecruiters typeOfEmployment {id, label}; example label "Full-time"; no value list documented:
  https://developers.smartrecruiters.com/docs/typeofemployment
"""
import asyncio
import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from scripts.scraper.fetchers import fetch_ashby, fetch_lever, fetch_smartrecruiters

LEVER_FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "lever-response.json"
SEED = {"name": "Acme", "slug": "acme", "token": "acme"}


def _run(fetch, payload):
    resp = MagicMock()
    resp.json.return_value = payload
    with patch("scripts.scraper.fetchers.request_with_backoff", AsyncMock(return_value=resp)):
        return asyncio.run(fetch(MagicMock(), MagicMock(), SEED))


def lever(value, title="Software Engineer"):
    cats = {"location": "Berlin, Germany"} if value is None else {"location": "Berlin, Germany", "commitment": value}
    return _run(fetch_lever, [{"id": "1", "text": title, "hostedUrl": "https://jobs.lever.co/acme/1", "categories": cats}])[0]["job_type"]


def ashby(value, title="Software Engineer"):
    item = {"id": "1", "title": title, "jobUrl": "https://jobs.ashbyhq.com/acme/1", "location": "Berlin, Germany"}
    if value is not None:
        item["employmentType"] = value
    return _run(fetch_ashby, {"jobs": [item]})[0]["job_type"]


def smartrecruiters(value, title="Software Engineer"):
    item = {"id": "1", "name": title, "location": {"city": "Berlin", "country": "de"}}
    if value is not None:
        item["typeOfEmployment"] = value
    return _run(fetch_smartrecruiters, {"content": [item]})[0]["job_type"]


class TestDocumentedValues(unittest.TestCase):
    def test_ashby_documented_enum(self) -> None:
        for raw, want in {"FullTime": "full-time", "PartTime": "part-time", "Intern": "internship",
                          "Contract": "contract", "Temporary": "other"}.items():
            self.assertEqual(ashby(raw), want, raw)

    def test_lever_documented_examples_and_unsupported(self) -> None:
        for raw, want in {"Fulltime": "full-time", "Intern": "internship", "Full-time": "full-time",
                          "Temporary": "other", "Full-time or Contract": "other"}.items():
            self.assertEqual(lever(raw), want, raw)

    def test_smartrecruiters_documented_example(self) -> None:
        self.assertEqual(smartrecruiters({"id": "prop_toe_permanent", "label": "Full-time"}), "full-time")
        self.assertEqual(smartrecruiters({"label": "Temporary"}), "other")
        self.assertEqual(smartrecruiters("Full-time"), "full-time")  # malformed (not an object): legacy fallback

    def test_absent_or_blank_keeps_legacy_title_fallback(self) -> None:
        for fetch in (lever, ashby, smartrecruiters):
            self.assertEqual(fetch(None), "full-time", fetch.__name__)
            self.assertEqual(fetch(None, title="Data Intern"), "internship", fetch.__name__)
        self.assertEqual(lever("   "), "full-time")
        self.assertEqual(smartrecruiters({"label": ""}), "full-time")

    def test_repo_lever_fixture(self) -> None:
        postings = json.loads(LEVER_FIXTURE.read_text(encoding="utf-8"))
        rows = _run(fetch_lever, postings)
        self.assertEqual([r["job_type"] for r in rows], ["full-time", "full-time"])


if __name__ == "__main__":
    unittest.main()
