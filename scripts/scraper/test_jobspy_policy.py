"""Source policy: no LinkedIn / Indeed / Naukri imports through JobSpy. Offline: nothing is scraped or written."""

from __future__ import annotations

import asyncio
import contextlib
import io
import sys
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from scripts.scraper import fetch_aggregators_and_india as agg
from scripts.scraper import run_ingestion
from scripts.scraper.run_ingestion import SourceSelectionError


def no_network(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"no request expected, got {request.method} {request.url.host}")


class JobSpyFetcherBlocklistTests(unittest.TestCase):
    """Defensive layer: even if called, the fetcher never scrapes or keeps a blocked site."""

    def test_default_call_scrapes_nothing_and_is_not_an_error(self):
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


class JobSpyPlanTests(unittest.TestCase):
    """Scheduling layer: a disabled source is not planned, so it can never report completed with zero jobs."""

    def test_not_planned_while_every_configured_site_is_blocked(self):
        self.assertEqual([p["id"] for p in run_ingestion.plan_sources({})], ["arbeitnow", "adzuna:in"])

    def test_planned_again_if_a_configured_site_is_unblocked(self):
        with patch.object(agg, "BLOCKED_JOBSPY_SITES", frozenset({"linkedin", "naukri"})):
            self.assertEqual([p["id"] for p in run_ingestion.plan_sources({})], ["jobspy:india", "arbeitnow", "adzuna:in"])

    def test_explicit_jobspy_selection_takes_the_unknown_source_error_path_before_any_work(self):
        for token in (["jobspy"], ["india"], ["jobspy,arbeitnow"]):
            with patch.object(agg, "run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as proc, \
                    patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                    self.assertRaises(SourceSelectionError) as ctx:
                asyncio.run(run_ingestion.run_master_ingestion(
                    sources=token, dry_run=True, transport=httpx.MockTransport(no_network)))
            proc.assert_not_awaited()
            self.assertIn("unknown source filter(s):", str(ctx.exception))
            self.assertNotIn("arbeitnow", str(ctx.exception).split(":", 1)[1])

    def test_cli_source_jobspy_exits_2_with_the_unknown_source_message(self):
        err = io.StringIO()
        with patch.object(sys, "argv", ["run_ingestion", "--source", "jobspy"]), \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                contextlib.redirect_stderr(err), self.assertRaises(SystemExit) as ctx:
            run_ingestion.main()
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("unknown source filter(s): jobspy", err.getvalue())

    def test_layer3_and_default_runs_have_no_jobspy_report_entry(self):
        empty = AsyncMock(return_value=([], None))
        for sources in (["layer3"], None):
            with patch.object(agg, "run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as proc, \
                    patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                    patch.object(run_ingestion, "fetch_arbeitnow", empty), \
                    patch.object(run_ingestion, "fetch_adzuna", empty), \
                    patch.object(run_ingestion, "fetch_layer1_seed", empty):
                report = asyncio.run(run_ingestion.run_master_ingestion(
                    sources=sources, cohort="non-workday" if sources is None else None, dry_run=True,
                    transport=httpx.MockTransport(no_network)))
            proc.assert_not_awaited()
            ids = [s["source"] for s in report["sources"]]
            self.assertNotIn("jobspy:india", ids)
            self.assertTrue({"arbeitnow", "adzuna:in"} <= set(ids), ids)

    def test_expiry_safeguards_unchanged(self):
        self.assertEqual(run_ingestion.PARTIAL_COVERAGE_SOURCES,
                         frozenset({"workday", "amazon", "microsoft", "arbeitnow", "smartrecruiters", "jobspy", "adzuna"}))


if __name__ == "__main__":
    unittest.main()
