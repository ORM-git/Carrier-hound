import asyncio
import json
import os
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from scripts.scraper.enrichment import strip_html
from scripts.scraper.fetchers import (
    _WORKDAY_LOCK,
    fetch_amazon_jobs,
    fetch_microsoft_jobs,
    fetch_workday_cxs,
)


class TestSourceFixes(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.seeds_path = Path(__file__).parent / "company_seeds.json"
        with open(cls.seeds_path, "r", encoding="utf-8") as f:
            cls.seeds_data = json.load(f)

    def test_dead_boards_removed_and_corrected(self) -> None:
        """Requirement 1: Verify dead boards are removed/corrected."""
        all_seeds = self.seeds_data.get("layer1_public_ats", [])
        seeds_by_slug = {s["slug"]: s for s in all_seeds}

        # Greenhouse retool must be removed (it migrated to Gem)
        self.assertNotIn("retool", seeds_by_slug, "retool should be removed from company_seeds")

        # Lever boards that migrated to Ashby
        migrated_to_ashby = {
            "mistral": "mistral.ai",
            "plaid": "plaid",
            "anyscale": "anyscale",
            "weaviate": "weaviate",
        }

        for slug, expected_token in migrated_to_ashby.items():
            self.assertIn(slug, seeds_by_slug, f"{slug} should exist in company_seeds")
            seed = seeds_by_slug[slug]
            self.assertEqual(seed.get("ats"), "ashby", f"{slug} ATS should be ashby")
            self.assertEqual(seed.get("token"), expected_token, f"{slug} token should be {expected_token}")
            self.assertNotEqual(seed.get("ats"), "lever", f"{slug} should no longer use lever")

    def test_workday_seeds_configuration(self) -> None:
        """Requirement 2: Verify Workday seed configs (walmart wd504, deloitte deloitteie/wd3)."""
        wd_seeds = self.seeds_data.get("layer2_enterprise_json", {}).get("workday_cxs", [])
        wd_by_slug = {s["slug"]: s for s in wd_seeds}

        self.assertIn("walmart", wd_by_slug)
        self.assertEqual(wd_by_slug["walmart"].get("wd_cluster"), "wd504")

        self.assertIn("deloitte", wd_by_slug)
        self.assertEqual(wd_by_slug["deloitte"].get("tenant"), "deloitteie")
        self.assertEqual(wd_by_slug["deloitte"].get("wd_cluster"), "wd3")
        self.assertEqual(wd_by_slug["deloitte"].get("site"), "Experienced_Professionals")

    def test_workday_serialized_execution(self) -> None:
        """Requirement 2: Verify Workday requests execute one board at a time using _WORKDAY_LOCK."""
        active_calls = 0
        max_concurrent_calls = 0

        async def _test() -> None:
            nonlocal active_calls, max_concurrent_calls

            async def mock_request(*args, **kwargs):
                nonlocal active_calls, max_concurrent_calls
                active_calls += 1
                if active_calls > max_concurrent_calls:
                    max_concurrent_calls = active_calls
                await asyncio.sleep(0.01)
                active_calls -= 1
                mock_resp = MagicMock()
                mock_resp.json.return_value = {"jobPostings": []}
                return mock_resp

            client = MagicMock()
            limiter = AsyncMock()

            seed1 = {"slug": "board1", "tenant": "t1", "site": "s1", "name": "B1"}
            seed2 = {"slug": "board2", "tenant": "t2", "site": "s2", "name": "B2"}

            with patch("scripts.scraper.fetchers.request_with_backoff", side_effect=mock_request):
                # Run two boards concurrently
                await asyncio.gather(
                    fetch_workday_cxs(client, limiter, seed1, max_pages=1, polite_delay=0.0),
                    fetch_workday_cxs(client, limiter, seed2, max_pages=1, polite_delay=0.0),
                )

            self.assertEqual(max_concurrent_calls, 1, "Workday boards must be serialized (max concurrency 1)")

        asyncio.run(_test())

    def test_amazon_accept_encoding_header(self) -> None:
        """Requirement 3: Verify Amazon requests include Accept-Encoding to prevent zstd decompressobj error."""
        async def _test() -> None:
            client = MagicMock()
            limiter = AsyncMock()
            seed = {"url": "https://www.amazon.jobs/en/search.json", "name": "Amazon", "slug": "amazon"}

            captured_headers = None

            async def mock_request(cli, lim, method, url, **kwargs):
                nonlocal captured_headers
                captured_headers = kwargs.get("headers", {})
                mock_resp = MagicMock()
                mock_resp.json.return_value = {"jobs": []}
                return mock_resp

            with patch("scripts.scraper.fetchers.request_with_backoff", side_effect=mock_request):
                await fetch_amazon_jobs(client, limiter, seed, max_pages=1)

            self.assertIsNotNone(captured_headers)
            self.assertIn("Accept-Encoding", captured_headers)
            self.assertIn("gzip", captured_headers["Accept-Encoding"])
            # Ensure zstd is NOT requested
            self.assertNotIn("zstd", captured_headers["Accept-Encoding"])

        asyncio.run(_test())

    def test_microsoft_endpoint_and_pcsx_parsing(self) -> None:
        """Requirement 4: Verify Microsoft endpoint uses PCSX and parses positions without disabling SSL."""
        ms_seed = self.seeds_data.get("layer2_enterprise_json", {}).get("microsoft", {})
        self.assertEqual(ms_seed.get("url"), "https://apply.careers.microsoft.com/api/pcsx/search")

        async def _test() -> None:
            client = MagicMock()
            limiter = AsyncMock()
            sample_pcsx = {
                "data": {
                    "positions": [
                        {
                            "atsJobId": "1809999",
                            "name": "Principal Software Engineer",
                            "locations": ["Redmond, WA, USA"],
                            "positionUrl": "/careers/job/1809999",
                            "department": "Azure",
                            "workLocationOption": "hybrid",
                            "postedTs": 1700000000,
                        }
                    ]
                }
            }

            async def mock_request(cli, lim, method, url, **kwargs):
                self.assertNotIn("verify", kwargs, "SSL verification must never be disabled")
                mock_resp = MagicMock()
                mock_resp.json.return_value = sample_pcsx
                return mock_resp

            with patch("scripts.scraper.fetchers.request_with_backoff", side_effect=mock_request):
                jobs = await fetch_microsoft_jobs(client, limiter, ms_seed, max_pages=1)

            self.assertEqual(len(jobs), 1)
            job = jobs[0]
            self.assertEqual(job["source_job_id"], "microsoft:1809999")
            self.assertEqual(job["title"], "Principal Software Engineer")
            self.assertEqual(job["location"], "Redmond, WA, USA")
            self.assertEqual(job["apply_url"], "https://apply.careers.microsoft.com/careers/job/1809999")
            self.assertEqual(job["source_type"], "microsoft")

        asyncio.run(_test())

    def test_python_jobspy_installed_and_nan_handling(self) -> None:
        """Requirement 5: Verify python-jobspy is importable and strip_html safely handles NaN/floats."""
        # Check jobspy import
        try:
            import jobspy  # noqa: F401
            jobspy_installed = True
        except ImportError:
            jobspy_installed = False
        self.assertTrue(jobspy_installed, "python-jobspy must be installed in the environment")

        # Check NaN/float handling in strip_html (e.g. from pandas DataFrame in JobSpy)
        self.assertEqual(strip_html(float("nan")), "")
        self.assertEqual(strip_html(None), "")
        self.assertEqual(strip_html("<b>Developer</b>"), "Developer")

    def test_jobspy_resilience_and_error_handling(self) -> None:
        """Requirement 5: JobSpy returns error when empty/missing, but succeeds when jobs are returned."""
        from scripts.scraper.fetch_aggregators_and_india import fetch_jobspy_india

        async def _test() -> None:
            # Case 1: missing/total failure -> error reported
            with patch("scripts.scraper.fetch_aggregators_and_india.run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as mock_proc:
                mock_proc.return_value = ([], "python-jobspy not installed")
                jobs, err = await fetch_jobspy_india(roles=("Dev",), locations=("Bangalore",))
                self.assertEqual(len(jobs), 0)
                self.assertIsNotNone(err)
                self.assertIn("python-jobspy", err)

            # Case 2: partial timeout but jobs returned -> succeeds without fatal error
            with patch("scripts.scraper.fetch_aggregators_and_india.run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as mock_proc:
                mock_proc.return_value = ([{"title": "Dev", "company": "Acme", "job_url": "https://example.com/1"}], None)
                jobs, err = await fetch_jobspy_india(roles=("Dev",), locations=("Bangalore",))
                self.assertEqual(len(jobs), 1)
                self.assertIsNone(err)

        asyncio.run(_test())


if __name__ == "__main__":
    unittest.main()
