"""Failure headings in the cohort summary must match the guard that actually ran (reporting only, offline)."""

from __future__ import annotations

import unittest

from scripts.scraper import ingest_report

WHOLE_COHORT = "this cohort's writes and expiry withheld"


def workday_report(guard: str, failed: list[str], persisted: dict, deferred: list[str] | None = None) -> dict:
    return {
        "dry_run": False,
        "selected_sources": ["workday:a", "workday:b", "workday:deloitte"],
        "completed_sources": [s for s in ("workday:a", "workday:b") if s not in failed + (deferred or [])],
        "failed_sources": [{"source": s, "source_type": "workday", "error": "HTTP 429 Too Many Requests"} for s in failed],
        "deferred_sources": [{"source": s, "reason": "cooldown", "next_eligible_at": None} for s in deferred or []],
        "persisted_counts": persisted,
        "db": {"persistence_failed": False, "failed_writes": 0, "expired": 0},
        "guard_block_reason": guard,
    }


def render(report: dict, exit_code: str, cohort: str = "workday") -> str:
    return ingest_report.render_cohort(ingest_report.cohort_summary(report, exit_code, cohort))


# Shape of run 45810986130: completed Workday boards saved (12 inserted, 28 updated); Deloitte hit a 429.
ISOLATED = workday_report(
    "workday_isolated: 1 failed Workday board(s) wrote nothing; completed boards were written; Workday never expires",
    failed=["workday:deloitte"],
    persisted={"inserted": 12, "updated": 28, "unchanged": 3},
)
WITHHELD = {
    **workday_report(
        "write_withheld: 1 failed source(s) in this run; no inserts, updates, company sync or expiry",
        failed=[],
        persisted={"inserted": 0, "updated": 0, "unchanged": 0},
    ),
    "failed_sources": [{"source": "greenhouse:acme", "source_type": "greenhouse", "error": "HTTP 500"}],
}
ALL_WORKDAY_FAILED = workday_report(
    "write_withheld: all 3 attempted Workday board(s) failed; nothing written",
    failed=["workday:a", "workday:b", "workday:deloitte"],
    persisted={"inserted": 0, "updated": 0, "unchanged": 0},
)
NOOP = workday_report(
    "noop_deferred: no Workday board was fetched and persisted this run (3 deferred); not a successful write",
    failed=[],
    persisted={"inserted": 0, "updated": 0, "unchanged": 0},
    deferred=["workday:a", "workday:b", "workday:deloitte"],
)


class FailureHeadingTests(unittest.TestCase):
    def test_isolated_board_failure_says_only_failed_boards_saved_nothing(self):
        text = render(ISOLATED, "1")
        self.assertIn("Failed Workday boards (isolated): these boards saved nothing", text)
        self.assertIn("completed boards may have saved", text)
        self.assertIn("Workday never expires jobs", text)
        self.assertIn("`workday:deloitte`: HTTP 429", text)
        self.assertIn("| confirmed inserted | 12 |", text)
        self.assertIn("| confirmed updated | 28 |", text)

    def test_isolated_negative_control_never_claims_the_whole_cohort_was_withheld(self):
        text = render(ISOLATED, "1")
        self.assertNotIn(WHOLE_COHORT, text)
        self.assertNotIn("nothing written", text.lower().split("| guard |")[0])

    def test_whole_cohort_wording_only_when_that_guard_withheld_everything(self):
        for name, report in (("blocking non-Workday failure", WITHHELD), ("every Workday board failed", ALL_WORKDAY_FAILED)):
            with self.subTest(name):
                text = render(report, "1")
                self.assertIn(WHOLE_COHORT, text)
                self.assertNotIn("completed boards may have saved", text)

    def test_all_deferred_noop_is_never_presented_as_a_successful_completed_run(self):
        text = render(NOOP, "3")
        self.assertIn("DEFERRED_NOOP (exit 3)", text)
        self.assertIn("No-op: every selected Workday board was deferred; nothing was written. Not a successful run.", text)
        self.assertNotIn(WHOLE_COHORT, text)
        self.assertNotIn(": OK (", text)

    def test_noop_negative_control_holds_even_if_the_exit_code_were_zero(self):
        # The heading follows the guard, so a mislabelled exit code cannot make a no-op read as success.
        text = render(NOOP, "0")
        self.assertIn("Not a successful run.", text)

    def test_noop_deferred_with_exit_zero_is_not_ok_in_summary_heading_annotation_and_aggregate(self):
        summary = ingest_report.cohort_summary(NOOP, "0", "workday")
        self.assertEqual(summary["status"], "deferred_noop")
        self.assertEqual(summary["exit_code"], "0")
        text = ingest_report.render_cohort(summary)
        self.assertIn("DEFERRED_NOOP (exit 0)", text)
        self.assertNotIn(": OK (", text)
        self.assertTrue(any("Ingestion no-op [workday]" in a for a in ingest_report.annotations(summary)))
        overall, table = ingest_report.aggregate([summary], ["workday"])
        self.assertNotEqual(overall, "ok")
        self.assertIn("| workday | deferred_noop |", table)
        overall, _ = ingest_report.aggregate(
            [summary, ingest_report.cohort_summary(None, "0", "non-workday")], ["workday", "non-workday"])
        self.assertEqual(overall, "failed")

    def test_exit_codes_and_clean_success_keep_their_status(self):
        clean = workday_report("", failed=[], persisted={"inserted": 12, "updated": 28, "unchanged": 0})
        clean["guard_block_reason"] = None
        self.assertEqual(ingest_report.cohort_summary(clean, "0", "workday")["status"], "ok")
        self.assertEqual(ingest_report.cohort_summary(NOOP, "3", "workday")["status"], "deferred_noop")
        self.assertEqual(ingest_report.cohort_summary(ISOLATED, "1", "workday")["status"], "failed")
        self.assertEqual(ingest_report.cohort_summary(NOOP, "1", "workday")["status"], "failed")
        self.assertEqual(ingest_report.cohort_summary(None, "0", "workday")["status"], "no_report")
        self.assertEqual(ingest_report.cohort_summary(None, "", "workday")["status"], "no_report")

    def test_clean_run_has_no_failure_or_noop_heading(self):
        clean = workday_report("", failed=[], persisted={"inserted": 5, "updated": 1, "unchanged": 0})
        clean["guard_block_reason"] = None
        text = render(clean, "0")
        self.assertNotIn("Failed", text)
        self.assertNotIn("No-op", text)
        self.assertNotIn(WHOLE_COHORT, text)


if __name__ == "__main__":
    unittest.main()
