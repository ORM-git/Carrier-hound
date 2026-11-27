"""Workday per-board request measurements: observation only, no behavior change. Offline: all HTTP is mocked."""

from __future__ import annotations

import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from scripts.scraper import fetchers, ingest_report, rate_limiter
from scripts.scraper.test_workday_isolation import BOARDS, POSTING, SEEDS, Base, ok_page

SEED = SEEDS["layer2_enterprise_json"]["workday_cxs"][0]


def scripted(*responses):
    """Handler returning the given responses (or raising exceptions) in order, then 200 pages."""
    queue = list(responses)

    def handle(_req):
        item = queue.pop(0) if queue else httpx.Response(200, json={"jobPostings": [POSTING]})
        if isinstance(item, Exception):
            raise item
        return item
    return handle


def by_source(report):
    return {s["source"]: s for s in report["sources"]}


class RunnerMeasureTests(Base):
    def test_recovered_429_is_a_completed_healthy_board_with_both_statuses(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({"a": scripted(httpx.Response(429, headers={"Retry-After": "1"})), "b": ok_page, "c": ok_page})
        a = by_source(report)["workday:a"]
        self.assertEqual(a["status"], "ok")
        self.assertEqual(a["status_counts"], {"429": 1, "200": 1})
        self.assertEqual((a["http_requests"], a["pages_requested"], a["network_errors"]), (2, 1, 0))
        self.assertEqual(a["retry_after_seconds_seen"], [1.0])
        self.assertIsNone(a["trigger_status"])
        self.assertIsNone(a["error_class"])
        self.assertEqual(a["request_host"], "ta.wd5.myworkdayjobs.com")
        self.assertEqual((a["jobs_fetched"], a["jobs_persisted"]), (1, 1))
        self.assertIsInstance(a["elapsed_seconds"], float)
        self.assertIsNotNone(self.saved()["workday:a"]["last_success_at"], "existing healthy prerequisites hold")

    def test_recovered_request_but_failed_persist_stays_unhealthy(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({"a": scripted(httpx.Response(429, headers={"Retry-After": "1"})), "b": ok_page, "c": ok_page},
                                self.make_writer(persistence_failed=True))
        a = by_source(report)["workday:a"]
        self.assertEqual(a["status_counts"], {"429": 1, "200": 1})
        self.assertIsNone(a["error_class"])
        self.assertEqual(a["jobs_persisted"], 0)
        self.assertIsNone(self.saved()["workday:a"]["last_success_at"], "a successful request alone never makes a board healthy")

    def test_terminal_503_is_server_5xx_not_rate_limited(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({s: (lambda r: httpx.Response(503, headers={"Retry-After": "90000"})) for s in BOARDS})
        a = by_source(report)["workday:a"]
        self.assertEqual((a["trigger_status"], a["error_class"]), (503, "server_5xx"))
        self.assertEqual(a["retry_after_seconds_seen"], [90000.0])
        self.assertEqual(a["http_requests"], 1, "long Retry-After ends the board")

    def test_long_429_records_value_and_deferred_boards_get_null_measures_no_failure(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({s: (lambda r: httpx.Response(429, headers={"Retry-After": "90000"})) for s in BOARDS})
        a = by_source(report)["workday:a"]
        self.assertEqual((a["trigger_status"], a["error_class"], a["retry_after_seconds_seen"]), (429, "rate_limited_429", [90000.0]))
        self.assertIsNone(a["jobs_persisted"], "writes were not attempted")
        deferred = {d["source"]: d for d in report["deferred_sources"]}
        self.assertEqual(sorted(deferred), ["workday:b", "workday:c"])
        for d in deferred.values():
            self.assertEqual(d["deferred_reason"], d["reason"])
            self.assertTrue(all(d[k] is None for k in ingest_report.WORKDAY_MEASURES), d)
        state = self.saved()
        for sid in deferred:
            self.assertEqual(state[sid]["consecutive_failures"], 0)
            self.assertNotIn("last_attempt_at", state[sid])

    def test_no_retry_after_header_records_none(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({s: (lambda r: httpx.Response(429)) for s in BOARDS})
        a = by_source(report)["workday:a"]
        self.assertIsNone(a["retry_after_seconds_seen"])
        self.assertEqual(a["status_counts"], {"429": fetchers.WORKDAY_MAX_RETRIES + 1})
        self.assertEqual((a["trigger_status"], a["error_class"]), (429, "rate_limited_429"))

    def test_network_errors_are_counted(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({"a": scripted(httpx.ConnectError("boom")), "b": ok_page, "c": ok_page})
        a = by_source(report)["workday:a"]
        self.assertEqual((a["status"], a["network_errors"], a["http_requests"], a["status_counts"]), ("ok", 1, 2, {"200": 1}))
        self.seed_state_all_ok()  # board a completed moments ago; make it eligible again
        report, _ = self.ingest({s: (lambda r: (_ for _ in ()).throw(httpx.ConnectError("boom"))) for s in BOARDS})
        a = by_source(report)["workday:a"]
        n = fetchers.WORKDAY_MAX_RETRIES + 1
        self.assertEqual((a["network_errors"], a["http_requests"], a["status_counts"]), (n, n, {}))
        self.assertEqual((a["trigger_status"], a["error_class"]), ("network", "network"))

    def test_dry_run_jobs_persisted_null_and_no_state(self):
        report, _ = self.ingest({s: ok_page for s in BOARDS}, dry_run=True)
        self.assertFalse(self.state.exists())
        for s in report["sources"]:
            if s["source_type"] == "workday":
                self.assertIsNone(s["jobs_persisted"])
                self.assertEqual(s["http_requests"], 1)

    def test_write_run_jobs_persisted_counts_persisted_keys(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({s: ok_page for s in BOARDS})
        for sid in ("workday:a", "workday:b", "workday:c"):
            self.assertEqual(by_source(report)[sid]["jobs_persisted"], 1)

    def test_duplicate_only_board_keeps_existing_healthy_outcome(self):
        self.seed_state_all_ok()
        writer_cls = self.make_writer()

        async def all_duplicates(_client, jobs, _map):
            return {"inserted": 0, "updated": 0, "skipped_unchanged": 0, "persisted_ids": [], "rejected": [],
                    "persisted_source_keys": [], "inserted_source_keys": [], "updated_source_keys": [],
                    "duplicate_skipped": [{"source_key": f"{j['source_id']}/{j['source_job_id']}", "stage": "insert",
                                           "code": "dup", "reason": "duplicate apply_url"} for j in jobs]}

        writer_cls.return_value.sync_jobs_set_diff = AsyncMock(side_effect=all_duplicates)
        report, _ = self.ingest({s: ok_page for s in BOARDS}, writer_cls)
        self.assertEqual(by_source(report)["workday:a"]["jobs_persisted"], 0)
        self.assertEqual(report["workday"]["persisted"], 3)
        self.assertTrue(all(v["last_success_at"] for v in self.saved().values()))

    def test_summary_renders_measures_and_unknown(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({"a": scripted(httpx.Response(429, headers={"Retry-After": "1"})),
                                 "b": lambda r: httpx.Response(503, headers={"Retry-After": "90000"}), "c": ok_page})
        s = ingest_report.cohort_summary(report, 1, "workday")
        t = s["workday_totals"]
        self.assertEqual((t["boards_measured"], t["http_requests"]), (2, 3))
        self.assertEqual(t["status_counts"], {"200": 1, "429": 1, "503": 1})
        self.assertEqual(t["boards_by_error_class"], {"server_5xx": 1})
        self.assertEqual([b["source"] for b in s["workday_boards"]], ["workday:a", "workday:b", "workday:c"])
        text = ingest_report.render_cohort(s)
        self.assertIn("Workday request measures", text)
        self.assertIn('| workday HTTP status counts | {"200": 1, "429": 1, "503": 1} |', text)
        self.assertIn("| workday:c | unknown | unknown |", text, "deferred board: unknown, never zero")

        # A report from before this change has no measures: unknown, not zero.
        old = {"dry_run": False, "workday": {"selected": 1}, "sources": [{"source": "workday:a", "source_type": "workday"}]}
        text = ingest_report.render_cohort(ingest_report.cohort_summary(old, 0, "workday"))
        self.assertIn("| workday requests observed / network errors (boards measured) | unknown |", text)
        self.assertIn("| workday:a | unknown | unknown |", text)


class FetcherMeasureTests(Base):
    def go(self, handler, metrics, **env):
        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                return await fetchers.fetch_workday_cxs(client, rate_limiter.PerHostRateLimiter(1000.0, 1000.0), SEED,
                                                        max_pages=1, polite_delay=0.0, metrics=metrics)
        with patch.dict(os.environ, env):
            return asyncio.run(run())

    def test_pre_request_cooldown_and_page_budget_have_no_trigger_status(self):
        fetchers._WORKDAY_COOLDOWN_UNTIL = fetchers.time.monotonic() + 1000
        m = fetchers.new_workday_metrics()
        with self.assertRaises(fetchers.WorkdayRateLimited):
            self.go(ok_page, m)
        self.assertEqual((m["trigger_status"], m["error_class"], m["http_requests"]), (None, "cooldown_active", 0))

        fetchers._WORKDAY_COOLDOWN_UNTIL = fetchers._WORKDAY_LAST_TENANT_START = 0.0  # no real tenant-spacing sleep
        fetchers._WORKDAY_TENANT_NEXT["ta.wd5.myworkdayjobs.com"] = fetchers.time.monotonic() + 1000
        m = fetchers.new_workday_metrics()
        with self.assertRaises(fetchers.WorkdayRateLimited):
            self.go(ok_page, m, WORKDAY_PAGE_WAIT_BUDGET_SECONDS="5")
        self.assertEqual((m["trigger_status"], m["error_class"], m["http_requests"], m["pages_requested"]),
                         (None, "page_budget", 0, 1))

    def test_malformed_page_is_classified(self):
        m = fetchers.new_workday_metrics()
        with self.assertRaises(RuntimeError):
            self.go(lambda r: httpx.Response(200, json={"total": 0}), m)
        self.assertEqual((m["trigger_status"], m["error_class"]), (200, "malformed"))

    def test_retry_sleep_and_cooldown_identical_with_and_without_collector(self):
        def outcome(metrics, responses):
            fetchers._WORKDAY_COOLDOWN_UNTIL = 0.0
            fetchers._WORKDAY_TENANT_NEXT.clear()
            fetchers._WORKDAY_LAST_TENANT_START = 0.0
            clock = [1000.0]
            sleeps: list[float] = []

            async def fake_sleep(s):
                sleeps.append(s)
                clock[0] += s

            with patch.object(fetchers.time, "monotonic", lambda: clock[0]), patch.object(fetchers.asyncio, "sleep", fake_sleep):
                try:
                    result = ("ok", [j["source_job_id"] for j in self.go(scripted(*responses), metrics)])
                except Exception as exc:
                    result = (type(exc).__name__, str(exc), getattr(exc, "retry_after", None))
            return result, sleeps, fetchers._WORKDAY_COOLDOWN_UNTIL - clock[0]

        for responses in ([httpx.Response(429, headers={"Retry-After": "3"}), httpx.Response(503)],
                          [httpx.Response(503, headers={"Retry-After": "90000"})],
                          [httpx.ConnectError("x"), httpx.Response(429)],
                          [httpx.Response(429)] * 5,
                          [httpx.Response(404)]):
            with self.subTest(responses=[getattr(r, "status_code", r) for r in responses]):
                self.assertEqual(outcome(None, list(responses)), outcome(fetchers.new_workday_metrics(), list(responses)))


if __name__ == "__main__":
    unittest.main()
