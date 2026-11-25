"""Duplicate apply_url handling and non-finite salary sanitizing (run 45344311709). Offline: all HTTP is mocked."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from scripts.scraper import engine, fetchers, ingest_report, run_ingestion
from scripts.scraper.persistence import sanitize_salaries, validate_job_row

FAKE_URL = "https://unit-test-project.supabase.co"
FAKE_KEY = "fake-service-role-key-for-tests-0123456789"


def body(code: str, constraint: str) -> str:
    return json.dumps({"code": code, "message": f'duplicate key value violates unique constraint "{constraint}"',
                       "details": "Key (apply_url)=(https://SECRET-ROW-VALUE) already exists."})


DUP = body("23505", "jobs_apply_url_unique")


def row(source: str, n: int, url: str | None = None, **over) -> dict:
    r = fetchers.build_normalized_job(
        seed={"name": "Acme", "slug": "acme"}, source=source.split(":")[0], source_type=source.split(":")[0],
        source_id=source, source_job_id=str(n), title="Software Engineer", location="Remote",
        apply_url=url or f"https://example.com/{source}/{n}")
    r.update(over)
    return r


class Db:
    """Mock PostgREST. identity lookups return `existing`; apply_url lookups return rows owning those URLs."""

    def __init__(self, existing=None, url_owners=None, post=None, patch_=None):
        self.existing = existing or []
        self.url_owners = set(url_owners or [])
        self.post, self.patch = post, patch_
        self.calls: list[tuple[str, object]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content) if request.content else None
        self.calls.append((request.method, payload))
        if request.method == "GET":
            apply = request.url.params.get("apply_url")
            if apply:
                return httpx.Response(200, json=[{"id": f"owner-{i}", "apply_url": u}
                                                 for i, u in enumerate(sorted(self.url_owners)) if f'"{u}"' in apply])
            return httpx.Response(200, json=self.existing)
        handler = self.post if request.method == "POST" else self.patch
        return handler(request, payload)

    def posts(self):
        return [b for m, b in self.calls if m == "POST"]


def ok_insert(_req, rows):
    return httpx.Response(201, json=[{"id": f"id-{r['source_id']}-{r['source_job_id']}"} for r in rows])


def write(db: Db, jobs: list[dict]) -> dict:
    writer = engine.SupabaseSetDiffWriter(FAKE_URL, FAKE_KEY)

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(db)) as client:
            return await writer.sync_jobs_set_diff(client, jobs, {})

    return asyncio.run(go())


class DuplicateTests(unittest.TestCase):
    def test_duplicate_apply_url_across_two_sources_is_skipped_never_a_second_row(self):
        shared = "https://jobs.example.com/apply/42"
        db = Db(url_owners=[shared], post=ok_insert)  # greenhouse already owns the URL
        stats = write(db, [row("jobspy:indeed", 1, shared), row("jobspy:indeed", 2)])
        self.assertEqual([[r["source_job_id"] for r in b] for b in db.posts()], [["2"]])
        self.assertEqual(stats["inserted"], 1)
        self.assertEqual([d["source_key"] for d in stats["duplicate_skipped"]], ["jobspy:indeed/1"])
        self.assertFalse(stats["persistence_failed"])
        self.assertNotIn("SECRET", json.dumps(stats))

    def test_duplicate_within_one_batch_keeps_the_first(self):
        shared = "https://jobs.example.com/apply/7"
        db = Db(post=ok_insert)
        stats = write(db, [row("greenhouse:acme", 1, shared), row("lever:acme", 9, shared), row("lever:acme", 10)])
        sent = [r["source_id"] + "/" + r["source_job_id"] for b in db.posts() for r in b]
        self.assertEqual(len(sent), 2)
        self.assertEqual(sum(1 for r in db.posts()[0] if r["apply_url"] == shared), 1)
        self.assertEqual(len(stats["duplicate_skipped"]), 1)
        self.assertFalse(stats["persistence_failed"])

    def test_db_23505_on_a_batch_isolates_the_duplicate_and_valid_siblings_persist(self):
        racing = "https://jobs.example.com/apply/race"  # claimed by another writer after our lookup
        for status in (409, 400):
            with self.subTest(status=status):
                def post(_req, rows):
                    if any(r["apply_url"] == racing for r in rows):
                        return httpx.Response(status, text=DUP)
                    return ok_insert(_req, rows)

                db = Db(post=post)
                stats = write(db, [row("greenhouse:acme", 1), row("greenhouse:acme", 2, racing), row("greenhouse:acme", 3)])
                self.assertEqual(len(db.posts()), 4, "1 batch + 3 singles, bounded")
                self.assertEqual(stats["inserted"], 2)
                self.assertEqual([(d["source_key"], d["code"]) for d in stats["duplicate_skipped"]], [("greenhouse:acme/2", "23505")])
                self.assertIn("jobs_apply_url_unique", stats["duplicate_skipped"][0]["reason"])
                self.assertFalse(stats["persistence_failed"])
                self.assertEqual(sorted(map(tuple, stats["persisted_source_keys"])), [("greenhouse:acme", "1"), ("greenhouse:acme", "3")])
                self.assertNotIn("SECRET", json.dumps(stats))

    def test_unknown_409_or_other_unique_constraint_still_stops_writes(self):
        cases = {
            "409 other constraint": lambda *_: httpx.Response(409, text=body("23505", "idx_jobs_source_id_source_job_id_uniq")),
            "409 no code": lambda *_: httpx.Response(409, text="conflict"),
            "503 with 23505 body": lambda *_: httpx.Response(503, text=DUP),
        }
        for name, post in cases.items():
            with self.subTest(name):
                db = Db(post=post)
                stats = write(db, [row("greenhouse:acme", n) for n in (1, 2, 3)])
                self.assertEqual(len(db.posts()), 1, "no isolation retries for an unknown conflict")
                self.assertTrue(stats["persistence_failed"])
                self.assertEqual(stats["duplicate_skipped"], [])
                self.assertEqual(stats["inserted"], 0)

    def test_update_hitting_apply_url_unique_is_skipped_and_writes_continue(self):
        existing = [{**row("greenhouse:acme", n), "id": f"ex-{n}", "title": "Old"} for n in (1, 2)]

        def patch_(req, _payload):
            if "ex-1" in str(req.url):
                return httpx.Response(409, text=DUP)
            return httpx.Response(200, json=[{"id": "ex-2"}])

        db = Db(existing=existing, patch_=patch_)
        stats = write(db, [row("greenhouse:acme", 1), row("greenhouse:acme", 2)])
        self.assertEqual(stats["updated"], 1)
        self.assertEqual(stats["duplicate_skipped"][0]["stage"], "update")
        self.assertFalse(stats["persistence_failed"])

    def test_failed_apply_url_lookup_stops_before_any_write(self):
        def handle(request):
            if request.method == "GET" and request.url.params.get("apply_url"):
                return httpx.Response(503)
            if request.method == "GET":
                return httpx.Response(200, json=[])
            raise AssertionError("no write after a failed lookup")

        writer = engine.SupabaseSetDiffWriter(FAKE_URL, FAKE_KEY)

        async def go():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
                return await writer.sync_jobs_set_diff(client, [row("greenhouse:acme", 1)], {})

        stats = asyncio.run(go())
        self.assertTrue(stats["persistence_failed"])


CHECK = json.dumps({"code": "23514", "message": 'new row for relation "jobs" violates check constraint "jobs_x_check"'})


def first_candidate_fails(status: int, text: str):
    """POST handler: any batch containing greenhouse:acme/1 fails with (status, text); everything else inserts."""
    def post(_req, rows):
        if any(r["source_id"] == "greenhouse:acme" and r["source_job_id"] == "1" for r in rows):
            return httpx.Response(status, text=text)
        return ok_insert(_req, rows)
    return post


class ClaimAfterConfirmTests(unittest.TestCase):
    """A URL is claimed only after a confirmed insert: a rejected first candidate never blocks the next one."""

    shared = "https://jobs.example.com/apply/shared"

    def owners(self, db: Db) -> list[str]:
        return [f"{r['source_id']}/{r['source_job_id']}" for b in db.posts() for r in b if r["apply_url"] == self.shared]

    def assert_second_owns_url(self, db: Db, stats: dict, second: str):
        self.assertEqual([r["source_key"] for r in stats["rejected"]], ["greenhouse:acme/1"])
        self.assertEqual(stats["duplicate_skipped"], [], "the valid second candidate is not a duplicate")
        self.assertIn(tuple(second.split("/")), set(map(tuple, stats["inserted_source_keys"])), "exactly one row owns the URL")
        self.assertFalse(stats["persistence_failed"])

    def test_rejected_first_candidate_then_valid_second_in_the_same_batch(self):
        db = Db(post=first_candidate_fails(400, CHECK))
        stats = write(db, [row("greenhouse:acme", 1, self.shared), row("lever:acme", 9, self.shared), row("lever:acme", 10)])
        self.assert_second_owns_url(db, stats, "lever:acme/9")
        self.assertEqual(stats["inserted"], 2)

    def test_rejected_first_candidate_then_valid_second_across_the_50_row_boundary(self):
        filler = [row("lever:acme", 100 + n) for n in range(49)]
        jobs = filler + [row("greenhouse:acme", 1, self.shared), row("ashby:acme", 7, self.shared)]  # index 49 | 50
        db = Db(post=first_candidate_fails(400, CHECK))
        stats = write(db, jobs)
        self.assert_second_owns_url(db, stats, "ashby:acme/7")
        self.assertEqual(stats["inserted"], 50)

    def test_confirmed_first_candidate_makes_the_later_one_a_duplicate_across_the_boundary(self):
        filler = [row("lever:acme", 100 + n) for n in range(49)]
        jobs = filler + [row("greenhouse:acme", 1, self.shared), row("ashby:acme", 7, self.shared)]
        db = Db(post=ok_insert)
        stats = write(db, jobs)
        self.assertEqual(self.owners(db), ["greenhouse:acme/1"])
        self.assertEqual([d["source_key"] for d in stats["duplicate_skipped"]], ["ashby:acme/7"])
        self.assertEqual(stats["rejected"], [])

    def test_duplicate_skipped_first_candidate_lets_the_second_meet_the_same_db_owner(self):
        # first candidate hits 409/23505 (URL taken by a racing writer): the second also gets 23505, never a 2nd row
        db = Db(post=lambda _r, rows: httpx.Response(409, text=DUP) if any(r["apply_url"] == self.shared for r in rows) else ok_insert(_r, rows))
        stats = write(db, [row("greenhouse:acme", 1, self.shared), row("lever:acme", 9, self.shared)])
        self.assertEqual(len(stats["duplicate_skipped"]), 2)
        self.assertEqual(stats["inserted"], 0)
        self.assertFalse(stats["persistence_failed"])

    def test_ambiguous_failure_of_the_first_candidate_stops_before_the_next(self):
        for name, post in (("503", first_candidate_fails(503, "upstream")),
                           ("unknown 409", first_candidate_fails(409, "conflict"))):
            with self.subTest(name):
                db = Db(post=post)
                stats = write(db, [row("greenhouse:acme", 1, self.shared), row("lever:acme", 9, self.shared)])
                self.assertEqual(len(db.posts()), 1, "no further write after an ambiguous failure")
                self.assertTrue(stats["persistence_failed"])
                self.assertEqual(stats["duplicate_skipped"], [])


class SalaryTests(unittest.TestCase):
    def test_non_finite_salary_becomes_null_and_the_job_is_kept(self):
        jobs = [row("jobspy:indeed", n, salary_min=lo, salary_max=hi, salary_period="yearly", currency="INR")
                for n, (lo, hi) in enumerate([(float("nan"), float("nan")), (float("inf"), 5.0), (1.0, float("-inf")),
                                              ("nan", None), (None, "Infinity"), (100.0, 200.0), (None, None)])]
        out, sanitized = sanitize_salaries(jobs)
        self.assertEqual(len(out), len(jobs), "never drops a job")
        self.assertEqual(len(sanitized), 5)
        for job in out[:5]:
            self.assertEqual((job["salary_min"], job["salary_max"], job["salary_period"]), (None, None, None))
            self.assertEqual(validate_job_row(job)[1], [])
        self.assertEqual((out[5]["salary_min"], out[5]["salary_max"], out[5]["salary_period"]), (100.0, 200.0, "yearly"))
        self.assertIn("salary_min > salary_max", validate_job_row({**out[5], "salary_min": 300.0})[1], "min<=max still applies")
        self.assertTrue(validate_job_row({**out[5], "salary_min": "100"})[1], "a numeric string is still the wrong shape")


SEEDS = {"layer1_public_ats": [{"ats": "greenhouse", "slug": "acme", "token": "acme", "name": "Acme"}],
         "layer2_enterprise_json": {}}


class RunTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(SEEDS, tmp)
        tmp.close()
        self.addCleanup(os.unlink, tmp.name)
        self.seeds = tmp.name
        self.patches: list[str] = []

    def run_cohort(self, gh_rows, jobspy_rows, duplicates_for=()):
        # JobSpy is only a carrier for an aggregator-shaped board here: the source-policy blocklist is emptied so it is
        # scheduled (policy itself: test_jobspy_policy.py).
        writer_cls = MagicMock()
        inst = writer_cls.return_value
        inst.persistence_failed, inst.failed_writes, inst.write_errors = False, 0, []
        inst.base_url, inst.headers = f"{FAKE_URL}/rest/v1", {}
        inst.sync_companies = AsyncMock(return_value={})

        def sync(_c, jobs, _m):
            dup = [j for j in jobs if j["source_job_id"] in duplicates_for]
            keep = [j for j in jobs if j not in dup]
            keys = [[j["source_id"], j["source_job_id"]] for j in keep]
            return {"inserted": len(keep), "updated": 0, "skipped_unchanged": 0, "persisted_ids": [], "rejected": [],
                    "persisted_source_keys": keys, "inserted_source_keys": keys, "updated_source_keys": [],
                    "duplicate_skipped": [{"source_id": j["source_id"], "source_key": f"{j['source_id']}/{j['source_job_id']}",
                                           "stage": "prelookup", "code": None, "reason": "apply_url already owned"} for j in dup]}

        inst.sync_jobs_set_diff = AsyncMock(side_effect=sync)

        def handle(req):
            if req.method == "PATCH":
                self.patches.append(str(req.url))
            return httpx.Response(200, headers={"content-range": "0-0/2"}, json=[])

        empty = AsyncMock(return_value=([], None))
        with patch.dict(os.environ, {"NEXT_PUBLIC_SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}), \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                patch.object(run_ingestion, "SupabaseSetDiffWriter", writer_cls), \
                patch.object(run_ingestion, "fetch_layer1_seed", AsyncMock(return_value=(gh_rows, None))), \
                patch.object(run_ingestion, "enrich_greenhouse_pay_transparency", AsyncMock(return_value=None)), \
                patch.object(run_ingestion, "fetch_jobspy_india", AsyncMock(return_value=(jobspy_rows, None))),                 patch.object(run_ingestion.aggregators_mod, "BLOCKED_JOBSPY_SITES", frozenset()), \
                patch.object(run_ingestion, "fetch_arbeitnow", empty), \
                patch.object(run_ingestion, "fetch_adzuna", empty):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                seeds_path=self.seeds, dry_run=False, allow_uncapped=True, no_expire=False, allow_expire=True,
                cohort="non-workday", transport=httpx.MockTransport(handle)))
        return report, inst

    def test_nan_salary_rows_are_written_with_null_salary_not_rejected(self):
        nan_rows = [row("jobspy:indeed", n, salary_min=float("nan"), salary_max=float("nan"), salary_period="yearly")
                    for n in range(3)]
        report, writer = self.run_cohort([row("greenhouse:acme", 1)], nan_rows)
        sent = writer.sync_jobs_set_diff.await_args.args[1]
        self.assertEqual(len(sent), 4)
        self.assertTrue(all(j["salary_min"] is None and j["salary_period"] is None for j in sent if j["source_type"] == "jobspy"))
        self.assertEqual((report["rejected_count"], report["salary_sanitized_count"]), (0, 3))
        self.assertFalse(engine.ingestion_has_errors(report))
        jobspy = next(s for s in report["sources"] if s["source"] == "jobspy:india")
        self.assertEqual((jobspy["salary_sanitized"], jobspy["rejected"], jobspy["inserted"]), (3, 0, 3))

    def test_duplicates_alone_are_not_a_failure_but_withhold_that_boards_expiry(self):
        report, _ = self.run_cohort([row("greenhouse:acme", 1), row("greenhouse:acme", 2)], [], duplicates_for={"2"})
        self.assertEqual(report["duplicate_skipped_count"], 1)
        self.assertFalse(engine.ingestion_has_errors(report), "duplicates alone exit 0")
        self.assertEqual(run_ingestion.exit_code_for(report), 0)
        self.assertEqual(self.patches, [], "the board's live job sits on another row: no expiry on its behalf")
        gh = next(s for s in report["sources"] if s["source"] == "greenhouse:acme")
        self.assertEqual((gh["fetched"], gh["duplicate_skipped"], gh["inserted"], gh["failed"], gh["expired"]), (2, 1, 1, 0, 0))
        s = ingest_report.cohort_summary(report, 0, "non-workday")
        self.assertEqual((s["status"], s["duplicate_skipped"], s["salary_sanitized"]), ("ok", 1, 0))
        text = ingest_report.render_cohort(s)
        self.assertIn("duplicate apply_url skipped (existing job kept; not a failure) | 1", text)
        self.assertIn("| greenhouse:acme | ok | 2 | 2 | 0 | 0 | 1 | 1 | 0 | 0 | 0 |", text)

    def test_clean_board_still_expires(self):
        report, _ = self.run_cohort([row("greenhouse:acme", 1), row("greenhouse:acme", 2)], [])
        self.assertEqual(report["expiry_reports"][0]["status"], "completed")


if __name__ == "__main__":
    unittest.main()
