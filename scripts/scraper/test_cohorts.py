"""Cohort isolation tests: exact source partition, per-cohort write guard, honest reports. Offline only."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from scripts.scraper import engine, ingest_report, rate_limiter, run_ingestion

FAKE_HOST = "unit-test-project.supabase.co"
FAKE_ENV = {"NEXT_PUBLIC_SUPABASE_URL": f"https://{FAKE_HOST}", "SUPABASE_SERVICE_ROLE_KEY": "fake-service-role-key-for-tests-0123456789"}
REAL_SEEDS = json.loads(Path(engine.DEFAULT_SEEDS_PATH).read_text(encoding="utf-8"))
SEEDS = {
    "layer1_public_ats": [{"ats": "greenhouse", "slug": "acme", "token": "acme", "name": "Acme"}],
    "layer2_enterprise_json": {"workday_cxs": [
        {"slug": "nvidia", "name": "NVIDIA", "tenant": "nvidia", "wd_cluster": "wd5", "site": "NVIDIAExternalCareerSite"},
    ]},
}


def job(source_id: str, n: int = 1) -> dict:
    return {"source_id": source_id, "source_type": source_id.split(":")[0], "source_job_id": str(n),
            "title": "Engineer", "company": "Acme", "apply_url": f"https://example.com/{source_id}/{n}"}


class SelectorTests(unittest.TestCase):
    def test_cohorts_partition_the_real_seed_plan_exactly(self):
        plan = run_ingestion.plan_sources(REAL_SEEDS)
        ids = [p["id"] for p in plan]
        self.assertEqual(len(ids), len(set(ids)), "planned source ids must be unique")
        wd = {p["id"] for p in run_ingestion.select_sources(plan, {"all"}, "workday")}
        other = {p["id"] for p in run_ingestion.select_sources(plan, {"all"}, "non-workday")}
        self.assertFalse(wd & other, "no overlap")
        self.assertEqual(wd | other, set(ids), "no omission")
        self.assertEqual(wd, {p["id"] for p in plan if p["type"] == "workday"})
        self.assertEqual(len(wd), len(REAL_SEEDS["layer2_enterprise_json"]["workday_cxs"]))
        self.assertEqual({p["id"] for p in run_ingestion.select_sources(plan, {"all"}, None)}, set(ids))

    def test_aliases_cannot_move_a_source_between_cohorts(self):
        config = {"layer1_public_ats": [{"ats": "greenhouse", "slug": "workday"}],
                  "layer2_enterprise_json": {"workday_cxs": [{"slug": "acme"}]}}
        plan = run_ingestion.plan_sources(config)
        wd = [p["id"] for p in run_ingestion.select_sources(plan, {"all"}, "workday")]
        self.assertEqual(wd, ["workday:acme"])
        self.assertIn("greenhouse:workday", [p["id"] for p in run_ingestion.select_sources(plan, {"all"}, "non-workday")])

    def test_unknown_contradictory_or_empty_selection_is_refused(self):
        plan = run_ingestion.plan_sources(SEEDS)
        cases = [({"greenhous"}, None), ({"all"}, "workdays"), ({"greenhouse"}, "workday"), ({"all"}, "")]
        for filt, cohort in cases:
            with self.subTest(filt=filt, cohort=cohort), self.assertRaises(run_ingestion.SourceSelectionError):
                run_ingestion.select_sources(plan, filt, cohort)
        no_workday = run_ingestion.plan_sources({"layer1_public_ats": [{"ats": "lever", "slug": "x"}]})
        with self.assertRaises(run_ingestion.SourceSelectionError):
            run_ingestion.select_sources(no_workday, {"all"}, "workday")

    def test_existing_filters_are_unchanged(self):
        plan = run_ingestion.plan_sources(REAL_SEEDS)
        self.assertEqual([p["id"] for p in run_ingestion.select_sources(plan, {"greenhouse:stripe"}, None)], ["greenhouse:stripe"])
        layer2 = {p["type"] for p in run_ingestion.select_sources(plan, {"layer2"}, None)}
        self.assertEqual(layer2, {"workday", "amazon", "microsoft"})

    def test_cli_rejects_unknown_cohort_and_cohort_with_source(self):
        for argv in (["--cohort", "bogus"], ["--cohort", "workday", "--source", "greenhouse"]):
            with self.subTest(argv=argv), patch("sys.argv", ["prog", *argv]), \
                    contextlib.redirect_stderr(open(os.devnull, "w")), contextlib.redirect_stdout(open(os.devnull, "w")), \
                    patch.object(run_ingestion, "load_dotenv_into_env", lambda: None):
                with self.assertRaises(SystemExit) as ctx:
                    run_ingestion.main()
                self.assertEqual(ctx.exception.code, 2)


class CohortRunTests(unittest.TestCase):
    """Real run_master_ingestion per cohort; fetchers patched or HTTP-mocked; the writer is a recording mock."""

    def setUp(self):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(SEEDS, tmp)
        tmp.close()
        self.seeds = tmp.name
        self.addCleanup(os.unlink, tmp.name)
        self.db_calls: list[tuple[str, str]] = []
        self.workday_requests = 0

    def make_writer(self, *, company_sync_fails: bool = False):
        writer_cls = MagicMock(name="SupabaseSetDiffWriter")
        inst = writer_cls.return_value
        inst.persistence_failed = False
        inst.failed_writes = 0
        inst.write_errors = []
        inst.base_url = f"https://{FAKE_HOST}/rest/v1"
        inst.headers = {}

        async def sync_companies(_client, jobs):
            if company_sync_fails:
                inst.persistence_failed = True
                inst.failed_writes = 1
                inst.write_errors = ["companies: HTTP 500"]
            return {}

        async def sync_jobs(_client, jobs, _company_map):
            keys = [[j["source_id"], j["source_job_id"]] for j in jobs]
            return {"inserted": len(jobs), "updated": 0, "skipped_unchanged": 0, "persisted_ids": [], "persisted_source_keys": keys}

        inst.sync_companies = AsyncMock(side_effect=sync_companies)
        inst.sync_jobs_set_diff = AsyncMock(side_effect=sync_jobs)
        return writer_cls

    def handler(self, workday_status: int, retry_after: str = "8", baseline: int = 1):
        def handle(request: httpx.Request) -> httpx.Response:
            if request.url.host == FAKE_HOST:
                self.db_calls.append((request.method, request.url.path))
                return httpx.Response(200, headers={"content-range": f"0-0/{baseline}"}, json=[])
            if "myworkdayjobs.com" in request.url.host:
                self.workday_requests += 1
                if workday_status == 429:
                    return httpx.Response(429, headers={"Retry-After": retry_after})
                return httpx.Response(200, json={"total": 1, "jobPostings": [
                    {"title": "GPU Engineer", "externalPath": "/job/Santa-Clara/GPU-Engineer_JR1", "locationsText": "Santa Clara, CA",
                     "postedOn": "Posted Today", "bulletFields": ["JR1"]}]})
            return httpx.Response(404)
        return handle

    def run_cohort(self, cohort: str, writer_cls, handler, *, greenhouse_error: str | None = None, expire: bool = False):
        ok = AsyncMock(return_value=([], None))
        greenhouse = AsyncMock(return_value=([job("greenhouse:acme")], greenhouse_error))

        async def no_sleep(_s: float) -> None:
            return None

        with patch.dict(os.environ, FAKE_ENV), \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                patch.object(run_ingestion, "SupabaseSetDiffWriter", writer_cls), \
                patch.object(run_ingestion, "fetch_layer1_seed", greenhouse), \
                patch.object(run_ingestion, "enrich_greenhouse_pay_transparency", AsyncMock(return_value=None)), \
                patch.object(run_ingestion, "fetch_jobspy_india", ok), \
                patch.object(run_ingestion, "fetch_arbeitnow", ok), \
                patch.object(run_ingestion, "fetch_adzuna", ok), \
                patch.object(rate_limiter.asyncio, "sleep", no_sleep):
            return asyncio.run(run_ingestion.run_master_ingestion(
                seeds_path=self.seeds, dry_run=False, max_rows=None, allow_uncapped=True,
                no_expire=not expire, allow_expire=expire, cohort=cohort, transport=httpx.MockTransport(handler)))

    def test_repeated_workday_429_does_not_block_a_healthy_non_workday_cohort(self):
        handler = self.handler(429, retry_after="8")
        other_writer, wd_writer = self.make_writer(), self.make_writer()

        other = self.run_cohort("non-workday", other_writer, handler)
        self.assertEqual(self.workday_requests, 0, "non-workday cohort never touches Workday")
        self.assertEqual(other["failed_sources"], [])
        other_writer.return_value.sync_companies.assert_awaited_once()
        self.assertEqual(other["persisted_counts"]["inserted"], 1)
        self.assertIsNone(other["guard_block_reason"])
        self.assertEqual(other["cohort"], "non-workday")
        self.assertNotIn("workday:nvidia", other["selected_sources"])

        wd = self.run_cohort("workday", wd_writer, handler)
        self.assertGreater(self.workday_requests, 1, "short Retry-After is retried (bounded), not hammered forever")
        self.assertEqual([f["source"] for f in wd["failed_sources"]], ["workday:nvidia"])
        wd_writer.return_value.sync_companies.assert_not_called()
        wd_writer.return_value.sync_jobs_set_diff.assert_not_called()
        self.assertEqual(wd["persisted_counts"], {"inserted": 0, "updated": 0, "unchanged": 0})
        self.assertIn("write_withheld", wd["guard_block_reason"])
        self.assertTrue(engine.ingestion_has_errors(wd))
        self.assertFalse(engine.ingestion_has_errors(other))

    def test_failed_non_workday_board_blocks_all_non_workday_writes_and_expiry(self):
        writer = self.make_writer()
        report = self.run_cohort("non-workday", writer, self.handler(200), greenhouse_error="HTTP 503", expire=True)
        self.assertEqual([f["source"] for f in report["failed_sources"]], ["greenhouse:acme"])
        writer.return_value.sync_companies.assert_not_called()
        writer.return_value.sync_jobs_set_diff.assert_not_called()
        self.assertFalse([c for c in self.db_calls if c[0] == "PATCH"], "no expiry")
        self.assertEqual(report["db"]["expired"], 0)

    def test_company_sync_failure_stops_job_writes_and_vetoes_expiry(self):
        writer = self.make_writer(company_sync_fails=True)
        report = self.run_cohort("non-workday", writer, self.handler(200), expire=True)
        writer.return_value.sync_jobs_set_diff.assert_not_called()
        self.assertTrue(report["db"]["persistence_failed"])
        self.assertTrue(report["expiry_vetoed"])
        self.assertFalse([c for c in self.db_calls if c[0] == "PATCH"])
        self.assertIn("persistence_failed", report["guard_block_reason"])
        self.assertTrue(engine.ingestion_has_errors(report))

    def test_successful_workday_cohort_writes_but_never_expires(self):
        writer = self.make_writer()
        report = self.run_cohort("workday", writer, self.handler(200), expire=True)
        self.assertEqual(report["failed_sources"], [], report["sources"])
        writer.return_value.sync_jobs_set_diff.assert_awaited_once()
        self.assertEqual([e["status"] for e in report["expiry_reports"]], ["skipped_partial_coverage"])
        self.assertFalse(self.db_calls, "no baseline query and no expiry PATCH for partial-coverage Workday")
        self.assertEqual(report["db"]["expired"], 0)

    def test_full_coverage_expiry_stays_scoped_to_this_cohort(self):
        writer = self.make_writer()
        report = self.run_cohort("non-workday", writer, self.handler(200), expire=True)
        patched = [e["source_id"] for e in report["expiry_reports"] if e["status"] == "completed"]
        self.assertEqual(patched, ["greenhouse:acme"])
        self.assertFalse(any(e["source_id"].startswith("workday:") for e in report["expiry_reports"]))

    def test_drop_guard_still_applies_inside_a_cohort(self):
        report = self.run_cohort("non-workday", self.make_writer(), self.handler(200, baseline=10), expire=True)
        statuses = {e["source_id"]: e["status"] for e in report["expiry_reports"]}
        self.assertEqual(statuses["greenhouse:acme"], "skipped_drop_guard")
        self.assertFalse([c for c in self.db_calls if c[0] == "PATCH"])

    def test_dry_run_reports_projections_not_confirmed_writes(self):
        with patch.dict(os.environ, FAKE_ENV), patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                patch.object(run_ingestion, "fetch_layer1_seed", AsyncMock(return_value=([job("greenhouse:acme")], None))), \
                patch.object(run_ingestion, "enrich_greenhouse_pay_transparency", AsyncMock(return_value=None)), \
                patch.object(run_ingestion, "fetch_jobspy_india", AsyncMock(return_value=([], None))), \
                patch.object(run_ingestion, "fetch_arbeitnow", AsyncMock(return_value=([], None))), \
                patch.object(run_ingestion, "fetch_adzuna", AsyncMock(return_value=([], None))), \
                patch.object(run_ingestion, "SupabaseSetDiffWriter", side_effect=AssertionError("dry run must not write")):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                seeds_path=self.seeds, cohort="non-workday", transport=httpx.MockTransport(self.handler(200))))
        self.assertIsNone(report["persisted_counts"])
        self.assertEqual(report["projected_counts"]["inserted"], 1)
        self.assertIn("dry_run", report["guard_block_reason"])
        s = ingest_report.cohort_summary(report, 0, "non-workday")
        self.assertIsNone(s["confirmed_writes"])
        self.assertIn("DRY RUN", ingest_report.render_cohort(s))


class ReportAggregationTests(unittest.TestCase):
    def test_aggregate_is_honest(self):
        ok = {"cohort": "non-workday", "status": "ok"}
        bad = {"cohort": "workday", "status": "failed"}
        self.assertEqual(ingest_report.aggregate([ok, {**bad, "status": "ok"}], ["non-workday", "workday"])[0], "ok")
        self.assertEqual(ingest_report.aggregate([ok, bad], ["non-workday", "workday"])[0], "degraded")
        self.assertEqual(ingest_report.aggregate([ok], ["non-workday", "workday"])[0], "degraded")  # missing != ok
        self.assertEqual(ingest_report.aggregate([], ["non-workday", "workday"])[0], "failed")
        self.assertEqual(ingest_report.aggregate([bad], ["workday"])[0], "failed")

    def test_cohort_summary_missing_report_is_unknown_not_zero(self):
        s = ingest_report.cohort_summary(None, "1", "workday")
        self.assertEqual(s["status"], "no_report")
        self.assertNotIn("fetched", s)
        self.assertIn("not zero", ingest_report.render_cohort(s))

    def test_cli_round_trip_and_exit_codes(self):
        with tempfile.TemporaryDirectory() as d:
            report = {"dry_run": False, "fetched": 3, "selected": 2, "persisted_counts": {"inserted": 1, "updated": 1, "unchanged": 0},
                      "db": {"expired": 0}, "failed_sources": [], "selected_sources": ["a"], "completed_sources": ["a"]}
            Path(d, "r.json").write_text(json.dumps(report), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                ingest_report.main(["cohort", "--cohort", "non-workday", "--report", str(Path(d, "r.json")),
                                    "--exit-code", "0", "--out", str(Path(d, "python-ingest-summary-non-workday.json"))])
                ingest_report.main(["cohort", "--cohort", "workday", "--report", str(Path(d, "missing.json")),
                                    "--exit-code", "1", "--out", str(Path(d, "python-ingest-summary-workday.json"))])
                self.assertEqual(ingest_report.main(["aggregate", "--dir", d, "--expect", "non-workday"]), 0)
                self.assertEqual(ingest_report.main(["aggregate", "--dir", d, "--expect", "non-workday,workday"]), 1)
            s = json.loads(Path(d, "python-ingest-summary-non-workday.json").read_text(encoding="utf-8"))
            self.assertEqual(s["confirmed_writes"], {"inserted": 1, "updated": 1, "unchanged": 0, "expired": 0})


class WorkdayPacingTests(unittest.TestCase):
    def test_tenant_spacing_default_and_clamping(self):
        from scripts.scraper import fetchers
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(fetchers.get_workday_tenant_spacing_seconds(), 60.0)
        with patch.dict(os.environ, {"WORKDAY_TENANT_SPACING_SECONDS": "90"}):
            self.assertEqual(fetchers.get_workday_tenant_spacing_seconds(), 90.0)
        with patch.dict(os.environ, {"WORKDAY_TENANT_SPACING_SECONDS": "20"}):
            self.assertEqual(fetchers.get_workday_tenant_spacing_seconds(), 60.0, "clamped to min 60s")
        with patch.dict(os.environ, {"WORKDAY_TENANT_SPACING_SECONDS": "200"}):
            self.assertEqual(fetchers.get_workday_tenant_spacing_seconds(), 120.0, "clamped to max 120s")

    def test_parse_retry_after_seconds_and_http_date(self):
        from datetime import datetime, timezone
        from scripts.scraper import rate_limiter
        # Seconds
        self.assertEqual(rate_limiter.parse_retry_after("45"), 45.0)
        self.assertEqual(rate_limiter.parse_retry_after("150"), 150.0, "longer delay is not shortened")

        # HTTP-date
        future = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() + 80, timezone.utc)
        date_str = future.strftime("%a, %d %b %Y %H:%M:%S GMT")
        parsed = rate_limiter.parse_retry_after(date_str)
        self.assertGreaterEqual(parsed, 75.0)
        self.assertLessEqual(parsed, 85.0)

    def test_workday_cooldown_exceeding_page_budget_raises(self):
        from scripts.scraper import fetchers
        limiter = rate_limiter.PerHostRateLimiter(default_rps=4.0)

        def mock_handle(req: httpx.Request):
            return httpx.Response(429, headers={"Retry-After": "45"})

        transport = httpx.MockTransport(mock_handle)
        async def run():
            async with httpx.AsyncClient(transport=transport) as client:
                await fetchers._workday_post(
                    client, limiter, "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/jobs", {}, {}
                )

        with self.assertRaises(fetchers.WorkdayRateLimited):
            asyncio.run(run())


class LogoContractTests(unittest.TestCase):
    def test_existing_logo_is_not_modified_by_sync_companies(self):
        writer = engine.SupabaseSetDiffWriter(
            supabase_url="https://fake.supabase.co",
            service_key="fake-key",
        )
        fake_company = {
            "id": "comp-123",
            "slug": "acme",
            "name": "Acme Inc",
            "logo_url": "https://held.logo/original.png",
            "canonical_domain": "acme.com",
            "category": "MNC_BIGTECH",
            "ats_type": "workday",
        }

        patch_calls: list[dict[str, Any]] = []
        rpc_calls: list[dict[str, Any]] = []

        def mock_handle(req: httpx.Request):
            if req.method == "GET" and "/companies" in str(req.url):
                return httpx.Response(200, json=[fake_company])
            if req.method == "PATCH" and "/companies" in str(req.url):
                patch_calls.append(json.loads(req.content.decode("utf-8")))
                return httpx.Response(200, json=[])
            if req.method == "POST" and "/rpc/enqueue_company_logos" in str(req.url):
                rpc_calls.append(json.loads(req.content.decode("utf-8")))
                return httpx.Response(200, json=1)
            if req.method == "POST" and "/rpc/company_logo_coverage" in str(req.url):
                return httpx.Response(200, json={"coverage": 1.0})
            return httpx.Response(404)

        transport = httpx.MockTransport(mock_handle)
        async def run():
            async with httpx.AsyncClient(transport=transport) as client:
                jobs = [{
                    "company_slug": "acme",
                    "company": "Acme Inc",
                    "canonical_domain": "acme.com",
                    "company_category": "MNC_BIGTECH",
                    "logo_url": "https://new.aggregator/logo.png",
                    "source": "greenhouse",
                    "source_priority": 1,
                }]
                await writer.sync_companies(client, jobs)

        asyncio.run(run())
        self.assertFalse(writer.persistence_failed)
        # Verify no logo_url was patched on existing company
        for p in patch_calls:
            self.assertNotIn("logo_url", p, "existing company logo must NEVER be updated by sync_companies")
        # Verify enqueue_company_logos RPC was invoked
        self.assertEqual(len(rpc_calls), 1)
        self.assertEqual(rpc_calls[0]["p_ids"], ["comp-123"])


if __name__ == "__main__":
    unittest.main()
