"""Workday per-board isolation, persistent cooldown and rotation (ITEM C). Offline only: all HTTP is mocked."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from scripts.scraper import engine, fetchers, ingest_report, rate_limiter, run_ingestion, workday_schedule

FAKE_HOST = "unit-test-project.supabase.co"
FAKE_ENV = {"NEXT_PUBLIC_SUPABASE_URL": f"https://{FAKE_HOST}", "SUPABASE_SERVICE_ROLE_KEY": "fake-service-role-key-for-tests-0123456789"}
BOARDS = ["a", "b", "c"]
SEEDS = {
    "layer1_public_ats": [{"ats": "greenhouse", "slug": "acme", "token": "acme", "name": "Acme"}],
    "layer2_enterprise_json": {"workday_cxs": [
        {"slug": s, "name": s.upper(), "tenant": f"t{s}", "wd_cluster": "wd5", "site": "Ext"} for s in BOARDS]},
}
POSTING = {"title": "GPU Engineer", "externalPath": "/job/x/GPU_JR1", "locationsText": "Santa Clara, CA", "bulletFields": ["JR1"]}
LIM = workday_schedule.limits()


def ok_page(_req):
    return httpx.Response(200, json={"total": 1, "jobPostings": [POSTING]})


class Base(unittest.TestCase):
    def setUp(self):
        fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
        fetchers._WORKDAY_TENANT_NEXT.clear()
        fetchers._WORKDAY_LAST_TENANT_START = 0.0
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.seeds = self.dir / "seeds.json"
        self.seeds.write_text(json.dumps(SEEDS), encoding="utf-8")
        self.state = self.dir / "state" / "workday.json"
        self.requests: list[str] = []
        self.db_calls: list[tuple[str, str]] = []

    def write_state(self, boards: dict) -> None:
        workday_schedule.save_state(str(self.state), boards)

    def seed_state_all_ok(self, **over) -> None:
        """Valid state where every board is eligible (never a cold start)."""
        boards = {f"workday:{s}": {"consecutive_failures": 0, "last_success_at": None} for s in BOARDS}
        boards.update(over)
        self.write_state(boards)

    def make_writer(self, *, persistence_failed: bool = False):
        writer_cls = MagicMock(name="SupabaseSetDiffWriter")
        inst = writer_cls.return_value
        inst.persistence_failed, inst.failed_writes, inst.write_errors = False, 0, []
        inst.base_url, inst.headers = f"https://{FAKE_HOST}/rest/v1", {}
        inst.sync_companies = AsyncMock(return_value={})

        async def sync_jobs(_client, jobs, _map):
            keys = [[j["source_id"], j["source_job_id"]] for j in jobs]
            if persistence_failed:  # ambiguous write: nothing confirmed
                return {"inserted": 0, "updated": 0, "skipped_unchanged": 0, "persistence_failed": True,
                        "write_errors": ["Job insert exception: ReadTimeout"], "persisted_source_keys": [], "rejected": []}
            return {"inserted": len(jobs), "updated": 0, "skipped_unchanged": 0, "persisted_ids": [], "rejected": [],
                    "persisted_source_keys": keys, "inserted_source_keys": keys, "updated_source_keys": []}

        inst.sync_jobs_set_diff = AsyncMock(side_effect=sync_jobs)
        return writer_cls

    def ingest(self, boards: dict, writer_cls=None, *, cohort="workday", expire=True, greenhouse_error=None, env=None,
               dry_run=False):
        """boards: tenant letter -> handler(request) for that Workday tenant."""
        def handle(request: httpx.Request) -> httpx.Response:
            if request.url.host == FAKE_HOST:
                self.db_calls.append((request.method, request.url.path))
                return httpx.Response(200, headers={"content-range": "0-0/1"}, json=[])
            if "myworkdayjobs.com" in request.url.host:
                tenant = request.url.host.split(".")[0][1:]
                self.requests.append(tenant)
                return boards[tenant](request)
            return httpx.Response(404)

        async def no_sleep(_s: float) -> None:
            return None

        writer_cls = writer_cls or self.make_writer()
        gh = AsyncMock(return_value=([{"source_id": "greenhouse:acme", "source_type": "greenhouse", "source_job_id": "1",
                                      "title": "Eng", "company": "Acme", "apply_url": "https://e.com/1"}], greenhouse_error))
        empty = AsyncMock(return_value=([], None))
        full_env = {**FAKE_ENV, "WORKDAY_STATE_PATH": str(self.state), **(env or {})}
        with patch.dict(os.environ, full_env), \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                patch.object(run_ingestion, "SupabaseSetDiffWriter", writer_cls), \
                patch.object(run_ingestion, "fetch_layer1_seed", gh), \
                patch.object(run_ingestion, "enrich_greenhouse_pay_transparency", AsyncMock(return_value=None)), \
                patch.object(run_ingestion, "fetch_jobspy_india", empty), \
                patch.object(run_ingestion, "fetch_arbeitnow", empty), \
                patch.object(run_ingestion, "fetch_adzuna", empty), \
                patch.object(rate_limiter.asyncio, "sleep", no_sleep):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                seeds_path=self.seeds, dry_run=dry_run, allow_uncapped=not dry_run, no_expire=not expire or dry_run,
                allow_expire=expire and not dry_run,
                cohort=cohort, sources=None, transport=httpx.MockTransport(handle)))
        return report, writer_cls.return_value

    def saved(self) -> dict:
        return json.loads(self.state.read_text(encoding="utf-8"))["sources"]


class IsolationTests(Base):
    def test_independent_board_writes_and_zero_workday_expiry(self):
        self.seed_state_all_ok()
        report, writer = self.ingest({"a": ok_page, "b": lambda r: httpx.Response(500), "c": ok_page})
        sent = writer.sync_jobs_set_diff.await_args.args[1]
        self.assertEqual(sorted({j["source_id"] for j in sent}), ["workday:ta:Ext", "workday:tc:Ext"], "failed board b wrote nothing")
        self.assertEqual([f["source"] for f in report["failed_sources"]], ["workday:b"])
        self.assertIn("workday_isolated", report["guard_block_reason"])
        self.assertTrue(engine.ingestion_has_errors(report), "a failed selected board keeps the cohort nonzero")
        self.assertEqual({e["status"] for e in report["expiry_reports"]}, {"skipped_partial_coverage", "skipped_incomplete_source"})
        self.assertFalse([c for c in self.db_calls if c[0] == "PATCH"], "Workday never expires, even completed boards")
        self.assertEqual(report["db"]["expired"], 0)
        by = {s["source"]: s for s in report["sources"]}
        self.assertEqual((by["workday:a"]["fetched"], by["workday:a"]["inserted"], by["workday:a"]["updated"]), (1, 1, 0))
        self.assertEqual(by["workday:b"]["inserted"], 0)
        state = self.saved()
        self.assertIsNotNone(state["workday:a"]["last_success_at"])
        self.assertIsNone(state["workday:b"]["last_success_at"])
        self.assertEqual(state["workday:b"]["consecutive_failures"], 1)
        self.assertEqual(report["workday"]["completed"], 2)
        self.assertEqual(report["workday"]["failed"], 1)

    def test_all_tenants_blocked_stops_after_streak_and_persists_only_their_own_cooldown(self):
        self.seed_state_all_ok()
        before = datetime.now(timezone.utc)
        report, writer = self.ingest({s: (lambda r: httpx.Response(429, headers={"Retry-After": "90000"})) for s in BOARDS})
        streak = fetchers.WORKDAY_RATE_LIMITED_STREAK_STOP
        self.assertEqual(self.requests, BOARDS[:streak], "one request per blocked tenant, then the run stops")
        self.assertEqual([f["source"] for f in report["failed_sources"]], [f"workday:{s}" for s in BOARDS[:streak]])
        self.assertEqual([d["source"] for d in report["deferred_sources"]], [f"workday:{s}" for s in BOARDS[streak:]])
        self.assertIn("in a row rate-limited", report["deferred_sources"][0]["reason"])
        writer.sync_jobs_set_diff.assert_not_called()
        self.assertIn("write_withheld", report["guard_block_reason"])
        self.assertTrue(engine.ingestion_has_errors(report), "429 is degraded, never successful-empty")
        state = self.saved()
        for s in BOARDS[:streak]:
            nxt = datetime.fromisoformat(state[f"workday:{s}"]["next_eligible_at"])
            self.assertGreaterEqual(nxt, before + timedelta(seconds=90000), "Retry-After honoured across runs")
            self.assertEqual(state[f"workday:{s}"]["last_reason"], "rate_limited")
        self.assertIsNone(state["workday:c"].get("next_eligible_at"), "c is not cooled down by other tenants' 429s")

        # The next run (new process) defers the blocked tenants and still fetches the untouched one.
        self.requests.clear()
        fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
        report2, _ = self.ingest({s: ok_page for s in BOARDS})
        self.assertEqual(self.requests, ["c"])
        self.assertEqual(sorted(d["source"] for d in report2["deferred_sources"]), ["workday:a", "workday:b"])
        self.assertEqual(report2["failed_sources"], [])

    def test_partial_pagination_and_malformed_pages_write_nothing(self):
        calls = {"n": 0}

        def two_pages(_req):
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx.Response(200, json={"jobPostings": [dict(POSTING, bulletFields=[f"R{i}"]) for i in range(20)]})
            return httpx.Response(500)

        async def go(handler, pages):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                return await fetchers.fetch_workday_cxs(client, rate_limiter.PerHostRateLimiter(1000.0, 1000.0),
                                                        SEEDS["layer2_enterprise_json"]["workday_cxs"][0], max_pages=pages, polite_delay=0.0)

        async def no_sleep(_s):
            return None

        with patch.object(fetchers.asyncio, "sleep", no_sleep):
            with self.assertRaises(httpx.HTTPStatusError):
                asyncio.run(go(two_pages, 2))  # page 2 fails -> page 1's 20 rows are never returned
            for body in ({"total": 0}, {"jobPostings": None}, ["not", "a", "dict"]):
                with self.subTest(body=body), self.assertRaises(RuntimeError):
                    asyncio.run(go(lambda r, b=body: httpx.Response(200, json=b), 1))

    def test_all_selected_boards_failed_writes_nothing(self):
        self.seed_state_all_ok()
        report, writer = self.ingest({s: (lambda r: httpx.Response(500)) for s in BOARDS})
        writer.sync_companies.assert_not_called()
        writer.sync_jobs_set_diff.assert_not_called()
        self.assertEqual(len(report["failed_sources"]), 3)
        self.assertIn("write_withheld: all 3", report["guard_block_reason"])
        s = ingest_report.cohort_summary(report, 1, "workday")
        self.assertEqual(s["status"], "failed")
        self.assertIn("workday selected / attempted / completed / failed / deferred | 3 / 3 / 0 / 3 / 0", ingest_report.render_cohort(s))

    def test_ambiguous_write_never_records_last_success(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({s: ok_page for s in BOARDS}, self.make_writer(persistence_failed=True))
        self.assertTrue(report["db"]["persistence_failed"])
        self.assertTrue(engine.ingestion_has_errors(report))
        state = self.saved()
        self.assertTrue(all(v["last_success_at"] is None for v in state.values()))
        now = datetime.now(timezone.utc)
        self.assertTrue(all(v.get("next_eligible_at") is None or datetime.fromisoformat(v["next_eligible_at"]) <= now
                            for v in state.values()), "fetched-but-unpersisted boards stay eligible for the next run")
        self.assertFalse([c for c in self.db_calls if c[0] == "PATCH"])

    def test_non_workday_guard_is_unchanged_in_a_mixed_run(self):
        self.seed_state_all_ok()
        report, writer = self.ingest({s: ok_page for s in BOARDS}, cohort=None, greenhouse_error="HTTP 503")
        writer.sync_jobs_set_diff.assert_not_called()
        self.assertIn("write_withheld", report["guard_block_reason"])


class RotationAndStateTests(Base):
    def test_rotation_is_fair_and_capped(self):
        old = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
        older = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
        self.seed_state_all_ok(**{
            "workday:a": {"consecutive_failures": 0, "last_success_at": None, "last_attempt_at": old},
            "workday:b": {"consecutive_failures": 0, "last_success_at": None, "last_attempt_at": older},
        })
        handlers = {s: ok_page for s in BOARDS}
        r1, _ = self.ingest(handlers, env={"WORKDAY_MAX_BOARDS_PER_RUN": "1"})
        self.assertEqual(self.requests, ["c"], "never-attempted first")
        self.assertEqual({d["reason"] for d in r1["deferred_sources"]}, {"rotation (per-run cap)"})
        self.requests.clear()
        self.ingest(handlers, env={"WORKDAY_MAX_BOARDS_PER_RUN": "1"})
        self.assertEqual(self.requests, ["b"], "then the least recently attempted")

    def test_missing_or_corrupt_state_is_a_conservative_cold_start(self):
        for label, prepare in (("missing", lambda: None), ("corrupt", lambda: self.state.write_text("{not json", encoding="utf-8")),
                               ("bad-entry", lambda: self.write_state({"workday:a": {"next_eligible_at": "tomorrow"}}))):
            with self.subTest(label):
                if self.state.exists():
                    self.state.unlink()
                prepare()
                self.requests.clear()
                report, _ = self.ingest({s: ok_page for s in BOARDS})
                self.assertEqual(len(self.requests), 1, "no burst without trustworthy state")
                self.assertIn(report["workday"]["state_status"], ("missing", "corrupt"))
                self.assertEqual(sum(1 for d in report["deferred_sources"] if d["reason"].startswith("cold start")), 2)

    def test_duplicate_trigger_sends_nothing(self):
        self.seed_state_all_ok()
        handlers = {s: ok_page for s in BOARDS}
        self.ingest(handlers)
        self.assertEqual(sorted(self.requests), BOARDS)
        self.requests.clear()
        report, _ = self.ingest(handlers)
        self.assertEqual(self.requests, [], "boards completed moments ago are not eligible again")
        self.assertEqual(len(report["deferred_sources"]), 3)
        self.assert_noop(report)

    def assert_noop(self, report):
        """All deferred, nothing written: never a green 'success' that the watchdog would count as fresh."""
        self.assertEqual(report["outcome"], "noop_deferred")
        self.assertIn("noop_deferred", report["guard_block_reason"])
        self.assertEqual(report["workday"]["persisted"], 0)
        self.assertEqual(run_ingestion.exit_code_for(report), run_ingestion.NOOP_EXIT_CODE)
        self.assertNotEqual(run_ingestion.NOOP_EXIT_CODE, 0)
        s = ingest_report.cohort_summary(report, run_ingestion.NOOP_EXIT_CODE, "workday")
        self.assertEqual(s["status"], "deferred_noop")
        self.assertEqual(ingest_report.aggregate([{"cohort": "non-workday", "status": "ok"}, s], ["non-workday", "workday"])[0], "degraded")
        self.assertTrue(any("no-op" in a for a in ingest_report.annotations(s)))

    def test_all_deferred_after_a_prior_429_is_a_noop_not_success(self):
        self.seed_state_all_ok()
        for _ in range(2):  # the streak stop leaves c unattempted in run 1; run 2 rate-limits c too
            self.ingest({s: (lambda r: httpx.Response(429, headers={"Retry-After": "90000"})) for s in BOARDS})
            fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
        self.requests.clear()
        report, writer = self.ingest({s: ok_page for s in BOARDS})
        self.assertEqual(self.requests, [])
        self.assertEqual(report["failed_sources"], [])
        self.assertEqual(report["workday"]["attempted"], 0)
        self.assert_noop(report)

    def test_dry_run_never_writes_state_then_production_runs_every_board(self):
        # 1) no state at all: a dry run must not create one
        self.ingest({s: ok_page for s in BOARDS}, dry_run=True)
        self.assertFalse(self.state.exists())
        # 2) existing production state is left byte-for-byte unchanged by dry runs (success and 429 alike)
        self.seed_state_all_ok()
        before = self.state.read_bytes()
        self.ingest({s: ok_page for s in BOARDS}, dry_run=True)
        fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
        self.ingest({s: (lambda r: httpx.Response(429, headers={"Retry-After": "90000"})) for s in BOARDS}, dry_run=True)
        self.assertEqual(self.state.read_bytes(), before)
        # 3) the next production run is not deferred by anything the dry runs did
        fetchers._WORKDAY_COOLDOWN_UNTIL.clear()
        self.requests.clear()
        report, writer = self.ingest({s: ok_page for s in BOARDS})
        self.assertEqual(sorted(self.requests), BOARDS)
        self.assertEqual(report["deferred_sources"], [])
        self.assertEqual(report["workday"]["persisted"], 3)
        self.assertIsNone(report["outcome"])
        self.assertEqual(run_ingestion.exit_code_for(report), 0)
        self.assertTrue(all(v["last_success_at"] for v in self.saved().values()))

    def test_workflow_saves_state_only_for_production_writes(self):
        wf = (Path(__file__).resolve().parents[2] / ".github" / "workflows" / "python-ingest.yml").read_text(encoding="utf-8")
        save = wf[wf.index("Save Workday cooldown state"):wf.index("Cohort summary")]
        self.assertIn("needs.plan.outputs.mode == 'write-production-expire'", save)
        self.assertIn("WORKDAY_STATE_PATH", wf)

    def test_backoff_grows_and_honours_retry_after(self):
        boards: dict = {}
        now = datetime(2026, 11, 24, tzinfo=timezone.utc)
        workday_schedule.record_attempt(boards, "workday:a", now, LIM, ok=False, reason="rate_limited", retry_after=10)
        first = datetime.fromisoformat(boards["workday:a"]["next_eligible_at"]) - now
        workday_schedule.record_attempt(boards, "workday:a", now, LIM, ok=False, reason="rate_limited", retry_after=10)
        second = datetime.fromisoformat(boards["workday:a"]["next_eligible_at"]) - now
        self.assertEqual(first, timedelta(seconds=LIM["failure_base_seconds"]))
        self.assertEqual(second, 2 * first)
        workday_schedule.record_attempt(boards, "workday:a", now, LIM, ok=False, retry_after=10 * 86400)
        self.assertEqual(datetime.fromisoformat(boards["workday:a"]["next_eligible_at"]) - now, timedelta(days=10))


if __name__ == "__main__":
    unittest.main()
