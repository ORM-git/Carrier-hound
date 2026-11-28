"""Row 81 first caller: 200-capture, 304 unchanged sentinel, commit-after-persist, expiry.

Stub labels: real httpx MockTransport through the real fetchers, run_isolated_source and run_master_ingestion;
the Supabase writer is a FAKE (class below) and the Supabase HTTP host is a MockTransport stub. Not a database test.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from scripts.scraper import conditional_state as cs
from scripts.scraper import engine, fetchers, rate_limiter, run_ingestion
from scripts.scraper.conditional_state import BoardUnchanged, ConditionalContext

SEEDS = {
    "rate_limit": {"default_rps_per_host": 5.0, "burst_per_host": 50},
    "layer1_public_ats": [
        {"slug": "acme", "name": "Acme", "ats": "greenhouse", "token": "acme", "canonical_domain": "acme.com", "category": "HIGH_PRODUCT_YC"},
        {"slug": "foo", "name": "Foo", "ats": "lever", "token": "foo", "canonical_domain": "foo.com", "category": "HIGH_PRODUCT_YC"},
        {"slug": "bar", "name": "Bar", "ats": "ashby", "token": "bar", "canonical_domain": "bar.com", "category": "HIGH_PRODUCT_YC"},
    ],
}
GH_URL = cs.fixed_template_url("greenhouse", "acme")
SB_HOST = "unit-test-project.supabase.co"
ENV = {
    "NEXT_PUBLIC_SUPABASE_URL": f"https://{SB_HOST}",
    "SUPABASE_SERVICE_ROLE_KEY": "fake-service-role-key-for-tests-0123456789",
}
BOARDS = ("greenhouse:acme", "lever:foo", "ashby:bar")


def gh_payload(n=3):
    return {"jobs": [{"id": i + 1, "title": f"Engineer {i}", "absolute_url": f"https://boards.greenhouse.io/acme/jobs/{i + 1}",
                      "location": {"name": "Remote"}, "content": "desc", "first_published": "2026-11-01T00:00:00Z"} for i in range(n)]}


def lever_payload(n=3):
    return [{"id": f"l{i}", "text": f"Engineer {i}", "hostedUrl": f"https://jobs.lever.co/foo/l{i}",
             "categories": {"location": "Remote"}, "descriptionPlain": "desc", "createdAt": 1790000000000} for i in range(n)]


def ashby_payload(n=3):
    return {"jobs": [{"id": f"a{i}", "title": f"Engineer {i}", "jobUrl": f"https://jobs.ashbyhq.com/bar/a{i}",
                      "location": "Remote", "descriptionPlain": "desc", "publishedAt": "2026-11-01T00:00:00Z"} for i in range(n)]}


class FakeWriter:
    """Stub of SupabaseSetDiffWriter. Behavior is configured per test through class attributes."""

    skip_persist: set[tuple[str, str]] = set()
    rejected_keys: list[str] = []
    duplicate_keys: list[str] = []
    persistence_failed = False
    calls: list[int] = []

    def __init__(self, url: str, key: str) -> None:
        self.base_url = url.rstrip("/") + "/rest/v1"
        self.headers = {"apikey": key}
        self.persistence_failed = FakeWriter.persistence_failed
        self.failed_writes = 0
        self.write_errors: list[str] = []

    async def sync_companies(self, client, jobs):
        return {}

    async def sync_jobs_set_diff(self, client, jobs, company_map):
        FakeWriter.calls.append(len(jobs))
        keys = [[str(j["source_id"]), str(j["source_job_id"])] for j in jobs
                if (str(j["source_id"]), str(j["source_job_id"])) not in FakeWriter.skip_persist]
        return {
            "inserted": len(keys), "updated": 0, "skipped_unchanged": 0, "failed_writes": 0, "persistence_failed": False,
            "write_errors": [], "persisted_ids": [], "persisted_source_keys": keys, "inserted_source_keys": keys,
            "updated_source_keys": [], "salary_sanitized": [],
            "rejected": [{"source_key": k, "stage": "insert", "reason": "x"} for k in FakeWriter.rejected_keys],
            "duplicate_skipped": [{"source_key": k, "stage": "insert", "reason": "x"} for k in FakeWriter.duplicate_keys],
        }


class Env:
    """One simulated site: per-host payloads, ETag handling, request log and Supabase stub."""

    def __init__(self) -> None:
        self.gh, self.lever, self.ashby = gh_payload(), lever_payload(), ashby_payload()
        self.etag = {"greenhouse": '"gh1"', "lever": '"lv1"', "ashby": '"ab1"'}
        self.honor_304 = True
        self.log: list[tuple[str, str, str | None]] = []  # host, method, if-none-match
        self.patches: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host == SB_HOST:
            if request.method == "PATCH":
                self.patches.append(dict(request.url.params).get("source_id", "").removeprefix("eq."))
                return httpx.Response(200, json=[])
            return httpx.Response(200, json=[], headers={"content-range": "0-0/5"})
        which = {"boards-api.greenhouse.io": "greenhouse", "api.lever.co": "lever", "api.ashbyhq.com": "ashby"}[host]
        if which == "greenhouse" and "/jobs/" in request.url.path:  # per-job pay-transparency detail (not conditional)
            return httpx.Response(200, json={"id": 1, "pay_input_ranges": []})
        inm = request.headers.get("If-None-Match")
        self.log.append((which, request.method, inm))
        if inm and self.honor_304 and inm == self.etag[which]:
            return httpx.Response(304)
        body = {"greenhouse": self.gh, "lever": self.lever, "ashby": self.ashby}[which]
        return httpx.Response(200, json=body, headers={"ETag": self.etag[which]})


class CallerBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.seeds = Path(self.tmp.name) / "seeds.json"
        self.seeds.write_text(json.dumps(SEEDS), encoding="utf-8")
        self.state = str(Path(self.tmp.name) / "state" / "cv.json")
        self.env = Env()
        FakeWriter.skip_persist, FakeWriter.rejected_keys, FakeWriter.duplicate_keys = set(), [], []
        FakeWriter.persistence_failed, FakeWriter.calls = False, []

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def run_once(self, *, dry_run=False, ats="greenhouse,lever,ashby", state=True, expire=True):
        async def no_sleep(_s: float) -> None:
            return None

        env = {**ENV, "CONDITIONAL_FETCH_ATS": ats}
        if state:
            env["CONDITIONAL_STATE_PATH"] = self.state
        self.env.log, self.env.patches = [], []
        kwargs = dict(sources=["layer1"], seeds_path=self.seeds, dry_run=dry_run, transport=httpx.MockTransport(self.env.handler))
        if dry_run:
            kwargs.update(max_rows=None)
        else:
            kwargs.update(max_rows=None, allow_uncapped=True, no_expire=not expire, allow_expire=expire)
        with patch.dict(os.environ, env, clear=False), \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                patch.object(run_ingestion, "SupabaseSetDiffWriter", FakeWriter), \
                patch.object(rate_limiter.asyncio, "sleep", no_sleep):
            if ats == "":
                os.environ.pop("CONDITIONAL_FETCH_ATS", None)
            return asyncio.run(run_ingestion.run_master_ingestion(**kwargs))

    def state_boards(self):
        boards, status = cs.load_state(self.state)
        return {e["source_id"] for e in boards.values()}, status

    @staticmethod
    def src(report, board):
        return [s for s in report["sources"] if s["source"] == board][0]


class DefaultPathTests(unittest.TestCase):
    def test_conditional_none_keeps_old_call_and_return(self) -> None:
        calls = []

        async def fake(client, limiter, method, url, **kw):
            calls.append((method, url, kw))
            return httpx.Response(200, json=gh_payload(2), request=httpx.Request("GET", url))

        async def go():
            with patch.object(fetchers, "request_with_backoff", fake):
                return await fetchers.fetch_greenhouse(None, None, SEEDS["layer1_public_ats"][0])

        out = asyncio.run(go())
        self.assertIsInstance(out, list)
        self.assertEqual(len(out), 2)
        self.assertEqual(calls, [("GET", GH_URL, {})])  # exactly the old call: no headers, no opt-in kwargs

    def test_all_three_fetchers_default_call_shape(self) -> None:
        for fn, seed, payload in ((fetchers.fetch_lever, SEEDS["layer1_public_ats"][1], lever_payload(1)),
                                  (fetchers.fetch_ashby, SEEDS["layer1_public_ats"][2], ashby_payload(1))):
            calls = []

            async def fake(client, limiter, method, url, _c=calls, _p=payload, **kw):
                _c.append(kw)
                return httpx.Response(200, json=_p, request=httpx.Request("GET", url))

            async def go(fn=fn, seed=seed):
                with patch.object(fetchers, "request_with_backoff", fake):
                    return await fn(None, None, seed)

            self.assertIsInstance(asyncio.run(go()), list)
            self.assertEqual(calls, [{}])

    def test_layer1_seed_default_returns_list(self) -> None:
        async def fake(client, limiter, method, url, **kw):
            return httpx.Response(200, json=gh_payload(1), request=httpx.Request("GET", url))

        async def go():
            with patch.object(fetchers, "request_with_backoff", fake):
                return await engine.fetch_layer1_seed(None, None, SEEDS["layer1_public_ats"][0])

        self.assertEqual(len(asyncio.run(go())), 1)

    def test_unchanged_without_context_is_failure_not_empty_success(self) -> None:
        async def fac():
            return BoardUnchanged("greenhouse:acme", GH_URL)

        rep = asyncio.run(run_ingestion.run_isolated_source("greenhouse:acme", "greenhouse", fac))
        self.assertEqual((rep["status"], rep["completed"], rep["jobs"], rep["unchanged"]), ("failed", False, [], False))
        self.assertIn("Unexpected unchanged", rep["error"])


class SentinelIdentityTests(unittest.TestCase):
    def _ctx(self):
        ctx = ConditionalContext({}, "missing", datetime.now(timezone.utc), {"greenhouse"})
        ctx.view("greenhouse:acme")
        ctx.sent["greenhouse:acme"] = GH_URL
        return ctx

    def _run(self, ctx, result, board="greenhouse:acme"):
        async def fac():
            return result

        return asyncio.run(run_ingestion.run_isolated_source(board, "greenhouse", fac, conditional=ctx))

    def test_matching_sentinel_is_unchanged_not_snapshot(self) -> None:
        rep = self._run(self._ctx(), BoardUnchanged("greenhouse:acme", GH_URL))
        self.assertEqual((rep["status"], rep["completed"], rep["unchanged"], rep["jobs"], rep["fetched"],
                          rep["is_full_coverage"], rep["error"]), ("unchanged", True, True, [], 0, False, None))

    def test_wrong_board_wrong_url_or_unsent_is_failure(self) -> None:
        ctx = self._ctx()
        for res in (BoardUnchanged("lever:foo", GH_URL), BoardUnchanged("greenhouse:acme", GH_URL + "&x=1")):
            rep = self._run(ctx, res)
            self.assertEqual((rep["status"], rep["completed"], rep["unchanged"]), ("failed", False, False))
        ctx2 = ConditionalContext({}, "missing", datetime.now(timezone.utc), {"greenhouse"})
        ctx2.view("greenhouse:acme")  # nothing was sent
        self.assertEqual(self._run(ctx2, BoardUnchanged("greenhouse:acme", GH_URL))["status"], "failed")

    def test_fetch_error_still_isolated(self) -> None:
        async def fac():
            raise RuntimeError("boom")

        rep = asyncio.run(run_ingestion.run_isolated_source("greenhouse:acme", "greenhouse", fac, conditional=self._ctx()))
        self.assertEqual((rep["status"], rep["unchanged"]), ("failed", False))


class EndToEndTests(CallerBase):
    def test_first_run_commits_all_boards_and_second_run_is_unchanged_without_expiry(self) -> None:
        r1 = self.run_once()
        self.assertEqual(self.state_boards(), (set(BOARDS), "ok"))
        self.assertEqual(sorted(self.env.patches), sorted(BOARDS))  # normal expiry ran for every full board
        first_bytes = Path(self.state).read_bytes()
        self.assertTrue(all(self.src(r1, b)["fetched"] == 3 for b in BOARDS))

        FakeWriter.calls = []
        r2 = self.run_once()
        for b in BOARDS:
            s = self.src(r2, b)
            self.assertEqual((s["status"], s["completed"], s["unchanged"], s["fetched"]), ("unchanged", True, True, 0), b)
        self.assertTrue(all(inm for _w, _m, inm in self.env.log), "validators were sent")
        self.assertEqual(self.env.patches, [], "a 304 must never trigger expiry PATCH")
        self.assertEqual([e["status"] for e in r2["expiry_reports"]], ["skipped_unchanged"] * 3)
        self.assertEqual([e["expired"] for e in r2["expiry_reports"]], [0, 0, 0])
        self.assertEqual(FakeWriter.calls, [0])  # no rows written, no snapshot built from the 304
        self.assertEqual(r2["failed_sources"], [])
        self.assertEqual(Path(self.state).read_bytes(), first_bytes, "304 leaves state untouched")

    def test_one_unchanged_board_does_not_stop_others_from_expiring(self) -> None:
        self.run_once()
        self.env.etag["lever"], self.env.etag["ashby"] = '"lv2"', '"ab2"'  # these two changed
        r = self.run_once()
        self.assertEqual(self.src(r, "greenhouse:acme")["status"], "unchanged")
        self.assertEqual(self.src(r, "lever:foo")["status"], "ok")
        self.assertEqual(sorted(self.env.patches), ["ashby:bar", "lever:foo"])
        by = {e["source_id"]: e["status"] for e in r["expiry_reports"]}
        self.assertEqual(by["greenhouse:acme"], "skipped_unchanged")
        self.assertEqual(by["lever:foo"], "completed")

    def test_empty_200_is_not_the_same_as_304(self) -> None:
        self.env.gh = {"jobs": []}
        r1 = self.run_once()
        s = self.src(r1, "greenhouse:acme")
        self.assertEqual((s["status"], s["fetched"], s["unchanged"]), ("ok", 0, False))
        self.assertIn("greenhouse:acme", self.state_boards()[0])  # proven complete empty board commits
        r2 = self.run_once()
        self.assertEqual(self.src(r2, "greenhouse:acme")["status"], "unchanged")

    def test_all_filtered_200_does_not_commit(self) -> None:
        self.env.gh = {"jobs": [{"id": 1}, {"id": 2}]}  # no title/url: every item filtered out
        self.run_once()
        self.assertNotIn("greenhouse:acme", self.state_boards()[0])

    def test_missing_jobs_key_does_not_commit_as_empty_board(self) -> None:
        self.env.gh = {"unexpected": []}
        self.run_once()
        self.assertNotIn("greenhouse:acme", self.state_boards()[0])

    def test_partially_filtered_200_does_not_commit(self) -> None:
        self.env.lever = lever_payload(3) + [{"id": "bad"}]
        self.run_once()
        self.assertNotIn("lever:foo", self.state_boards()[0])
        self.assertIn("greenhouse:acme", self.state_boards()[0])

    def test_dry_run_leaves_state_byte_identical(self) -> None:
        self.run_once()
        before = Path(self.state).read_bytes()
        mtime = Path(self.state).stat().st_mtime_ns
        self.env.etag = {"greenhouse": '"new"', "lever": '"new"', "ashby": '"new"'}
        self.run_once(dry_run=True)
        self.assertEqual(Path(self.state).read_bytes(), before)
        self.assertEqual(Path(self.state).stat().st_mtime_ns, mtime)
        self.assertEqual(self.env.patches, [])

    def test_dry_run_with_no_state_file_creates_none(self) -> None:
        self.run_once(dry_run=True)
        self.assertFalse(Path(self.state).exists())

    def test_rejected_row_blocks_only_that_board(self) -> None:
        FakeWriter.rejected_keys = ["lever:foo/foo:l1"]
        self.run_once()
        got = self.state_boards()[0]
        self.assertNotIn("lever:foo", got)
        self.assertEqual(got, {"greenhouse:acme", "ashby:bar"})

    def test_any_duplicate_skipped_is_a_global_veto(self) -> None:
        FakeWriter.duplicate_keys = ["lever:foo/foo:l2"]
        self.run_once()
        self.assertFalse(Path(self.state).exists() and self.state_boards()[0])

    def test_persistence_failure_is_a_global_veto(self) -> None:
        FakeWriter.persistence_failed = True

        async def failing_companies(self, client, jobs):
            return {}

        with patch.object(FakeWriter, "sync_companies", failing_companies):
            self.run_once()
        self.assertFalse(Path(self.state).exists() and self.state_boards()[0])

    def test_not_all_original_keys_persisted_blocks_commit(self) -> None:
        FakeWriter.skip_persist = {("lever:foo", "foo:l2")}
        self.run_once()
        self.assertEqual(self.state_boards()[0], {"greenhouse:acme", "ashby:bar"})

    def test_failed_board_drops_existing_entry(self) -> None:
        self.run_once()
        self.env.honor_304 = False
        orig = self.env.handler

        def handler(request):
            if request.url.host == "api.lever.co":
                return httpx.Response(500)
            return orig(request)

        self.env.handler = handler  # type: ignore[method-assign]
        self.run_once()
        self.assertNotIn("lever:foo", self.state_boards()[0])

    def test_corrupt_state_means_full_fetch_then_valid_state(self) -> None:
        Path(self.state).parent.mkdir(parents=True)
        Path(self.state).write_text("{not json", encoding="utf-8")
        r = self.run_once()
        self.assertTrue(all(inm is None for _w, _m, inm in self.env.log), "no validators from corrupt state")
        self.assertTrue(all(self.src(r, b)["status"] == "ok" for b in BOARDS))
        self.assertEqual(self.state_boards(), (set(BOARDS), "ok"))

    def test_max_age_forces_full_fetch(self) -> None:
        self.run_once()
        boards, _ = cs.load_state(self.state)
        old = (datetime.now(timezone.utc).replace(microsecond=0)).timestamp() - 21 * 3600
        stale = datetime.fromtimestamp(old, timezone.utc).isoformat()
        for e in boards.values():
            e["last_full_fetch_at"] = stale
        cs.save_state(self.state, boards)
        r = self.run_once()
        self.assertTrue(all(inm is None for _w, _m, inm in self.env.log))
        self.assertTrue(all(self.src(r, b)["status"] == "ok" for b in BOARDS))

    def test_default_off_without_env_switch_sends_nothing(self) -> None:
        self.run_once(ats="")
        self.assertTrue(all(inm is None for _w, _m, inm in self.env.log))
        self.assertFalse(Path(self.state).exists())

    def test_ats_allowlist_limits_conditional_boards(self) -> None:
        self.run_once(ats="greenhouse")
        self.assertEqual(self.state_boards()[0], {"greenhouse:acme"})

    def test_cross_origin_redirect_fails_board_and_drops_entry(self) -> None:
        self.run_once()
        orig = self.env.handler

        def handler(request):
            if request.url.host == "boards-api.greenhouse.io":
                return httpx.Response(302, headers={"Location": "https://other.example.net/x"})
            return orig(request)

        self.env.handler = handler  # type: ignore[method-assign]
        r = self.run_once()
        self.assertEqual(self.src(r, "greenhouse:acme")["status"], "failed")
        self.assertNotIn("greenhouse:acme", self.state_boards()[0])

    def test_original_identity_duplicate_before_collapse_blocks_commit(self) -> None:
        # Two raw Greenhouse rows normalize to the same identity. select_unique_jobs collapses them before the
        # writer, so duplicate_skipped stays 0 and a set-based finalize would commit. Original duplicates veto.
        row = gh_payload(1)["jobs"][0]
        self.env.gh = {"jobs": [row, dict(row)]}
        r = self.run_once()
        s = self.src(r, "greenhouse:acme")
        self.assertEqual((s["fetched"], s["validated"], s["duplicate_skipped"]), (2, 1, 0))
        self.assertFalse(Path(self.state).exists() and self.state_boards()[0], "no board may commit (global veto)")

    def test_original_duplicate_drops_existing_entry_and_vetoes_other_boards(self) -> None:
        self.run_once()
        self.assertEqual(self.state_boards()[0], set(BOARDS))
        row = gh_payload(1)["jobs"][0]
        self.env.gh = {"jobs": [row, dict(row)]}
        self.env.etag["greenhouse"] = '"gh2"'
        self.env.etag["lever"] = '"lv2"'  # lever changed: would normally commit, but the run is vetoed
        self.run_once()
        got = self.state_boards()[0]
        self.assertNotIn("greenhouse:acme", got)
        self.assertNotIn("lever:foo", got)
        self.assertIn("ashby:bar", got)  # unchanged 304 board: entry untouched

    def test_unsafe_slug_never_gets_conditional_headers(self) -> None:
        self.assertIsNone(cs.fixed_template_url("greenhouse", "a/../b"))
        self.assertIsNone(cs.fixed_template_url("greenhouse", "a?token=1"))
        self.assertIsNone(cs.fixed_template_url("workday", "acme"))
        self.assertIsNone(cs.fixed_template_url("lever", ""))
        self.assertIsNone(cs.fixed_template_url("lever", "x" * 65))


if __name__ == "__main__":
    unittest.main()
