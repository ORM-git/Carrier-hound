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

    def setUp(self) -> None:
        """Test-only isolation for the Workday tenant spacing: no real 60s waits, no state leaking in or out."""
        from scripts.scraper import fetchers

        saved_cooldown = dict(fetchers._WORKDAY_COOLDOWN_UNTIL)
        saved_last_start = fetchers._WORKDAY_LAST_TENANT_START
        saved_tenant_next = dict(fetchers._WORKDAY_TENANT_NEXT)

        def _restore_workday_state() -> None:
            fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
            fetchers._WORKDAY_COOLDOWN_UNTIL.update(saved_cooldown)
            fetchers._WORKDAY_LAST_TENANT_START = saved_last_start
            fetchers._WORKDAY_TENANT_NEXT.clear()
            fetchers._WORKDAY_TENANT_NEXT.update(saved_tenant_next)

        # Registered before any mutation; cleanups run LIFO, so the env patch below is undone too.
        self.addCleanup(_restore_workday_state)
        env_patch = patch.dict(
            os.environ,
            {"WORKDAY_TENANT_SPACING_SECONDS": "0", "WORKDAY_ALLOW_SHORT_SPACING_FOR_TESTS": "1"},
        )
        env_patch.start()
        self.addCleanup(env_patch.stop)

        fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
        fetchers._WORKDAY_TENANT_NEXT.clear()
        fetchers._WORKDAY_LAST_TENANT_START = 0.0

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
                return {"jobPostings": []}

            client = MagicMock()
            limiter = AsyncMock()

            seed1 = {"slug": "board1", "tenant": "t1", "site": "s1", "name": "B1"}
            seed2 = {"slug": "board2", "tenant": "t2", "site": "s2", "name": "B2"}

            with patch("scripts.scraper.fetchers._workday_post", side_effect=mock_request):
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

    # Fetch mechanics only: the blocklist is emptied so the retry/timeout handling stays covered (policy: test_jobspy_policy.py).
    @patch("scripts.scraper.fetch_aggregators_and_india.BLOCKED_JOBSPY_SITES", frozenset())
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

            # Case 2: every query succeeds -> no error
            with patch("scripts.scraper.fetch_aggregators_and_india.run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as mock_proc:
                mock_proc.return_value = ([{"title": "Dev", "company": "Acme", "job_url": "https://example.com/1"}], None)
                jobs, err = await fetch_jobspy_india(roles=("Dev",), locations=("Bangalore",))
                self.assertEqual(len(jobs), 1)
                self.assertIsNone(err)

            # Case 3: one query succeeds, the next times out -> rows kept for the report, source still incomplete
            with patch("scripts.scraper.fetch_aggregators_and_india.run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as mock_proc:
                mock_proc.side_effect = [
                    ([{"title": "Dev", "company": "Acme", "job_url": "https://example.com/1"}], None),
                    ([], "JobSpy timed out after 60.0s for QA in Bangalore"),
                ]
                jobs, err = await fetch_jobspy_india(roles=("Dev", "QA"), locations=("Bangalore",))
                self.assertEqual(len(jobs), 1)
                self.assertIsNotNone(err)
                self.assertIn("timed out", err)

        asyncio.run(_test())



class _Sleeps:
    """Records requested sleeps without waiting (and lets time pass as if they happened)."""

    def __init__(self) -> None:
        self.calls: list[float] = []
        self.offset = 0.0

    async def sleep(self, seconds: float) -> None:
        self.calls.append(seconds)
        self.offset += max(0.0, seconds)

    def monotonic(self) -> float:
        return self.offset


class TestWorkdaySharedBudget(unittest.TestCase):
    """One transport (httpx via the limiter), one bounded budget per page, Retry-After respected per tenant."""

    URL_HOST = "t1.wd5.myworkdayjobs.com"

    def setUp(self) -> None:
        from scripts.scraper import fetchers
        self.fetchers = fetchers
        fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
        fetchers._WORKDAY_TENANT_NEXT.clear()
        fetchers._WORKDAY_LAST_TENANT_START = 0.0
        self.clock = _Sleeps()
        self.requests: list[str] = []
        self.limiter_calls: list[str] = []

    def _run(self, handler, seeds):
        import httpx
        from scripts.scraper.rate_limiter import PerHostRateLimiter

        class Limiter(PerHostRateLimiter):
            async def acquire(inner, url: str) -> None:  # noqa: N805 - records, never waits
                self.limiter_calls.append(url)

        def record(request: httpx.Request) -> httpx.Response:
            self.requests.append(request.url.host)
            return handler(len(self.requests))

        async def _go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
                out = []
                for seed in seeds:
                    try:
                        out.append(await self.fetchers.fetch_workday_cxs(client, Limiter(), seed, max_pages=1, polite_delay=0.0))
                    except Exception as exc:  # noqa: BLE001
                        out.append(exc)
                return out

        with patch.object(self.fetchers.asyncio, "sleep", self.clock.sleep), \
                patch.object(self.fetchers.time, "monotonic", self.clock.monotonic):
            return asyncio.run(_go())

    def test_long_retry_after_fails_fast_and_cools_down_only_that_tenant(self) -> None:
        import httpx
        seeds = [{"slug": "a", "tenant": "t1", "site": "s1", "name": "A"}, {"slug": "b", "tenant": "t2", "site": "s2", "name": "B"},
                 {"slug": "a2", "tenant": "t1", "site": "s1", "name": "A"}]
        ok = httpx.Response(200, json={"jobPostings": [{"title": "Engineer", "externalPath": "/job/1", "bulletFields": ["R1"]}]})
        out = self._run(lambda n: httpx.Response(429, headers={"Retry-After": "120"}) if n == 1 else ok, seeds)
        self.assertIsInstance(out[0], self.fetchers.WorkdayRateLimited)
        self.assertEqual(len(out[1]), 1, "t2 is not paused by t1's Retry-After")
        self.assertIsInstance(out[2], self.fetchers.WorkdayRateLimited, "t1 stays cooled down for the rest of its 120s")
        self.assertEqual(self.requests, [self.URL_HOST, "t2.wd5.myworkdayjobs.com"], "t1 was not requested again")
        self.assertEqual(self.limiter_calls, [f"https://{self.URL_HOST}/wday/cxs/t1/s1/jobs",
                                              "https://t2.wd5.myworkdayjobs.com/wday/cxs/t2/s2/jobs"])
        self.assertEqual(sorted(self.fetchers._WORKDAY_COOLDOWN_UNTIL), [self.URL_HOST])
        self.assertTrue(all(s <= 60.0 for s in self.clock.calls), self.clock.calls)

    def test_short_retry_after_is_waited_out_within_the_page_budget(self) -> None:
        import httpx
        seed = {"slug": "a", "tenant": "t1", "site": "s1", "name": "A"}

        def handler(n):
            if n < 3:
                return httpx.Response(429, headers={"Retry-After": "5"})
            return httpx.Response(200, json={"jobPostings": [{"title": "Engineer", "externalPath": "/job/1", "bulletFields": ["R1"]}]})

        out = self._run(handler, [seed])
        self.assertEqual(len(out[0]), 1)
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(len(self.limiter_calls), 3, "every request, including retries, goes through the limiter")
        self.assertGreaterEqual(sum(self.clock.calls), 10.0, "each Retry-After must be honoured before the next request")

    def test_exhausted_budget_is_bounded_and_raises(self) -> None:
        import httpx
        seed = {"slug": "a", "tenant": "t1", "site": "s1", "name": "A"}
        out = self._run(lambda n: httpx.Response(429, headers={"Retry-After": "1"}), [seed])
        self.assertIsInstance(out[0], self.fetchers.WorkdayRateLimited)
        self.assertEqual(len(self.requests), self.fetchers.WORKDAY_MAX_RETRIES + 1)
        self.assertNotIn("curl_cffi", pathlib_text(self.fetchers.__file__))

    def test_run_45102410588_retry_after_8s_is_retried_until_success(self) -> None:
        import httpx
        seed = {"slug": "nvidia", "tenant": "t1", "site": "s1", "name": "A"}

        def handler(n):
            if n <= 3:  # the GitHub runner saw three 429s with Retry-After 8 and gave up
                return httpx.Response(429, headers={"Retry-After": "8"})
            return httpx.Response(200, json={"jobPostings": [{"title": "Engineer", "externalPath": "/job/1", "bulletFields": ["R1"]}]})

        out = self._run(handler, [seed])
        self.assertEqual(len(out[0]), 1, out)
        self.assertEqual(len(self.requests), 4)
        self.assertGreaterEqual(sum(self.clock.calls), 24.0)

    def test_short_retry_afters_stop_at_the_page_backoff_budget(self) -> None:
        import httpx
        seed = {"slug": "a", "tenant": "t1", "site": "s1", "name": "A"}
        out = self._run(lambda n: httpx.Response(429, headers={"Retry-After": "25"}), [seed])
        self.assertIsInstance(out[0], self.fetchers.WorkdayRateLimited)
        self.assertEqual(len(self.requests), 3, "25s + 25s + 25s exceeds the 60s page budget on the third 429")
        self.assertLessEqual(sum(self.clock.calls), self.fetchers.WORKDAY_MAX_BACKOFF_PER_PAGE_SECONDS)

    def test_mixed_timeout_and_429_waits_share_one_page_deadline(self) -> None:
        import httpx
        seed = {"slug": "a", "tenant": "t1", "site": "s1", "name": "A"}

        def handler(n):
            if n == 1:
                raise httpx.ReadTimeout("timed out")  # 2s network backoff
            if n in (2, 3):
                return httpx.Response(429, headers={"Retry-After": "30"})
            return httpx.Response(200, json={"jobPostings": [{"title": "Engineer", "externalPath": "/job/1", "bulletFields": ["R1"]}]})

        out = self._run(handler, [seed])
        self.assertIsInstance(out[0], self.fetchers.WorkdayRateLimited)
        self.assertEqual(len(self.requests), 3, "2s + 30s + 30s passes the 60s deadline: request 4 must not be sent")
        self.assertLessEqual(sum(self.clock.calls), self.fetchers.WORKDAY_MAX_BACKOFF_PER_PAGE_SECONDS)

    def test_inherited_cooldown_counts_against_the_page_deadline(self) -> None:
        import httpx
        self.fetchers._WORKDAY_COOLDOWN_UNTIL[self.URL_HOST] = 25.0  # left by this tenant's earlier 429
        seed = {"slug": "a", "tenant": "t1", "site": "s1", "name": "A"}

        def handler(n):
            if n <= 2:
                return httpx.Response(429, headers={"Retry-After": "30"})
            return httpx.Response(200, json={"jobPostings": [{"title": "Engineer", "externalPath": "/job/1", "bulletFields": ["R1"]}]})

        out = self._run(handler, [seed])
        self.assertIsInstance(out[0], self.fetchers.WorkdayRateLimited)
        self.assertEqual(len(self.requests), 2, "25s inherited + 30s + 30s passes the 60s deadline: request 3 must not be sent")
        self.assertLessEqual(sum(self.clock.calls), self.fetchers.WORKDAY_MAX_BACKOFF_PER_PAGE_SECONDS)

    def test_requests_are_spaced_per_tenant_not_across_tenants(self) -> None:
        import httpx
        sent: list[tuple[str, float]] = []

        def record(request: httpx.Request) -> httpx.Response:
            sent.append((request.url.host, self.clock.offset))
            return httpx.Response(200, json={"jobPostings": []})

        class Limiter:
            async def acquire(self, url: str) -> None:
                return None

        async def _go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
                for url in ("https://t1.wd5.myworkdayjobs.com/x", "https://t2.wd5.myworkdayjobs.com/x", "https://t1.wd5.myworkdayjobs.com/x"):
                    await self.fetchers._workday_post(client, Limiter(), url, {}, {})

        with patch.object(self.fetchers.asyncio, "sleep", self.clock.sleep), \
                patch.object(self.fetchers.time, "monotonic", self.clock.monotonic):
            asyncio.run(_go())
        self.assertEqual(sent[0][1], 0.0)
        self.assertEqual(sent[1][1], 0.0, "a different tenant is not delayed by t1's spacing")
        self.assertGreaterEqual(sent[2][1] - sent[0][1], self.fetchers.WORKDAY_TENANT_SPACING_SECONDS)


def pathlib_text(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


class TestMixedSuccessZeroWriteVeto(unittest.TestCase):
    """End to end through run_master_ingestion in write mode: a source with one good and one failed query
    must be reported failed, and no writer may be constructed or called."""

    def _run(self, sources, transport_handler):
        import httpx
        from scripts.scraper import fetchers, rate_limiter, run_ingestion

        fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
        fetchers._WORKDAY_TENANT_NEXT.clear()
        fetchers._WORKDAY_LAST_TENANT_START = 0.0
        env = {
            "NEXT_PUBLIC_SUPABASE_URL": "https://unit-test-project.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "fake-service-role-key-for-tests-0123456789",
            "ADZUNA_APP_ID": "fake-id", "ADZUNA_APP_KEY": "fake-key",
        }
        writer = MagicMock(side_effect=AssertionError("writer must not be constructed"))
        db_calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "unit-test-project.supabase.co":
                db_calls.append(request.url.path)
                return httpx.Response(500)
            return transport_handler(request)

        async def no_sleep(_s: float) -> None:
            return None

        with patch.dict(os.environ, env), \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                patch.object(run_ingestion, "SupabaseSetDiffWriter", writer), \
                patch.object(rate_limiter.asyncio, "sleep", no_sleep):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                sources=sources, dry_run=False, max_rows=50, transport=httpx.MockTransport(handler)))
        return report, writer, db_calls

    # Fetch mechanics only: the blocklist is emptied so the retry/timeout handling stays covered (policy: test_jobspy_policy.py).
    @patch("scripts.scraper.fetch_aggregators_and_india.BLOCKED_JOBSPY_SITES", frozenset())
    def test_jobspy_one_query_ok_next_times_out_withholds_all_writes(self) -> None:
        import httpx
        calls = {"n": 0}

        async def scrape(**kwargs):
            calls["n"] += 1
            if calls["n"] == 1:
                return ([{"title": "Backend Engineer", "company": "Acme", "job_url": "https://example.com/j/1", "site": "indeed"}], None)
            return ([], f"JobSpy timed out after 60.0s for {kwargs.get('search_term')} in {kwargs.get('location')}")

        with patch("scripts.scraper.fetch_aggregators_and_india.run_jobspy_scrape_in_subprocess", side_effect=scrape):
            report, writer, db_calls = self._run(["jobspy"], lambda r: httpx.Response(404))
        self.assertGreater(calls["n"], 1)
        src = [s for s in report["sources"] if s["source"] == "jobspy:india"][0]
        self.assertEqual(src["status"], "failed")
        self.assertFalse(src["completed"])
        self.assertIn("timed out", src["error"])
        self.assertEqual([f["source"] for f in report["failed_sources"]], ["jobspy:india"])
        writer.assert_not_called()
        self.assertEqual(db_calls, [])
        self.assertEqual(report["db"]["inserted"], 0)

    def test_adzuna_one_country_ok_other_503_withholds_all_writes(self) -> None:
        import httpx

        def adzuna(request: httpx.Request) -> httpx.Response:
            if request.url.host != "api.adzuna.com":
                return httpx.Response(404)
            if "/jobs/in/" in request.url.path:
                return httpx.Response(200, json={"results": [{
                    "id": f"in-{request.url.params.get('what')}", "title": "Data Analyst", "company": {"display_name": "Acme"},
                    "redirect_url": "https://www.adzuna.in/land/ad/1", "location": {"display_name": "Bangalore"}, "created": "2026-11-22T00:00:00Z",
                }]})
            return httpx.Response(503)

        report, writer, db_calls = self._run(["adzuna"], adzuna)
        src = [s for s in report["sources"] if s["source"] == "adzuna:in"][0]
        self.assertEqual(src["status"], "failed")
        self.assertIn("Adzuna", src["error"])
        self.assertNotIn("fake-key", json.dumps(report))
        self.assertTrue(report["failed_sources"])
        writer.assert_not_called()
        self.assertEqual(db_calls, [])

    def test_workday_rate_limited_board_is_reported_failed_and_withholds_writes(self) -> None:
        import httpx
        report, writer, db_calls = self._run(
            ["workday"], lambda r: httpx.Response(429, headers={"Retry-After": "120"}) if "myworkdayjobs.com" in r.url.host else httpx.Response(404))
        workday = [s for s in report["sources"] if s["source"].startswith("workday:")]
        self.assertTrue(workday)
        self.assertTrue(all(s["status"] == "failed" for s in workday), workday)
        writer.assert_not_called()
        self.assertEqual(db_calls, [])


if __name__ == "__main__":
    unittest.main()
