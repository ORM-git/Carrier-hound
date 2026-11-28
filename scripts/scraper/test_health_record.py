"""Health-record tests (rows 46/78): run outcome -> ingest_runs row, mocked writes only, no network.

Includes the cross-language contract: the rows built here for fixed synthetic reports must equal
scripts/fixtures/source_health/python_rows.json, which src/lib/__tests__/sourceMonitoring.test.ts evaluates.
"""

from __future__ import annotations

import io
import json
import os
import re
import socket
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from scripts.scraper import health_record as hr
from scripts.scraper import ingest_report, run_ingestion, test_cohorts

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "scripts" / "fixtures" / "source_health" / "python_rows.json"
WORKFLOW = ROOT / ".github" / "workflows" / "python-ingest.yml"
NOW = datetime(2026, 11, 28, 12, 0, tzinfo=timezone.utc)
FAKE_KEY = "fake-service-role-key-for-tests-0123456789"
FAKE_ENV = {"NEXT_PUBLIC_SUPABASE_URL": "https://unit-test-project.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}


class _NoNetwork:
    """Every socket connect raises: proves no real request is made anywhere in this module."""
    attempts: list = []

    LOOPBACK = {"127.0.0.1", "::1", "localhost"}  # asyncio's internal self-pipe on Windows; never outbound

    def __enter__(self):
        real_connect, real_gai = socket.socket.connect, socket.getaddrinfo
        loop = self.LOOPBACK

        def connect(sock, address, *a, **k):
            if isinstance(address, tuple) and address and address[0] in loop:
                return real_connect(sock, address, *a, **k)
            return self._blocked(address)

        def getaddrinfo(host, *a, **k):
            if host in loop:
                return real_gai(host, *a, **k)
            return self._blocked(host)

        self._patches = [patch.object(socket.socket, "connect", connect), patch.object(socket, "create_connection", self._blocked),
                         patch.object(socket, "getaddrinfo", getaddrinfo)]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()

    @classmethod
    def _blocked(cls, *a, **k):
        cls.attempts.append(a)
        raise AssertionError("network access attempted")


def setUpModule():
    global _GUARD
    _NoNetwork.attempts = []
    _GUARD = _NoNetwork().__enter__()


def tearDownModule():
    _GUARD.__exit__(None, None, None)


def src(sid, stype, *, completed=True, inserted=2, updated=1, **extra):
    return {"source": sid, "source_id": sid, "source_type": stype, "status": "success" if completed else "failed",
            "completed": completed, "fetched": 5, "inserted": inserted, "updated": updated, **extra}


def report(sources, *, deferred=(), guard=None, dry_run=False, cohort="non-workday", outcome=None,
           started="2026-11-28T10:47:00+00:00", finished="2026-11-28T11:05:30+00:00"):
    ins = sum(s.get("inserted") or 0 for s in sources)
    upd = sum(s.get("updated") or 0 for s in sources)
    return {"cohort": cohort, "git_sha": "abc123", "started_at": started, "finished_at": finished, "dry_run": dry_run,
            "selected_sources": [s["source_id"] for s in sources] + [d["source"] for d in deferred],
            "sources": sources, "deferred_sources": list(deferred), "guard_block_reason": guard, "outcome": outcome,
            "persisted_counts": None if dry_run else {"inserted": ins, "updated": upd, "unchanged": 0}}


def summary_for(rep, code, cohort):
    return ingest_report.cohort_summary(rep, code, cohort)


RUN_ENV = {"GITHUB_RUN_ID": "9001", "GITHUB_RUN_ATTEMPT": "1"}


def fixture_cases() -> dict[str, dict]:
    """Fixed synthetic reports -> rows. Names and times are what the TS contract tests rely on."""
    nw_ok = report([src("greenhouse:stripe", "greenhouse"), src("amazon", "amazon", inserted=0, updated=0),
                    src("adzuna:in", "adzuna", inserted=4, updated=0)])
    wd_mixed = report([src("workday:nvidia", "workday", pagination_complete=True, source_total=1),
                       src("workday:walmart", "workday", pagination_complete=False, source_total=900)],
                      deferred=[{"source": "workday:cisco", "reason": "cooldown", "deferred_reason": "cooldown",
                                 "next_eligible_at": "2026-11-28T18:00:00+00:00"}], cohort="workday",
                      started="2026-11-28T11:06:00+00:00", finished="2026-11-28T11:20:00+00:00")
    nw_failed = report([src("greenhouse:stripe", "greenhouse", completed=False, inserted=0, updated=0),
                        src("amazon", "amazon", inserted=0, updated=0)], guard="write_withheld: 1 failed source(s)",
                       started="2026-11-28T06:47:00+00:00", finished="2026-11-28T07:00:00+00:00")
    wd_noop = report([], deferred=[{"source": "workday:nvidia", "reason": "cooldown", "deferred_reason": "cooldown",
                                    "next_eligible_at": None}], cohort="workday", outcome="noop_deferred",
                     guard="noop_deferred: ...", started="2026-11-28T07:01:00+00:00", finished="2026-11-28T07:02:00+00:00")
    out = {
        "non_workday_ok": hr.build_run_record(nw_ok, summary_for(nw_ok, 0, "non-workday"), "non-workday", NOW, RUN_ENV),
        "workday_incomplete_and_deferred": hr.build_run_record(wd_mixed, summary_for(wd_mixed, 0, "workday"), "workday", NOW, RUN_ENV),
        "non_workday_failed": hr.build_run_record(nw_failed, summary_for(nw_failed, 1, "non-workday"), "non-workday", NOW, RUN_ENV),
        "workday_deferred_noop": hr.build_run_record(wd_noop, summary_for(wd_noop, 3, "workday"), "workday", NOW, RUN_ENV),
        "workday_no_report": hr.build_run_record(None, summary_for(None, 1, "workday"), "workday", NOW, RUN_ENV),
    }
    return out


class RowShapeTests(unittest.TestCase):
    def test_success_row_uses_existing_columns_and_verbatim_source_ids(self):
        row = fixture_cases()["non_workday_ok"]
        self.assertEqual(set(row), {"started_at", "finished_at", "duration_seconds", "companies_processed", "total_active",
                                    "total_verified", "per_source_counts", "status", "error"})
        self.assertEqual(row["status"], "success")
        self.assertEqual({k: v for k, v in row["per_source_counts"].items() if k != "python_run"},
                         {"greenhouse:stripe": 3, "amazon": 0, "adzuna:in": 4})   # zero is real evidence, kept as 0
        self.assertIsNone(row["total_active"])          # never invented
        self.assertIsNone(row["total_verified"])
        self.assertEqual(row["companies_processed"], 3)
        self.assertEqual(row["duration_seconds"], 1110)
        self.assertNotIn("coverage", row["per_source_counts"])   # never mistaken for a TS shard
        meta = row["per_source_counts"]["python_run"]
        self.assertEqual((meta["pipeline"], meta["cohort"], meta["outcome"], meta["exit_code"]), ("python", "non-workday", "ok", "0"))
        self.assertEqual(meta["run"], {"github_run_id": "9001", "github_run_attempt": "1"})

    def test_incomplete_workday_pagination_is_never_success(self):
        row = fixture_cases()["workday_incomplete_and_deferred"]
        self.assertEqual(row["status"], "warning")
        self.assertIn("incomplete", row["error"])
        psc = row["per_source_counts"]
        self.assertEqual(psc["workday:nvidia"], 3)
        self.assertIsNone(psc["workday:walmart"])                          # incomplete: count unknown, not evidence
        self.assertNotIn("workday:cisco", psc)                              # deferred: metadata only, never a source key
        meta = psc["python_run"]
        self.assertEqual(meta["sources"]["workday:walmart"]["state"], "incomplete")
        self.assertEqual(meta["sources"]["workday:walmart"]["pagination_complete"], False)
        self.assertEqual(meta["deferred"]["workday:cisco"]["reason"], "cooldown")

    def test_unknown_pagination_is_incomplete_not_complete(self):
        self.assertEqual(hr.source_state(src("workday:x", "workday")), "incomplete")
        self.assertEqual(hr.source_state(src("workday:x", "workday", pagination_complete=None)), "incomplete")
        self.assertEqual(hr.source_state(src("greenhouse:x", "greenhouse")), "completed")

    def test_failed_run_with_withheld_writes_has_no_counts(self):
        row = fixture_cases()["non_workday_failed"]
        self.assertEqual(row["status"], "failed")
        self.assertTrue(all(v is None for k, v in row["per_source_counts"].items() if k != "python_run"))
        meta = row["per_source_counts"]["python_run"]
        self.assertIsNone(meta["confirmed_writes"])
        self.assertEqual(meta["sources"]["greenhouse:stripe"]["state"], "failed")
        self.assertIn("write_withheld", row["error"])

    def test_partial_failure_with_confirmed_writes_is_warning(self):
        rep = report([src("workday:nvidia", "workday", pagination_complete=True),
                      src("workday:walmart", "workday", completed=False, inserted=0, updated=0)],
                     guard="workday_isolated: 1 failed", cohort="workday")
        row = hr.build_run_record(rep, summary_for(rep, 1, "workday"), "workday", NOW)
        self.assertEqual(row["status"], "warning")
        self.assertEqual(row["per_source_counts"]["workday:nvidia"], 3)
        self.assertIsNone(row["per_source_counts"]["workday:walmart"])

    def test_deferred_noop_is_distinct_from_failure(self):
        row = fixture_cases()["workday_deferred_noop"]
        self.assertEqual(row["status"], "warning")
        self.assertEqual(row["per_source_counts"]["python_run"]["outcome"], "deferred_noop")
        self.assertTrue(row["error"].startswith("deferred_noop"))
        self.assertEqual(set(row["per_source_counts"]), {"python_run"})

    def test_missing_report_is_failed_with_no_invented_values(self):
        row = fixture_cases()["workday_no_report"]
        self.assertEqual((row["status"], row["started_at"], row["duration_seconds"], row["companies_processed"]),
                         ("failed", None, None, None))
        self.assertEqual(set(row["per_source_counts"]), {"python_run"})
        self.assertEqual(row["per_source_counts"]["python_run"]["outcome"], "no_report")

    def test_no_urls_or_error_text_in_metadata(self):
        rep = report([src("greenhouse:stripe", "greenhouse", completed=False, error="GET https://boards-api.greenhouse.io/x 503",
                          error_class="http_5xx")])
        text = json.dumps(hr.build_run_record(rep, summary_for(rep, 1, "non-workday"), "non-workday", NOW))
        self.assertNotIn("https://", text)

    def test_cross_language_fixture_matches(self):
        expected = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(expected["rows"], fixture_cases(), "regenerate with: python -m scripts.scraper.test_health_record --write-fixture")


class RealRunnerIntegrationTests(unittest.TestCase):
    """The real runner (mocked HTTP + recording writer from test_cohorts) -> summary -> row."""

    def run_real(self, cohort, workday_status=200, greenhouse_error=None):
        h = test_cohorts.CohortRunTests("setUp")
        h.setUp()
        try:
            rep = h.run_cohort(cohort, h.make_writer(), h.handler(workday_status), greenhouse_error=greenhouse_error)
        finally:
            h.doCleanups()
        code = run_ingestion.exit_code_for(rep)
        return rep, code, hr.build_run_record(rep, ingest_report.cohort_summary(rep, code, cohort), cohort, NOW)

    def test_non_workday_success_maps_report_source_ids_exactly(self):
        rep, code, row = self.run_real("non-workday")
        self.assertEqual(code, 0)
        self.assertEqual(row["status"], "success")
        report_ids = {s["source_id"] for s in rep["sources"]}
        self.assertEqual({k for k in row["per_source_counts"] if k != "python_run"}, report_ids)
        for s in rep["sources"]:  # per-source values mirror the runner's own counts, never recomputed
            self.assertEqual(row["per_source_counts"][s["source_id"]], s["inserted"] + s["updated"])

    def test_workday_429_is_failed_not_success(self):
        rep, code, row = self.run_real("workday", workday_status=429)
        self.assertEqual(code, 1)
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["per_source_counts"]["python_run"]["sources"]["workday:nvidia"]["state"], "failed")
        self.assertIsNone(row["per_source_counts"]["workday:nvidia"])

    def test_workday_complete_single_page_board_is_success(self):
        rep, code, row = self.run_real("workday", workday_status=200)
        self.assertEqual(code, 0)
        board = row["per_source_counts"]["python_run"]["sources"]["workday:nvidia"]
        self.assertEqual(board["pagination_complete"], True)   # #873 measure reused, not recomputed
        self.assertEqual(row["status"], "success")


class _Resp:
    status = 201

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def getcode(self):
        return self.status


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        self.report_path, self.summary_path, self.step_summary = d / "r.json", d / "s.json", d / "step.md"
        rep = report([src("greenhouse:stripe", "greenhouse")])
        self.report_path.write_text(json.dumps(rep), encoding="utf-8")
        self.summary_path.write_text(json.dumps(summary_for(rep, 0, "non-workday")), encoding="utf-8")
        self.calls = []

    def args(self, mode="write-production-expire"):
        return SimpleNamespace(cohort="non-workday", mode=mode, report=str(self.report_path), summary=str(self.summary_path), exit_code="0")

    def opener(self, req, timeout):
        self.calls.append((req, timeout))
        return _Resp()

    def run_record(self, args, opener=None, env=FAKE_ENV):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {**env, "GITHUB_STEP_SUMMARY": str(self.step_summary)}, clear=False), \
                redirect_stdout(out), redirect_stderr(err):
            code = hr.record(args, opener=opener or self.opener, now=NOW)
        return code, out.getvalue(), err.getvalue()

    def test_dry_run_mode_never_writes(self):
        code, out, _ = self.run_record(self.args(mode="dry-run"))
        self.assertEqual((code, self.calls), (0, []))
        self.assertIn("nothing written", out)

    def test_dry_run_report_never_writes_even_in_write_mode(self):
        rep = json.loads(self.report_path.read_text())
        rep["dry_run"] = True
        self.report_path.write_text(json.dumps(rep), encoding="utf-8")
        code, out, _ = self.run_record(self.args())
        self.assertEqual((code, self.calls), (0, []))
        self.assertIn("dry run", out)

    def test_successful_write_posts_one_row_with_bounded_timeout(self):
        code, out, _ = self.run_record(self.args())
        self.assertEqual(code, 0)
        self.assertEqual(len(self.calls), 1)
        req, timeout = self.calls[0]
        self.assertEqual(timeout, hr.WRITE_TIMEOUT_SECONDS)
        self.assertEqual(req.full_url, "https://unit-test-project.supabase.co/rest/v1/ingest_runs")
        self.assertEqual(req.get_method(), "POST")
        body = json.loads(req.data)
        self.assertEqual(len(body), 1)
        self.assertEqual(body[0]["status"], "success")
        self.assertNotIn(FAKE_KEY, out)
        self.assertIn("written", self.step_summary.read_text(encoding="utf-8"))

    def test_http_failure_is_visible_and_does_not_rewrite_ingestion_result(self):
        def failing(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 500, "boom", {}, io.BytesIO(f"bad key {FAKE_KEY}".encode()))
        code, out, err = self.run_record(self.args(), opener=failing)
        self.assertEqual(code, 1)
        self.assertIn("::error title=Health record not written [non-workday]::HTTP 500", err)
        self.assertIn("ingestion result: ok (exit 0) (unchanged)", err)
        self.assertNotIn(FAKE_KEY, err + out)
        step = self.step_summary.read_text(encoding="utf-8")
        self.assertIn("**Health record NOT written**", step)
        self.assertIn("ingestion result: ok (exit 0)", step)

    def test_timeout_is_a_visible_failure(self):
        def slow(req, timeout):
            raise TimeoutError("timed out")
        code, _, err = self.run_record(self.args(), opener=slow)
        self.assertEqual(code, 1)
        self.assertIn("TimeoutError", err)

    def test_missing_credentials_fail_before_any_request(self):
        code, _, err = self.run_record(self.args(), env={"NEXT_PUBLIC_SUPABASE_URL": "", "SUPABASE_URL": "",
                                                         "SUPABASE_SERVICE_ROLE_KEY": "", "SUPABASE_SERVICE_KEY": ""})
        self.assertEqual((code, self.calls), (1, []))
        self.assertIn("write mode refused", err)

    def test_missing_report_in_write_mode_records_failed_run(self):
        self.report_path.unlink()
        self.summary_path.unlink()
        code, _, _ = self.run_record(SimpleNamespace(cohort="workday", mode="write-production-expire", report=str(self.report_path),
                                                     summary=str(self.summary_path), exit_code="1"))
        self.assertEqual(code, 0)
        row = json.loads(self.calls[0][0].data)[0]
        self.assertEqual((row["status"], row["per_source_counts"]["python_run"]["outcome"]), ("failed", "no_report"))

    def test_network_guard_negative_control(self):
        with self.assertRaises(AssertionError):
            socket.create_connection(("guard.example", 443))
        _NoNetwork.attempts.clear()
        # The real urllib opener (no mock) is stopped by the guard at DNS/connect: no request leaves the machine.
        with patch.dict(os.environ, FAKE_ENV), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), \
                self.assertRaises(AssertionError):
            hr.record(self.args(), opener=None, now=NOW)
        self.assertTrue(_NoNetwork.attempts, "the default opener reached the guarded socket layer")
        _NoNetwork.attempts.clear()

    def test_no_outbound_attempt_in_this_module(self):
        self.assertEqual(_NoNetwork.attempts, [])


class ExpectedSourcesTests(unittest.TestCase):
    def test_checked_in_expected_sources_match_the_runner_plan(self):
        doc = json.loads(hr.EXPECTED_SOURCES_PATH.read_text(encoding="utf-8"))
        self.assertEqual(doc, hr.expected_sources_document())
        self.assertEqual(sorted(doc["cohorts"]), sorted(run_ingestion.COHORTS))
        planned = {p["id"] for p in run_ingestion.plan_sources(run_ingestion.load_company_seeds(run_ingestion.DEFAULT_SEEDS_PATH))}
        self.assertEqual(set().union(*map(set, doc["cohorts"].values())), planned)   # every planned source, each cohort once

    def test_negative_control_missing_python_source_fails_the_drift_check(self):
        doc = hr.expected_sources_document()
        doc["cohorts"]["non-workday"] = doc["cohorts"]["non-workday"][1:]   # drop one source
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "expected_sources.json"
            p.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
            err = io.StringIO()
            with patch.object(hr, "EXPECTED_SOURCES_PATH", p), redirect_stderr(err), redirect_stdout(io.StringIO()):
                self.assertEqual(hr.main(["expected-sources", "--check"]), 1)
            self.assertIn("out of date", err.getvalue())
        with redirect_stdout(io.StringIO()):
            self.assertEqual(hr.main(["expected-sources", "--check"]), 0)


class WorkflowWiringTests(unittest.TestCase):
    def test_record_step_is_write_mode_only_bounded_and_non_masking(self):
        wf = WORKFLOW.read_text(encoding="utf-8")
        step = wf.split("- name: Record run health", 1)[1].split("- name:", 1)[0]
        # Off by default: write mode AND the owner's repo variable (Actions == is case-insensitive).
        self.assertIn("if: always() && needs.plan.outputs.mode == 'write-production-expire' && vars.PY_HEALTH_RECORD == 'true'", step)
        self.assertEqual(len(re.findall(r"^\s+if:", step, re.M)), 1)
        self.assertIn("continue-on-error: true", step)
        self.assertRegex(step, r"timeout-minutes:\s*[1-5]\b")
        self.assertIn("python -m scripts.scraper.health_record record", step)
        self.assertLess(wf.index("- name: Cohort summary"), wf.index("- name: Record run health"))

    def test_no_new_secrets(self):
        wf = WORKFLOW.read_text(encoding="utf-8")
        self.assertEqual(set(re.findall(r"secrets\.([A-Z_]+)", wf)),
                         {"NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY",
                          "ADZUNA_APP_ID", "ADZUNA_APP_KEY"})

    def test_workflow_cohorts_match_expected_sources(self):
        wf = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("""both) cohorts='["non-workday","workday"]'""", wf)
        doc = json.loads(hr.EXPECTED_SOURCES_PATH.read_text(encoding="utf-8"))
        self.assertEqual(sorted(doc["cohorts"]), ["non-workday", "workday"])


class WindowContractTests(unittest.TestCase):
    """The TS checker's Workday window must cover the runner's own rotation/backoff limits."""

    def test_workday_stale_window_covers_rotation_and_backoff(self):
        from scripts.scraper import workday_schedule
        lim = workday_schedule.limits()
        ts = (ROOT / "scripts" / "check-source-health.ts").read_text(encoding="utf-8")
        wd_hours = int(re.search(r'workday:\s*(\d+)\s*\}', ts).group(1))
        overdue = int(re.search(r"PY_COHORT_OVERDUE_AFTER_HOURS = (\d+)", ts).group(1))
        boards = len(run_ingestion.load_company_seeds(run_ingestion.DEFAULT_SEEDS_PATH)["layer2_enterprise_json"]["workday_cxs"])
        rotation_hours = -(-boards // lim["max_boards"]) * 4
        needed = lim["failure_cap_seconds"] / 3600 + rotation_hours + overdue
        self.assertGreaterEqual(wd_hours, needed)
        self.assertGreaterEqual(overdue * 60, 240 + 45)   # never earlier than the watchdog's own catch-up threshold


def _write_fixture() -> None:
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps({"generated_by": "python -m scripts.scraper.test_health_record --write-fixture",
                                   "now": NOW.isoformat(), "rows": fixture_cases()}, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    import sys
    if "--write-fixture" in sys.argv:
        _write_fixture()
        print(f"wrote {FIXTURE}")
    else:
        unittest.main()
