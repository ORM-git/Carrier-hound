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
    parse_bounded_timing,
    GateVerificationError,
    DEFAULT_OVERDUE_THRESHOLD_SECONDS,
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

    def test_parse_bounded_timing(self):
        self.assertEqual(parse_bounded_timing(None, 240, "CADENCE", 15, 1440), 240)
        self.assertEqual(parse_bounded_timing("", 240, "CADENCE", 15, 1440), 240)
        self.assertEqual(parse_bounded_timing("60", 240, "CADENCE", 15, 1440), 60)

        # Invalid string
        with self.assertRaises(GateVerificationError):
            parse_bounded_timing("not-a-number", 240, "CADENCE", 15, 1440)

        # Under min
        with self.assertRaises(GateVerificationError):
            parse_bounded_timing("10", 240, "CADENCE", 15, 1440)

        # Over max (excessive timing)
        with self.assertRaises(GateVerificationError):
            parse_bounded_timing("2000", 240, "CADENCE", 15, 1440)

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
        now = datetime(2026, 11, 24, 5, 0, 0, tzinfo=timezone.utc)
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=[],
            verified_bootstrap=False,
            current_time=now,
        )
        self.assertTrue(skip, "Unverified empty history must fail closed")
        self.assertEqual(cohorts, [])

        with self.assertRaises(GateVerificationError):
            fetch_workflow_runs_and_jobs(repo_full_name="", token="some-token")
        with self.assertRaises(GateVerificationError):
            fetch_workflow_runs_and_jobs(repo_full_name="ORM-git/Carrier-hound", token="")

    def test_two_hundred_minute_old_successful_cohort_never_rewritten(self):
        """
        Shared cadence/grace: 240 + 45 = 285 min.
        A cohort that succeeded 200 min ago is fresh (< 285m) and must NOT be rewritten!
        """
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
        runs = [
            {
                "id": 100,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T02:40:00Z",  # 200 min ago
            }
        ]
        jobs_by_run_id = {
            100: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "success"},
            ]
        }
        skip, reason, cohorts = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs,
            jobs_by_run_id=jobs_by_run_id,
            current_time=now,
            success_cooldown_seconds=285 * 60,
        )
        self.assertTrue(skip, "200m old successful run is fresh (< 285m) and must not be rewritten")
        self.assertEqual(cohorts, [])
        self.assertIn("Redundant watchdog dispatch", reason)

    def test_exact_threshold_boundary(self):
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
        # Exactly 284m ago: fresh (inside 285m window)
        runs_fresh = [
            {
                "id": 101,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T01:16:00Z",  # 284m ago
            }
        ]
        jobs_fresh = {
            101: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "success"},
            ]
        }
        skip_fresh, _, cohorts_fresh = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs_fresh,
            jobs_by_run_id=jobs_fresh,
            current_time=now,
            success_cooldown_seconds=285 * 60,
        )
        self.assertTrue(skip_fresh)
        self.assertEqual(cohorts_fresh, [])

        # 286m ago: overdue (outside 285m window)
        runs_overdue = [
            {
                "id": 102,
                "head_branch": "main",
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T01:14:00Z",  # 286m ago
            }
        ]
        jobs_overdue = {
            102: [
                {"name": "Python ingestion [non-workday] (write-production-expire)", "conclusion": "success"},
                {"name": "Python ingestion [workday] (write-production-expire)", "conclusion": "success"},
            ]
        }
        skip_overdue, _, cohorts_overdue = evaluate_watchdog_admission(
            is_watchdog=True,
            runs=runs_overdue,
            jobs_by_run_id=jobs_overdue,
            current_time=now,
            success_cooldown_seconds=285 * 60,
        )
        self.assertFalse(skip_overdue)
        self.assertEqual(cohorts_overdue, ["non-workday", "workday"])

    def test_dry_run_success_cannot_suppress_stale_ingestion(self):
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
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
        self.assertFalse(skip, "Fresh dry-run success must NOT suppress stale ingestion")
        self.assertEqual(cohorts, ["non-workday", "workday"])
        self.assertIn("Admission granted", reason)

    def test_other_branch_success_cannot_suppress_stale_ingestion(self):
        now = datetime(2026, 11, 24, 6, 0, 0, tzinfo=timezone.utc)
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
    def test_fetch_runs_and_jobs_schema_validation_failures(self, mock_urlopen):
        # 1. API 200 {} (empty object)
        mock_resp = MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = b"{}"
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("missing or malformed 'workflow_runs'", str(ctx.exception))

        # 2. Wrong field types (workflow_runs is string)
        mock_resp.read.return_value = b'{"workflow_runs": "not-a-list", "total_count": 0}'
        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("missing or malformed 'workflow_runs'", str(ctx.exception))

        # 3. Nonzero total_count with empty page
        mock_resp.read.return_value = b'{"workflow_runs": [], "total_count": 5}'
        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("Inconsistent runs API response: nonzero total_count", str(ctx.exception))

    @patch("urllib.request.urlopen")
    def test_fetch_runs_and_jobs_empty_jobs_fails_closed(self, mock_urlopen):
        mock_runs_resp = MagicMock()
        mock_runs_resp.status = 200
        mock_runs_resp.read.return_value = json.dumps({
            "total_count": 1,
            "workflow_runs": [
                {"id": 999, "head_branch": "main", "status": "completed", "conclusion": "failure"}
            ]
        }).encode("utf-8")

        mock_jobs_resp = MagicMock()
        mock_jobs_resp.status = 200
        mock_jobs_resp.read.return_value = json.dumps({
            "jobs": []  # Empty jobs list for a completed run
        }).encode("utf-8")

        mock_urlopen.return_value.__enter__.side_effect = [mock_runs_resp, mock_jobs_resp]

        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("empty jobs list", str(ctx.exception))

    @patch("urllib.request.urlopen")
    def test_pagination_failure_fails_closed(self, mock_urlopen):
        # Page 1 succeeds with 30 runs, total_count 100
        mock_page1 = MagicMock()
        mock_page1.status = 200
        mock_page1.read.return_value = json.dumps({
            "total_count": 100,
            "workflow_runs": [
                {"id": i, "head_branch": "feat/other", "status": "completed", "conclusion": "success"}
                for i in range(1, 31)
            ]
        }).encode("utf-8")

        # Page 2 fails with 500
        mock_page2_err = urllib.error.HTTPError("https://api.github.com", 500, "Internal Server Error", {}, None)

        mock_urlopen.side_effect = [
            MagicMock(__enter__=MagicMock(return_value=mock_page1)),
            mock_page2_err,
        ]

        with self.assertRaises(GateVerificationError) as ctx:
            fetch_workflow_runs_and_jobs("ORM-git/Carrier-hound", "token")
        self.assertIn("500", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
