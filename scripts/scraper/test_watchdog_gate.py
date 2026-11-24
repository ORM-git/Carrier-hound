"""
test_watchdog_gate.py - Comprehensive unit and negative regression tests for watchdog admission gate.
"""

from __future__ import annotations

import io
import json
import unittest
import urllib.error
from unittest.mock import patch, MagicMock
from datetime import datetime, timezone, timedelta
from scripts.scraper.watchdog_gate import (
    evaluate_watchdog_admission,
    fetch_workflow_runs_and_jobs,
    parse_iso8601,
    GateVerificationError,
    DEFAULT_SUCCESS_COOLDOWN_SECONDS,
    DEFAULT_ATTEMPT_COOLDOWN_SECONDS,
)


class TestWatchdogGate(unittest.TestCase):

    def test_parse_iso8601(self):
        self.assertIsNone(parse_iso8601(""))
        self.assertIsNone(parse_iso8601(None))
        self.assertIsNone(parse_iso8601("not-a-date"))

        dt_z = parse_iso8601("2026-11-24T01:09:11Z")
        self.assertIsNotNone(dt_z)
        self.assertEqual(dt_z.year, 2026)
        self.assertEqual(dt_z.tzinfo, timezone.utc)

        dt_offset = parse_iso8601("2026-11-24T06:39:11+05:30")
        self.assertIsNotNone(dt_offset)
        self.assertEqual(dt_offset.astimezone(timezone.utc).hour, 1)

    def test_non_watchdog_run_always_admitted(self):
        now = datetime(2026, 11, 24, 5, 0, 0, tzinfo=timezone.utc)
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=False,
            runs=[],
            current_time=now,
        )
        self.assertFalse(skip)
        self.assertIn("Not a watchdog catch-up run", reason)
        self.assertEqual(cohorts, ["non-workday", "workday"])

    def test_verified_first_run_bootstrap_admitted(self):
        now = datetime(2026, 11, 24, 5, 0, 0, tzinfo=timezone.utc)
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=[],
            verified_bootstrap=True,
            current_time=now,
        )
        self.assertFalse(skip)
        self.assertIn("Verified first-run bootstrap", reason)
        self.assertEqual(cohorts, ["non-workday", "workday"])

    def test_missing_credentials_or_unverified_empty_history_fails_closed(self):
        # Empty runs without verified bootstrap must fail closed
        now = datetime(2026, 11, 24, 5, 0, 0, tzinfo=timezone.utc)
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=[],
            verified_bootstrap=False,
            current_time=now,
        )
        self.assertTrue(skip, "Unverified empty history must fail closed")
        self.assertEqual(cohorts, [])

        # Missing token or repo in fetch_workflow_runs_and_jobs must raise GateVerificationError
        with self.assertRaises(GateVerificationError):
            fetch_workflow_runs_and_jobs(repo_full_name="", token="some-token")
        with self.assertRaises(GateVerificationError):
            fetch_workflow_runs_and_jobs(repo_full_name="ORM-git/Carrier-hound", token="")

    def test_dry_run_success_cannot_suppress_stale_ingestion(self):
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
        # Run 10m ago was a dry-run success
        runs = [
            {
                "id": 101,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T05:50:00Z",
            }
        ]
        jobs_by_run_id = {
            101: [
                {"name": "Python ingestion [non-workday] (dry-run)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (dry-run)", "conclusion": "success"},
            ]
        }
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs,
            jobs_by_run_id=jobs_by_run_id,
            current_time=now,
        )
        # Because (dry-run) is not a production write, ingestion is still considered stale / unwritten!
        self.assertFalse(skip, "Fresh dry-run success must NOT suppress stale ingestion")
        self.assertEqual(cohorts, ["non-workday", "workday"])
        self.assertIn("Admission granted", reason)

    def test_other_branch_success_cannot_suppress_stale_ingestion(self):
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
        # Run 10m ago was on feature branch
        runs = [
            {
                "id": 102,
                "head_branch": "feat/other-branch",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T05:50:00Z",
            }
        ]
        jobs_by_run_id = {
            102: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "success"},
            ]
        }
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs,
            jobs_by_run_id=jobs_by_run_id,
            current_time=now,
        )
        self.assertFalse(skip, "Feature branch success must NOT suppress stale ingestion on main")
        self.assertEqual(cohorts, ["non-workday", "workday"])

    def test_repeated_skipped_runs_cannot_refresh_success(self):
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
        # Several recent runs were skipped by watchdog gate (no ingest jobs ran)
        runs = [
            {
                "id": 201,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T05:55:00Z",
            },
            {
                "id": 200,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T05:40:00Z",
            },
        ]
        # Only plan ran, no production write jobs exist
        jobs_by_run_id = {
            201: [{"name": "Validate run plan", "conclusion": "success"}],
            200: [{"name": "Validate run plan", "conclusion": "success"}],
        }
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs,
            jobs_by_run_id=jobs_by_run_id,
            current_time=now,
        )
        self.assertFalse(skip, "Repeated skipped runs must not refresh success")
        self.assertEqual(cohorts, ["non-workday", "workday"])

    def test_one_healthy_cohort_cannot_conceal_the_other(self):
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
        # Run 301: 10m ago non-workday succeeded, workday failed
        # Run 300: 350m ago both succeeded
        runs = [
            {
                "id": 301,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "failure",
                "updated_at": "2026-11-24T05:50:00Z",
            },
            {
                "id": 300,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T00:10:00Z",
            },
        ]
        jobs_by_run_id = {
            301: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "failure"},
            ],
            300: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "success"},
            ],
        }

        # Case A: Workday attempted 10m ago (< 45m attempt cooldown) -> attempt cooldown blocks rapid loop
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs,
            jobs_by_run_id=jobs_by_run_id,
            current_time=now,
        )
        self.assertTrue(skip)
        self.assertIn("Attempt cooldown active", reason)
        self.assertIn("workday", reason)

        # Case B: Now is 50m after the failure (outside 45m attempt cooldown)
        now_later = now + timedelta(minutes=45)
        skip_later, reason_later, cohorts_later = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs,
            jobs_by_run_id=jobs_by_run_id,
            current_time=now_later,
        )
        # Admission granted ONLY for workday! non-workday is healthy and must NOT be rewritten!
        self.assertFalse(skip_later)
        self.assertEqual(cohorts_later, ["workday"])
        self.assertIn("Admission granted for cohort(s) ['workday']", reason_later)

    def test_stale_success_plus_recent_attempt_skips(self):
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
        # Last success was 400m ago (stale), but a catch-up attempt was made 15m ago and failed
        runs = [
            {
                "id": 401,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "failure",
                "updated_at": "2026-11-24T05:45:00Z",  # 15m ago
            },
            {
                "id": 400,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T00:00:00Z",  # 360m ago
            },
        ]
        jobs_by_run_id = {
            401: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "failure"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "failure"},
            ],
            400: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "success"},
            ],
        }
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs,
            jobs_by_run_id=jobs_by_run_id,
            current_time=now,
        )
        self.assertTrue(skip)
        self.assertIn("Attempt cooldown active", reason)
        self.assertEqual(cohorts, [])

    def test_queued_duplicate_serialization_mock(self):
        """
        Simulates:
        1. Run 1 starts.
        2. Watchdog dispatched Run 2, which queues behind Run 1.
        3. Run 1 finishes successfully at T=15m.
        4. Run 2 acquires concurrency lock at T=15m and evaluates admission gate.
        5. Gate sees Run 1 finished successfully at T=15m (< 195m cooldown).
        6. Gate sets skip=true, preventing duplicate execution and redundant DB writes!
        """
        t0 = datetime(2026, 11, 24, 2, 0, 0, tzinfo=timezone.utc)
        t_finish_run1 = t0 + timedelta(minutes=15)
        t_admit_run2 = t_finish_run1 + timedelta(seconds=10)

        runs = [
            {
                "id": 501,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": t_finish_run1.strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
        ]
        jobs_by_run_id = {
            501: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "success"},
            ]
        }

        skip_run2, reason_run2, cohorts_run2 = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs,
            jobs_by_run_id=jobs_by_run_id,
            current_time=t_admit_run2,
        )
        self.assertTrue(skip_run2)
        self.assertIn("Redundant watchdog dispatch", reason_run2)
        self.assertEqual(cohorts_run2, [])

    @patch("urllib.request.urlopen")
    def test_fetch_runs_and_jobs_api_errors_fail_closed(self, mock_urlopen):
        # 401 Unauthorized
        mock_urlopen.side_effect = urllib.error.HTTPError("https://api.github.com", 401, "Unauthorized", {}, None)
        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("401", str(ctx.exception))

        # 403 Forbidden
        mock_urlopen.side_effect = urllib.error.HTTPError("https://api.github.com", 403, "Forbidden", {}, None)
        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("403", str(ctx.exception))

        # 429 Rate Limit
        mock_urlopen.side_effect = urllib.error.HTTPError("https://api.github.com", 429, "Too Many Requests", {}, None)
        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("429", str(ctx.exception))

        # Timeout
        mock_urlopen.side_effect = TimeoutError("Connection timed out")
        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("timed out", str(ctx.exception))

    @patch("urllib.request.urlopen")
    def test_fetch_runs_and_jobs_malformed_json_fails_closed(self, mock_urlopen):
        # Invalid JSON
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = b"<html>Not JSON</html>"
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertTrue("Expecting value" in str(ctx.exception) or "JSON" in str(ctx.exception))

        # Missing workflow_runs
        mock_resp.read.return_value = b'{"status": "ok"}'
        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("missing 'workflow_runs'", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
