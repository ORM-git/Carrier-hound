"""
test_watchdog_gate.py - Unit and duplicate-dispatch mock tests for watchdog admission gate.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone, timedelta
from scripts.scraper.watchdog_gate import (
    evaluate_watchdog_admission,
    parse_iso8601,
    DEFAULT_COOLDOWN_SECONDS,
)


class TestWatchdogGate(unittest.TestCase):

    def test_parse_iso8601(self):
        self.assertIsNone(parse_iso8601(""))
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
        recent_runs = [
            {
                "id": 1001,
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T04:55:00Z",  # 5 min ago
            }
        ]
        skip, reason = evaluate_watchdog_admission(
            is_watchdog=False,
            recent_runs=recent_runs,
            current_time=now,
        )
        self.assertFalse(skip)
        self.assertIn("Not a watchdog catch-up run", reason)

    def test_watchdog_empty_or_failed_runs_admitted(self):
        now = datetime(2026, 11, 24, 5, 0, 0, tzinfo=timezone.utc)
        # No runs
        skip, _ = evaluate_watchdog_admission(
            is_watchdog=True,
            recent_runs=[],
            current_time=now,
        )
        self.assertFalse(skip)

        # Only failed runs
        recent_runs = [
            {
                "id": 1002,
                "status": "completed",
                "conclusion": "failure",
                "updated_at": "2026-11-24T04:50:00Z",
            }
        ]
        skip, reason = evaluate_watchdog_admission(
            is_watchdog=True,
            recent_runs=recent_runs,
            current_time=now,
        )
        self.assertFalse(skip)
        self.assertIn("Admission granted", reason)

    def test_watchdog_skips_when_recent_success_within_cooldown(self):
        now = datetime(2026, 11, 24, 5, 0, 0, tzinfo=timezone.utc)
        # Completed 30 minutes ago (within 195 min cooldown)
        recent_runs = [
            {
                "id": 2001,
                "status": "completed",
                "conclusion": "success",
                "updated_at": "2026-11-24T04:30:00Z",
            }
        ]
        skip, reason = evaluate_watchdog_admission(
            is_watchdog=True,
            recent_runs=recent_runs,
            current_time=now,
            cooldown_seconds=195 * 60,
        )
        self.assertTrue(skip)
        self.assertIn("Redundant watchdog dispatch", reason)
        self.assertIn("2001", reason)
        self.assertIn("30m ago", reason)

    def test_watchdog_admits_when_success_is_older_than_cooldown(self):
        now = datetime(2026, 11, 24, 5, 0, 0, tzinfo=timezone.utc)
        # Completed 200 minutes ago (beyond 195 min cooldown)
        completed_at = (now - timedelta(minutes=200)).strftime("%Y-%m-%dT%H:%M:%SZ")
        recent_runs = [
            {
                "id": 3001,
                "status": "completed",
                "conclusion": "success",
                "updated_at": completed_at,
            }
        ]
        skip, reason = evaluate_watchdog_admission(
            is_watchdog=True,
            recent_runs=recent_runs,
            current_time=now,
            cooldown_seconds=195 * 60,
        )
        self.assertFalse(skip)
        self.assertIn("Admission granted", reason)

    def test_duplicate_dispatch_concurrency_serialization_mock(self):
        """
        Simulates:
        1. Run 1 starts at T=0.
        2. Watchdog worker fires at T=10m, detects no recent run completed, and dispatches Run 2.
           Run 2 enters GitHub Actions queue behind Run 1 (ingest-pipeline concurrency group, max-parallel: 1).
        3. Run 1 finishes successfully at T=15m.
        4. Run 2 acquires concurrency at T=15m and enters 'plan' admission gate.
        5. Gate inspects recent runs: sees Run 1 finished successfully at T=15m (0m ago).
        6. Gate sets skip=true, preventing redundant ingestion execution and duplicate writes!
        """
        t0 = datetime(2026, 11, 24, 2, 0, 0, tzinfo=timezone.utc)
        t_finish_run1 = t0 + timedelta(minutes=15)
        t_admit_run2 = t_finish_run1 + timedelta(seconds=10)

        run1_completed = {
            "id": "run-1-cron",
            "status": "completed",
            "conclusion": "success",
            "updated_at": t_finish_run1.strftime("%Y-%m-%dT%H:%M:%SZ"),
        }

        # When Run 2 evaluates:
        skip_run2, reason_run2 = evaluate_watchdog_admission(
            is_watchdog=True,
            recent_runs=[run1_completed],
            current_time=t_admit_run2,
            cooldown_seconds=195 * 60,
        )
        self.assertTrue(skip_run2, "Queued duplicate watchdog dispatch must be skipped after Run 1 success")
        self.assertIn("Redundant watchdog dispatch", reason_run2)
        self.assertIn("run-1-cron", reason_run2)


if __name__ == "__main__":
    unittest.main()
