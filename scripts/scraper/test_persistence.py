"""Persistence validator + writer isolation tests (ITEM B). Offline only: every HTTP call is mocked."""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from scripts.scraper import engine, fetchers, ingest_report, persistence, run_ingestion
from scripts.scraper.fetch_aggregators_and_india import normalize_aggregator_job
from scripts.scraper.persistence import ALLOWED, normalize_salary_period, prevalidate_jobs, validate_job_row

FAKE_URL = "https://unit-test-project.supabase.co"
FAKE_KEY = "fake-service-role-key-for-tests-0123456789"
CHECK_BODY = json.dumps({
    "code": "23514",
    "message": 'new row for relation "jobs" violates check constraint "jobs_salary_period_check"',
    "details": "Failing row contains (SECRET-ROW-VALUE, Prime Air, ...)",
})
SCRAPER_DIR = Path(__file__).resolve().parent

# Exact Amazon row from failed run 45323980814 (shape of amazon.jobs search.json; no salary fields).
PRIME_AIR_ITEM = {
    "id_icims": "2870001", "title": "Sr. Systems Engineer, Prime Air", "job_path": "/en/jobs/2870001/sr-systems-engineer-prime-air",
    "normalized_location": "Seattle, Washington, USA", "country_code": "USA", "job_category": "Systems, Quality, & Security Engineering",
    "posted_date": "November 20, 2026", "description_short": "Prime Air drone delivery systems engineering.",
}


def good_row(n: int = 1, **over) -> dict:
    row = fetchers.build_normalized_job(
        seed={"name": "Acme", "slug": "acme"}, source="greenhouse", source_type="greenhouse",
        source_id="greenhouse:acme", source_job_id=str(n), title="Software Engineer", location="Remote",
        apply_url=f"https://example.com/{n}",
    )
    row.update(over)
    return row


class ValidatorTests(unittest.TestCase):
    def test_salary_period_aliases_canonical_and_nulls(self):
        for raw, want in [("year", "yearly"), ("month", "monthly"), ("hour", "hourly"), (" Year ", "yearly"),
                          ("yearly", "yearly"), ("monthly", "monthly"), ("hourly", "hourly"), (None, None)]:
            with self.subTest(raw=raw):
                self.assertEqual(normalize_salary_period(raw), want)
                self.assertEqual(validate_job_row({"salary_period": raw})[1], [])
        for raw in ("weekly", "daily", "annum", "", 12):
            with self.subTest(raw=raw):
                self.assertTrue(validate_job_row({"salary_period": raw})[1], "unknown period is rejected, not coerced")

    def test_missing_period_is_never_invented(self):
        row = good_row()
        self.assertIsNone(row["salary_period"], "no salary stated -> no period")
        self.assertEqual(good_row(salary_min=None)["salary_period"], None)
        paid = fetchers.build_normalized_job(
            seed={"name": "A", "slug": "a"}, source="x", source_type="lever", source_job_id="1", title="Eng",
            location="NYC", apply_url="https://e.com/1", salary_min=10.0, salary_max=20.0, salary_period="hour")
        self.assertEqual(paid["salary_period"], "hourly")

    def test_every_check_constraint_and_unknowns(self):
        self.assertEqual(validate_job_row(good_row())[1], [])
        bad = {
            "job_type": "fulltime", "remote_eligibility": "global", "remote_scope": "office", "role_category": "ML",
            "seniority": "junior", "source_priority": 3, "source_type": "aggregator", "status": "closed",
        }
        for field, value in bad.items():
            with self.subTest(field=field):
                problems = validate_job_row(good_row(**{field: value}))[1]
                self.assertEqual(len(problems), 1)
                self.assertIn(field, problems[0])
        self.assertTrue(validate_job_row(good_row(source_priority=True))[1], "bool is not a priority")
        for nullable in ("role_category", "source_priority", "source_type", "salary_period"):
            self.assertEqual(validate_job_row(good_row(**{nullable: None}))[1], [], nullable)
        self.assertEqual(validate_job_row({"source_id": "x", "source_job_id": "1"})[1], [], "missing keys use DB defaults")

    def test_list_and_dict_in_constrained_fields_are_rejected_not_raised(self):
        for field in ("status", "job_type", "remote_scope", "remote_eligibility", "role_category", "seniority",
                      "source_type", "source_priority", "salary_period"):
            for bad in ([], {}, ["active"], {"v": "SECRET-VALUE"}, 1.5):
                with self.subTest(field=field, bad=bad):
                    problems = validate_job_row(good_row(**{field: bad}))[1]
                    self.assertEqual(len(problems), 1)
                    self.assertTrue(problems[0].startswith(f"{field}: invalid type"))
                    self.assertNotIn("SECRET", problems[0])
        self.assertTrue(validate_job_row(good_row(source_priority="1"))[1], "a string priority is the wrong shape")
        valid, rejected = prevalidate_jobs([good_row(1), good_row(2, status=[]), good_row(3, job_type={})])
        self.assertEqual([r["source_job_id"] for r in valid], ["1"])
        self.assertEqual(len(rejected), 2)

    def test_reversed_and_non_finite_salary_bounds(self):
        self.assertEqual(validate_job_row(good_row(salary_min=100, salary_max=100))[1], [])
        self.assertIn("salary_min > salary_max", validate_job_row(good_row(salary_min=200, salary_max=100))[1])
        self.assertTrue(validate_job_row(good_row(salary_min=float("nan")))[1])
        self.assertEqual(validate_job_row(good_row(salary_min=None, salary_max=50))[1], [])

    def test_rejections_are_redacted_and_bounded(self):
        valid, rejected = prevalidate_jobs([good_row(1), good_row(2, status="closed", description="x" * 5000)])
        self.assertEqual([r["source_job_id"] for r in valid], ["1"])
        self.assertEqual(rejected[0]["source_key"], "greenhouse:acme/2")
        self.assertNotIn("xxxx", json.dumps(rejected))
        code, reason = persistence.db_error_diagnostic(400, CHECK_BODY)
        self.assertEqual(code, "23514")
        self.assertIn("jobs_salary_period_check", reason)
        self.assertNotIn("SECRET", reason)


class AdapterAuditTests(unittest.TestCase):
    def test_every_adapter_source_type_literal_is_allowed(self):
        found = set()
        for name in ("fetchers.py", "fetch_aggregators_and_india.py"):
            found |= set(re.findall(r'source_type="([a-z_]+)"', (SCRAPER_DIR / name).read_text(encoding="utf-8")))
        found.discard("aggregator")  # signature default only; every caller passes its own vendor
        self.assertEqual(found - ALLOWED["source_type"], set())
        self.assertGreaterEqual(len(found), 10)

    def test_every_adapter_output_passes_live_checks(self):
        titles = ["Software Engineering Intern", "Senior ML Engineer", "Cloud Architect", "Data Analyst",
                  "Account Executive", "Staff Backend Developer (Remote)"]
        rows = []
        for st in ("greenhouse", "lever", "ashby", "smartrecruiters", "workday", "amazon", "microsoft"):
            for i, t in enumerate(titles):
                rows.append(fetchers.build_normalized_job(
                    seed={"name": "Co", "slug": "co"}, source=st, source_type=st, source_job_id=f"{st}{i}",
                    title=t, location="Bengaluru, India" if i % 2 else "Remote", apply_url="https://e.com/x",
                    remote_eligibility=fetchers._greenhouse_remote_eligibility("Remote", True, set()) if st == "greenhouse" else None,
                    source_layer="layer2" if st in ("workday", "amazon", "microsoft") else "layer1"))
        for st, period in (("jobspy", None), ("arbeitnow", None), ("adzuna", None)):
            for i, t in enumerate(titles):
                rows.append(normalize_aggregator_job(
                    raw_company="Infosys", title=t, location="Pune", apply_url="https://e.com/y", source=st,
                    source_type=st, source_job_id=f"{st}{i}", salary_min=500000.0, salary_max=900000.0,
                    currency="INR", salary_period=period))
        gh = fetchers._greenhouse_salary({"pay_input_ranges": [{"min_cents": 5000, "max_cents": 7000, "currency_type": "USD", "title": "hourly"}]})
        rows.append(good_row(99, **gh))
        valid, rejected = prevalidate_jobs(rows)
        self.assertEqual(rejected, [])
        self.assertEqual({r["salary_period"] for r in valid}, {None, "hourly"})
        self.assertEqual({r["job_type"] for r in valid}, {"internship", "full-time"})

    def test_adzuna_response_states_no_period_so_it_stays_null(self):
        from scripts.scraper.fetch_aggregators_and_india import fetch_adzuna
        # Shape of a real Adzuna /jobs/{cc}/search response: salary_min/max (+ salary_is_predicted), no period field.
        item = {"id": "4890001", "title": "Data Analyst", "company": {"display_name": "Acme"},
                "redirect_url": "https://www.adzuna.in/land/ad/4890001", "location": {"display_name": "Bengaluru"},
                "created": "2026-11-23T08:00:00Z", "salary_min": 600000.0, "salary_max": 900000.0,
                "salary_is_predicted": "0", "description": "SQL and dashboards"}

        def handle(req):
            return httpx.Response(200, json={"count": 1, "results": [item]})

        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                return await fetch_adzuna(client, AsyncMock(), app_id="id", app_key="key", countries=("in",), roles=("Data Analyst",))

        jobs, err = asyncio.run(go())
        self.assertIsNone(err)
        self.assertEqual((jobs[0]["salary_min"], jobs[0]["salary_max"]), (600000.0, 900000.0))
        self.assertIsNone(jobs[0]["salary_period"], "period is not stated by Adzuna: never labelled yearly")
        self.assertEqual(validate_job_row(jobs[0])[1], [])

    def test_amazon_prime_air_row_is_persistable(self):
        async def fake_request(*_a, **_k):
            resp = MagicMock()
            resp.json.return_value = {"jobs": [PRIME_AIR_ITEM]}
            return resp

        with patch.object(fetchers, "request_with_backoff", side_effect=fake_request):
            jobs = asyncio.run(fetchers.fetch_amazon_jobs(MagicMock(), AsyncMock(), {"name": "Amazon", "slug": "amazon"}))
        self.assertEqual(len(jobs), 1)
        row = jobs[0]
        self.assertEqual(row["title"], "Sr. Systems Engineer, Prime Air")
        self.assertIsNone(row["salary_period"], "the old default sent 'year' and hit jobs_salary_period_check")
        self.assertEqual(validate_job_row(row)[1], [])


class Recorder:
    """Mock PostgREST: GET /jobs returns `existing`; POST/PATCH follow per-call scripts."""

    def __init__(self, existing=None, post=None, patch_=None):
        self.existing, self.post, self.patch = existing or [], post, patch_
        self.calls: list[tuple[str, object]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, body))
        if request.method == "GET":
            return httpx.Response(200, json=self.existing)
        handler = self.post if request.method == "POST" else self.patch
        return handler(request, body)


def run_writer(rec: Recorder, jobs: list[dict]) -> tuple[dict, engine.SupabaseSetDiffWriter]:
    writer = engine.SupabaseSetDiffWriter(FAKE_URL, FAKE_KEY)

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(rec)) as client:
            return await writer.sync_jobs_set_diff(client, jobs, {})

    return asyncio.run(go()), writer


def ok_insert(_req, body):
    return httpx.Response(201, json=[{"id": f"id-{r['source_job_id']}"} for r in body])


class WriterTests(unittest.TestCase):
    def test_one_invalid_row_among_valid_is_rejected_and_the_rest_persist(self):
        rec = Recorder(post=ok_insert)
        stats, _ = run_writer(rec, [good_row(1), good_row(2, salary_period="weekly", salary_min=1.0), good_row(3)])
        posts = [b for m, b in rec.calls if m == "POST"]
        self.assertEqual([[r["source_job_id"] for r in b] for b in posts], [["1", "3"]])
        self.assertEqual(stats["inserted"], 2)
        self.assertEqual([r["source_key"] for r in stats["rejected"]], ["greenhouse:acme/2"])
        self.assertFalse(stats["persistence_failed"])
        self.assertEqual(sorted(map(tuple, stats["persisted_source_keys"])), [("greenhouse:acme", "1"), ("greenhouse:acme", "3")])

    def test_invalid_update_is_rejected_before_patch(self):
        existing = [{**good_row(1), "id": "ex-1", "title": "Old"}]
        rec = Recorder(existing=existing, patch_=lambda *_: self.fail("invalid update must not be sent"))
        stats, _ = run_writer(rec, [good_row(1, remote_scope="office")])
        self.assertEqual(stats["updated"], 0)
        self.assertEqual(stats["rejected"][0]["stage"], "prevalidation")

    def test_db_23514_on_update_rejects_that_row_and_continues(self):
        existing = [{**good_row(1), "id": "ex-1", "title": "Old"}, {**good_row(2), "id": "ex-2", "title": "Old"}]

        def patch_(req, body):
            if "ex-1" in str(req.url):
                return httpx.Response(400, text=CHECK_BODY)
            return httpx.Response(200, json=[{"id": "ex-2"}])

        stats, _ = run_writer(Recorder(existing=existing, patch_=patch_), [good_row(1), good_row(2)])
        self.assertEqual(stats["updated"], 1)
        self.assertEqual(stats["rejected"][0]["stage"], "update")
        self.assertFalse(stats["persistence_failed"])
        self.assertNotIn("SECRET", json.dumps(stats))

    def test_update_failures_other_than_400_23514_stop_all_writes(self):
        existing = [{**good_row(n), "id": f"ex-{n}", "title": "Old"} for n in (1, 2)]

        def timeout(req, _body):
            raise httpx.ReadTimeout("timed out", request=req)

        cases = (("503+23514", lambda *_: httpx.Response(503, text=CHECK_BODY)),
                 ("500", lambda *_: httpx.Response(500, text="upstream")),
                 ("timeout", timeout))
        for name, patch_ in cases:
            with self.subTest(name):
                rec = Recorder(existing=existing, post=ok_insert, patch_=patch_)
                stats, writer = run_writer(rec, [good_row(1), good_row(2)])
                patches = [c for c in rec.calls if c[0] == "PATCH"]
                self.assertEqual(len(patches), 1, "the first ambiguous/5xx update stops all further writes")
                self.assertTrue(stats["persistence_failed"])
                self.assertEqual(stats["failed_writes"], 1)
                self.assertEqual(stats["updated"], 0)
                self.assertEqual(stats["rejected"], [], "only 400 + 23514 is a definitive row rejection")
                self.assertNotIn("SECRET", json.dumps(stats))

    def test_23514_batch_rejection_is_isolated_row_by_row(self):
        def post(_req, body):
            if len(body) > 1 or body[0]["source_job_id"] == "2":
                return httpx.Response(400, text=CHECK_BODY)
            return ok_insert(_req, body)

        rec = Recorder(post=post)
        stats, writer = run_writer(rec, [good_row(1), good_row(2), good_row(3)])
        self.assertEqual(len([c for c in rec.calls if c[0] == "POST"]), 4, "1 batch + 3 singles, bounded")
        self.assertEqual(stats["inserted"], 2)
        self.assertEqual([(r["source_key"], r["code"]) for r in stats["rejected"]], [("greenhouse:acme/2", "23514")])
        self.assertIn("jobs_salary_period_check", stats["rejected"][0]["reason"])
        self.assertFalse(stats["persistence_failed"])
        self.assertNotIn("SECRET", json.dumps(stats))

    def test_timeout_and_ambiguous_responses_are_never_retried(self):
        def timeout(req, _body):
            raise httpx.ReadTimeout("timed out", request=req)

        for name, post in (("timeout", timeout), ("500", lambda *_: httpx.Response(500, text="upstream")),
                           ("23514-on-5xx", lambda *_: httpx.Response(503, text=CHECK_BODY))):
            with self.subTest(name):
                rec = Recorder(post=post)
                stats, _ = run_writer(rec, [good_row(1), good_row(2)])
                self.assertEqual(len([c for c in rec.calls if c[0] == "POST"]), 1)
                self.assertTrue(stats["persistence_failed"])
                self.assertEqual(stats["inserted"], 0)
                self.assertEqual(stats["persisted_source_keys"], [])
                self.assertNotIn("SECRET", json.dumps(stats))


SEEDS = {"layer1_public_ats": [{"ats": "greenhouse", "slug": "acme", "token": "acme", "name": "Acme"}],
         "layer2_enterprise_json": {"workday_cxs": [{"slug": "nvidia", "name": "NVIDIA", "tenant": "nvidia",
                                                     "wd_cluster": "wd5", "site": "NVIDIAExternalCareerSite"}]}}


class RunTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(SEEDS, tmp)
        tmp.close()
        self.addCleanup(os.unlink, tmp.name)
        self.seeds = tmp.name
        self.patches: list[str] = []

    def run_non_workday(self, rows, *, expire=True, dry_run=False, sync_result=None):
        writer_cls = MagicMock()
        inst = writer_cls.return_value
        inst.persistence_failed, inst.failed_writes, inst.write_errors = False, 0, []
        inst.base_url, inst.headers = f"{FAKE_URL}/rest/v1", {}
        inst.sync_companies = AsyncMock(return_value={})
        inst.sync_jobs_set_diff = AsyncMock(side_effect=lambda _c, jobs, _m: sync_result or {
            "inserted": len(jobs), "updated": 0, "skipped_unchanged": 0, "persisted_ids": [], "rejected": [],
            "persisted_source_keys": [[j["source_id"], j["source_job_id"]] for j in jobs]})

        def handle(req):
            if req.method == "PATCH":
                self.patches.append(str(req.url))
            return httpx.Response(200, headers={"content-range": "0-0/2"}, json=[])

        empty = AsyncMock(return_value=([], None))
        with patch.dict(os.environ, {"NEXT_PUBLIC_SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}), \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                patch.object(run_ingestion, "SupabaseSetDiffWriter", writer_cls), \
                patch.object(run_ingestion, "fetch_layer1_seed", AsyncMock(return_value=(rows, None))), \
                patch.object(run_ingestion, "enrich_greenhouse_pay_transparency", AsyncMock(return_value=None)), \
                patch.object(run_ingestion, "fetch_jobspy_india", empty), \
                patch.object(run_ingestion, "fetch_arbeitnow", empty), \
                patch.object(run_ingestion, "fetch_adzuna", empty):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                seeds_path=self.seeds, dry_run=dry_run, allow_uncapped=not dry_run, no_expire=not expire,
                allow_expire=expire, cohort="non-workday", transport=httpx.MockTransport(handle)))
        return report, inst

    def test_rejected_row_persists_valid_rows_blocks_board_expiry_and_exits_nonzero(self):
        report, writer = self.run_non_workday([good_row(1), good_row(2, job_type="fulltime")])
        sent = writer.sync_jobs_set_diff.await_args.args[1]
        self.assertEqual([j["source_job_id"] for j in sent], ["1"])
        self.assertEqual((report["fetched"], report["validated"], report["rejected_count"], report["selected"]), (2, 1, 1, 1))
        self.assertEqual(report["failed_sources"], [], "a rejected row is not a failed source: valid rows still write")
        self.assertEqual(self.patches, [], "no expiry for a board with unpersisted rows")
        self.assertEqual(report["expiry_reports"][0]["status"], "skipped_incomplete_source")
        self.assertTrue(engine.ingestion_has_errors(report))

        s = ingest_report.cohort_summary(report, 1, "non-workday")
        self.assertEqual((s["status"], s["validated"], s["rejected"], s["failed_writes"]), ("failed", 1, 1, 0))
        text = ingest_report.render_cohort(s)
        self.assertIn("validated / rejected | 1 / 1", text)
        self.assertIn("greenhouse:acme/2", text)
        self.assertTrue(any("row rejected" in a for a in ingest_report.annotations(s)))

    def test_list_or_dict_values_reject_only_that_row(self):
        rows = [good_row(1), good_row(2, status=[]), good_row(3, job_type={}), good_row(4, source_priority=[])]
        report, writer = self.run_non_workday(rows)
        sent = writer.sync_jobs_set_diff.await_args.args[1]
        self.assertEqual([j["source_job_id"] for j in sent], ["1"], "the valid sibling still persists")
        self.assertEqual(report["rejected_count"], 3)
        self.assertEqual(self.patches, [], "board expiry withheld")
        self.assertEqual(report["expiry_reports"][0]["status"], "skipped_incomplete_source")
        self.assertTrue(engine.ingestion_has_errors(report), "cohort result nonzero")
        self.assertTrue(all("invalid type" in r["reason"] for r in report["rejected"]))

    def test_persistence_failure_on_update_vetoes_expiry(self):
        writer_stats = {"inserted": 0, "updated": 0, "skipped_unchanged": 0, "persistence_failed": True, "failed_writes": 1,
                        "write_errors": ["Job update error on ex-1: HTTP 503 code 23514"], "rejected": [], "persisted_source_keys": []}
        report, _ = self.run_non_workday([good_row(1), good_row(2)], sync_result=writer_stats)
        self.assertTrue(report["expiry_vetoed"])
        self.assertEqual(self.patches, [])
        self.assertTrue(engine.ingestion_has_errors(report))

    def test_clean_run_still_expires_and_reports_zero_rejected(self):
        report, _ = self.run_non_workday([good_row(1), good_row(2)])
        self.assertEqual(report["rejected_count"], 0)
        self.assertEqual(report["expiry_reports"][0]["status"], "completed")
        self.assertFalse(engine.ingestion_has_errors(report))

    def test_dry_run_reports_rejections_without_writing(self):
        report, writer = self.run_non_workday([good_row(1, status="closed")], expire=False, dry_run=True)
        writer.sync_jobs_set_diff.assert_not_called()
        self.assertEqual(report["rejected_count"], 1)
        self.assertEqual(report["projected_counts"]["inserted"], 0)


if __name__ == "__main__":
    unittest.main()
