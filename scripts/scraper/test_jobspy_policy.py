"""Source policy: no LinkedIn / Indeed / Naukri imports through JobSpy. Offline: nothing is scraped or written."""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from scripts.scraper import fetch_aggregators_and_india as agg
from scripts.scraper import run_ingestion


class JobSpyPolicyTests(unittest.TestCase):
    def test_default_run_scrapes_nothing_and_is_not_an_error(self):
        scrape_fn = AsyncMock()
        with patch.object(agg, "run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as proc:
            self.assertEqual(asyncio.run(agg.fetch_jobspy_india()), ([], None))
            self.assertEqual(asyncio.run(agg.fetch_jobspy_india(scrape_fn=scrape_fn)), ([], None))
        proc.assert_not_awaited()
        scrape_fn.assert_not_called()
        self.assertEqual(agg.BLOCKED_JOBSPY_SITES, {"linkedin", "indeed", "naukri"})

    def test_blocked_sites_are_never_requested_and_their_rows_are_dropped(self):
        asked: list[list[str]] = []

        def scrape(**kw):
            asked.append(kw["site_name"])
            return [{"title": "Dev", "company": "Acme", "job_url": f"https://example.com/{s}", "site": s}
                    for s in ("Indeed", "naukri", "linkedin", "glassdoor")]

        jobs, err = asyncio.run(agg.fetch_jobspy_india(
            roles=("Dev",), locations=("Bangalore, India",), sites=("LinkedIn", "glassdoor"), scrape_fn=scrape))
        self.assertIsNone(err)
        self.assertEqual(asked, [["glassdoor"]])
        self.assertEqual([j["source_id"] for j in jobs], ["jobspy:glassdoor"])

    def test_master_run_selecting_jobspy_scrapes_nothing_and_fails_nothing(self):
        with patch.object(agg, "run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as proc, \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                sources=["jobspy"], dry_run=True, transport=httpx.MockTransport(lambda r: httpx.Response(500))))
        proc.assert_not_awaited()
        src = [s for s in report["sources"] if s["source"] == "jobspy:india"][0]
        self.assertTrue(src["completed"])
        self.assertEqual(report["failed_sources"], [])
        self.assertEqual(report["fetched"], 0)

    def test_other_layer3_sources_stay_scheduled(self):
        ids = [p["id"] for p in run_ingestion.plan_sources({})]
        self.assertEqual(ids, ["jobspy:india", "arbeitnow", "adzuna:in"])


if __name__ == "__main__":
    unittest.main()
