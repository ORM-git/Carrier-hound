"""Workday per-tenant cooldown and pagination completeness. Offline: all HTTP is mocked."""

from __future__ import annotations

import asyncio
import unittest
from unittest.mock import patch

import httpx

from scripts.scraper import fetchers, rate_limiter
from scripts.scraper.test_workday_isolation import BOARDS, POSTING, SEEDS, Base, ok_page

SEED = SEEDS["layer2_enterprise_json"]["workday_cxs"][0]
LONG_429 = lambda r: httpx.Response(429, headers={"Retry-After": "90000"})  # noqa: E731


def postings(start: int, n: int) -> list[dict]:
    return [dict(POSTING, bulletFields=[f"R{i}"], externalPath=f"/job/x/R{i}") for i in range(start, start + n)]


def pages(*sizes: int, total: int | None = None):
    """Handler serving consecutive pages of the given sizes (unique ids), then empty pages."""
    served = [0]

    def handle(_req):
        i = served[0]
        served[0] += 1
        size = sizes[i] if i < len(sizes) else 0
        body = {"jobPostings": postings(sum(sizes[:i]), size)}
        if total is not None:
            body["total"] = total if i == 0 else 0  # Workday reports 0 on later pages
        return httpx.Response(200, json=body)
    return handle


def by_source(report):
    return {s["source"]: s for s in report["sources"]}


class TenantIsolationTests(Base):
    def test_one_tenant_blocked_others_still_fetch_and_write(self):
        self.seed_state_all_ok()
        report, writer = self.ingest({"a": LONG_429, "b": ok_page, "c": ok_page})
        self.assertEqual(self.requests, ["a", "b", "c"], "a's 429 pauses only a")
        self.assertEqual([f["source"] for f in report["failed_sources"]], ["workday:a"])
        self.assertEqual(report["deferred_sources"], [])
        a = by_source(report)["workday:a"]
        self.assertEqual((a["status"], a["error_class"], a["pagination_complete"]), ("failed", "rate_limited_429", False))
        sent = writer.sync_jobs_set_diff.await_args.args[1]
        self.assertEqual(sorted({j["source_id"] for j in sent}), ["workday:tb:Ext", "workday:tc:Ext"], "blocked a wrote nothing")
        self.assertFalse([c for c in self.db_calls if c[0] == "PATCH"], "a failed fetch never expires anything")
        state = self.saved()
        self.assertEqual(state["workday:a"]["last_reason"], "rate_limited")
        self.assertIsNone(state["workday:a"]["last_success_at"])
        self.assertTrue(state["workday:b"]["last_success_at"] and state["workday:c"]["last_success_at"])

    def test_one_blocked_tenant_resets_the_streak(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({"a": LONG_429, "b": ok_page, "c": LONG_429})
        self.assertEqual(self.requests, ["a", "b", "c"])
        self.assertEqual(report["deferred_sources"], [])

    def test_recovery_after_cooldown(self):
        self.seed_state_all_ok()
        self.ingest({"a": LONG_429, "b": ok_page, "c": ok_page})
        # Next run inside a's persisted cooldown: a is deferred, b and c are fetched.
        fetchers._WORKDAY_COOLDOWN_UNTIL.clear()  # each run is a new process
        self.requests.clear()
        self.seed_state_all_ok(**{"workday:a": self.saved()["workday:a"]})  # keep a's cooldown; b, c eligible again
        report, _ = self.ingest({s: ok_page for s in BOARDS})
        self.assertEqual(self.requests, ["b", "c"])
        self.assertEqual([d["source"] for d in report["deferred_sources"]], ["workday:a"])
        # Once a's cooldown has passed, a is requested again and completes.
        state = self.saved()
        state["workday:a"]["next_eligible_at"] = "2000-01-01T00:00:00+00:00"
        self.write_state(state)
        self.requests.clear()
        report, _ = self.ingest({s: ok_page for s in BOARDS})
        self.assertIn("a", self.requests)
        self.assertEqual(by_source(report)["workday:a"]["status"], "ok")
        self.assertIsNotNone(self.saved()["workday:a"]["last_success_at"])

    def test_short_tenant_cooldown_is_waited_out_then_succeeds(self):
        clock = [1000.0]
        sleeps: list[float] = []

        async def fake_sleep(s):
            sleeps.append(s)
            clock[0] += s

        fetchers._WORKDAY_COOLDOWN_UNTIL["ta.wd5.myworkdayjobs.com"] = clock[0] + 10
        fetchers._WORKDAY_COOLDOWN_UNTIL["tb.wd5.myworkdayjobs.com"] = clock[0] + 90000  # another tenant, ignored

        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(ok_page)) as client:
                return await fetchers.fetch_workday_cxs(client, rate_limiter.PerHostRateLimiter(1000.0, 1000.0), SEED,
                                                        max_pages=1, polite_delay=0.0)
        with patch.object(fetchers.time, "monotonic", lambda: clock[0]), patch.object(fetchers.asyncio, "sleep", fake_sleep):
            jobs = asyncio.run(run())
        self.assertEqual(len(jobs), 1)
        self.assertEqual(sleeps, [10.0], "only a's own cooldown was waited")


class PaginationTests(Base):
    def go(self, handler, max_pages):
        metrics = fetchers.new_workday_metrics()

        async def no_sleep(_s):
            return None

        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                return await fetchers.fetch_workday_cxs(client, rate_limiter.PerHostRateLimiter(1000.0, 1000.0), SEED,
                                                        max_pages=max_pages, polite_delay=0.0, metrics=metrics)
        with patch.object(fetchers.asyncio, "sleep", no_sleep):
            try:
                return asyncio.run(run()), metrics
            except Exception as exc:  # noqa: BLE001
                return exc, metrics

    def test_page_cap_reached_is_not_complete(self):
        jobs, m = self.go(pages(20, 20, 5, total=45), max_pages=1)
        self.assertEqual((len(jobs), m["jobs_fetched"], m["source_total"], m["pagination_complete"]), (20, 20, 45, False))

    def test_all_pages_fetched_is_complete(self):
        jobs, m = self.go(pages(20, 20, 5, total=45), max_pages=3)
        self.assertEqual((len(jobs), m["source_total"], m["pagination_complete"], m["pages_requested"]), (45, 45, True, 3))
        self.assertEqual(len({j["source_job_id"] for j in jobs}), 45, "no duplicate jobs across pages")

    def test_total_reached_on_a_full_page_is_complete_without_total_unknown(self):
        _, m = self.go(pages(20, total=20), max_pages=1)
        self.assertEqual((m["source_total"], m["pagination_complete"]), (20, True))
        _, m = self.go(pages(20), max_pages=1)
        self.assertEqual((m["source_total"], m["pagination_complete"]), (None, False), "no total, full page: cannot claim complete")

    def test_failed_later_page_is_not_complete(self):
        calls = [0]

        def handler(r):
            calls[0] += 1
            return pages(20, total=45)(r) if calls[0] == 1 else httpx.Response(500)
        out, m = self.go(handler, max_pages=3)
        self.assertIsInstance(out, httpx.HTTPStatusError)
        self.assertEqual((m["jobs_fetched"], m["pagination_complete"]), (20, False))

    def test_run_report_carries_total_and_completeness(self):
        self.seed_state_all_ok()
        report, _ = self.ingest({"a": pages(20, total=45), "b": ok_page, "c": LONG_429})
        by = by_source(report)
        self.assertEqual((by["workday:a"]["status"], by["workday:a"]["source_total"], by["workday:a"]["pagination_complete"]),
                         ("ok", 45, False), "capped board: written, but never labelled complete")
        self.assertEqual((by["workday:b"]["source_total"], by["workday:b"]["pagination_complete"]), (1, True))
        self.assertEqual((by["workday:c"]["source_total"], by["workday:c"]["pagination_complete"]), (None, False))
        self.assertFalse([c for c in self.db_calls if c[0] == "PATCH"], "Workday never expires")


class NoDuplicateTests(Base):
    def test_recovered_429_and_blocked_tenant_yield_each_job_once(self):
        self.seed_state_all_ok()
        served = {"a": 0}

        def a_429_then_page(r):
            served["a"] += 1
            return httpx.Response(429, headers={"Retry-After": "1"}) if served["a"] == 1 else pages(3)(r)
        report, writer = self.ingest({"a": a_429_then_page, "b": LONG_429, "c": pages(2)})
        sent = writer.sync_jobs_set_diff.await_args.args[1]
        keys = [(j["source_id"], j["source_job_id"]) for j in sent]
        self.assertEqual(len(keys), len(set(keys)), "no duplicate rows")
        self.assertEqual(sorted({k[0] for k in keys}), ["workday:ta:Ext", "workday:tc:Ext"])
        self.assertEqual(sum(1 for k in keys if k[0] == "workday:ta:Ext"), 3, "a's retried page counted once")


if __name__ == "__main__":
    unittest.main()
