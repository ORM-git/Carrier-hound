"""
watchdog_gate.py - Concurrency-serialized admission gate for python-ingest workflow.

When a scheduled or catch-up watchdog dispatches python-ingest.yml, this gate executes
inside the 'plan' job AFTER the workflow acquires the 'ingest-pipeline' concurrency lock.

Safe & Truthful Guarantees:
1. Concurrency admission runs strictly AFTER acquiring existing ingest-pipeline lock.
2. Fails CLOSED when credentials, history, or cohort reports cannot be verified
   (missing token/repo, 401/403/429/timeout, malformed history/jobs, empty jobs).
3. Distinguishes verified first-run bootstrap (API 200 with zero runs) from API failures.
4. Derives freshness from verified production-write cohort jobs on main, not generic green status.
5. Tracks both cohorts independently (non-workday and workday); dry-runs, skip-only,
   and other-branch runs are strictly excluded from production freshness.
6. Enforces bounded attempt cooldown (45m) separate from success freshness (285m = 240m cadence + 45m grace).
7. A 200-minute-old successful cohort is fresh (< 285m) and is NEVER rewritten.
8. Paginates with explicit bounds (max 3 pages); fails closed if bounds block verification.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any, Tuple, List, Dict, Optional


DEFAULT_CADENCE_MINUTES = 240
DEFAULT_OVERDUE_GRACE_MINUTES = 45
DEFAULT_OVERDUE_THRESHOLD_SECONDS = (DEFAULT_CADENCE_MINUTES + DEFAULT_OVERDUE_GRACE_MINUTES) * 60  # 285 min = 17,100s
DEFAULT_ATTEMPT_COOLDOWN_SECONDS = 45 * 60  # 45 minutes = 2,700s


class GateVerificationError(Exception):
    """Raised when credentials, history, or job reports cannot be verified."""
    pass


def parse_iso8601(dt_str: Optional[str]) -> Optional[datetime]:
    if not dt_str:
        return None
    try:
        clean = dt_str.replace("Z", "+00:00")
        return datetime.fromisoformat(clean).astimezone(timezone.utc)
    except Exception:
        return None


def parse_bounded_timing(val: Optional[str], default_val: int, name: str, min_val: int, max_val: int) -> int:
    if val is None or val.strip() == "":
        return default_val
    try:
        n = int(val.strip())
        if n < min_val or n > max_val:
            raise GateVerificationError(
                f"Invalid timing value for {name}: must be an integer between {min_val} and {max_val}, got '{val}'"
            )
        return n
    except ValueError as e:
        raise GateVerificationError(
            f"Invalid timing value for {name}: must be an integer, got '{val}'"
        ) from e


def fetch_workflow_runs_and_jobs(
    repo_full_name: str,
    token: str,
    branch: str = "main",
    workflow_file: str = "python-ingest.yml",
    api_url: str = "https://api.github.com",
    per_page: int = 30,
    max_pages: int = 3,
) -> Tuple[List[Dict[str, Any]], Dict[int, List[Dict[str, Any]]], bool]:
    """
    Queries GitHub Actions API for workflow runs on branch, paginates with explicit bounds,
    and fetches job steps for each run.

    Returns:
        (runs, jobs_by_run_id, is_verified_bootstrap)
    Raises:
        GateVerificationError on any API failure, rate limit, timeout, malformed JSON, or empty jobs.
    """
    if not repo_full_name or not token:
        raise GateVerificationError("Missing GITHUB_REPOSITORY or GITHUB_TOKEN: cannot verify history.")

    all_runs: List[Dict[str, Any]] = []
    total_count = 0
    page = 1

    while page <= max_pages:
        runs_url = f"{api_url.rstrip('/')}/repos/{repo_full_name}/actions/workflows/{workflow_file}/runs?branch={branch}&per_page={per_page}&page={page}"
        req = urllib.request.Request(
            runs_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "ingest-watchdog-admission-gate",
            },
        )

        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status != 200:
                    raise GateVerificationError(f"GitHub API returned HTTP {resp.status} fetching runs.")
                raw = resp.read().decode("utf-8")
                data = json.loads(raw)
        except urllib.error.HTTPError as e:
            raise GateVerificationError(f"GitHub API HTTP {e.code} fetching runs: {e.reason}") from e
        except urllib.error.URLError as e:
            raise GateVerificationError(f"GitHub API network error fetching runs: {e.reason}") from e
        except Exception as e:
            if isinstance(e, GateVerificationError):
                raise
            raise GateVerificationError(f"GitHub API error fetching runs: {e}") from e

        if not isinstance(data, dict):
            raise GateVerificationError("Malformed GitHub API response: expected object, got non-object.")
        if "workflow_runs" not in data or not isinstance(data["workflow_runs"], list):
            raise GateVerificationError("Malformed GitHub API response: missing or malformed 'workflow_runs' list.")
        if "total_count" not in data or not isinstance(data["total_count"], (int, float)):
            raise GateVerificationError("Malformed GitHub API response: missing or malformed 'total_count'.")

        total_count = int(data["total_count"])
        page_runs = data["workflow_runs"]

        # Detect inconsistent API state: nonzero total_count with empty page
        if page == 1 and total_count > 0 and len(page_runs) == 0:
            raise GateVerificationError(f"Inconsistent runs API response: nonzero total_count ({total_count}) with empty page.")

        for r in page_runs:
            if not isinstance(r, dict):
                raise GateVerificationError("Invalid run schema: run entry is not a dict.")
            if not isinstance(r.get("id"), (int, float)) or not isinstance(r.get("head_branch"), str) or not isinstance(r.get("status"), str):
                raise GateVerificationError(f"Invalid run schema: missing required fields in run #{r.get('id')}.")
            all_runs.append(r)

        if len(page_runs) < per_page or len(all_runs) >= total_count:
            break
        page += 1

    # Filter strictly to runs on target branch (main)
    runs = [r for r in all_runs if r.get("head_branch") == branch]

    # Inconsistent evidence check:
    # Foreign-branch entries in branch-scoped response, or total_count > 0 with zero matching main runs
    has_foreign_branches = any(r.get("head_branch") != branch for r in all_runs)
    if has_foreign_branches or (total_count > 0 and len(runs) == 0):
        raise GateVerificationError(
            f"Inconsistent runs evidence: branch-scoped response contains foreign-branch entries or "
            f"total_count > 0 ({total_count}) with zero matching runs on {branch}; failing closed."
        )

    # Check for verified first-run bootstrap: ONLY when total_count == 0 AND complete history is empty
    is_verified_bootstrap = (total_count == 0 and len(all_runs) == 0)

    # Fail closed if pagination bound blocked verification without finding main runs
    if not is_verified_bootstrap and len(runs) == 0 and len(all_runs) < total_count:
        raise GateVerificationError(
            f"History verification truncated at pagination bound (max {max_pages} pages, {len(all_runs)}/{total_count} runs); failing closed."
        )

    jobs_by_run_id: Dict[int, List[Dict[str, Any]]] = {}

    for r in runs:
        run_id = r.get("id")
        if not run_id:
            continue

        jobs_url = f"{api_url.rstrip('/')}/repos/{repo_full_name}/actions/runs/{run_id}/jobs?per_page=100"
        jreq = urllib.request.Request(
            jobs_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "ingest-watchdog-admission-gate",
            },
        )
        try:
            with urllib.request.urlopen(jreq, timeout=15) as jresp:
                if jresp.status != 200:
                    raise GateVerificationError(f"GitHub API returned HTTP {jresp.status} fetching jobs for run #{run_id}.")
                jraw = jresp.read().decode("utf-8")
                jdata = json.loads(jraw)
        except Exception as e:
            if isinstance(e, GateVerificationError):
                raise
            raise GateVerificationError(f"Failed to fetch jobs for run #{run_id}: {e}") from e

        if not isinstance(jdata, dict) or "jobs" not in jdata:
            raise GateVerificationError(f"Malformed jobs API response for run #{run_id}.")

        jobs_list = jdata.get("jobs", [])
        if not isinstance(jobs_list, list):
            raise GateVerificationError(f"Malformed jobs list for run #{run_id}.")

        # Completed run must have non-empty jobs
        if r.get("status") == "completed" and len(jobs_list) == 0:
            raise GateVerificationError(f"Unverifiable history: completed run #{run_id} has empty jobs list.")

        for j in jobs_list:
            if not isinstance(j, dict) or not isinstance(j.get("name"), str) or not isinstance(j.get("status"), str):
                raise GateVerificationError(f"Invalid job schema in run #{run_id}: missing name or status.")

        jobs_by_run_id[run_id] = jobs_list

    return runs, jobs_by_run_id, is_verified_bootstrap


def evaluate_watchdog_admission(
    is_watchdog: bool,
    runs: List[Dict[str, Any]],
    jobs_by_run_id: Optional[Dict[int, List[Dict[str, Any]]]] = None,
    target_cohort: str = "both",
    current_time: Optional[datetime] = None,
    success_cooldown_seconds: int = DEFAULT_OVERDUE_THRESHOLD_SECONDS,
    attempt_cooldown_seconds: int = DEFAULT_ATTEMPT_COOLDOWN_SECONDS,
    verified_bootstrap: bool = False,
) -> Tuple[bool, str, List[str]]:
    """
    Evaluates whether a watchdog catch-up run should be admitted or skipped.

    Returns:
        (should_skip: bool, reason: str, cohorts_to_run: List[str])
    """
    all_cohorts = ["non-workday", "workday"]
    requested_cohorts = all_cohorts if target_cohort == "both" else [target_cohort]

    if not is_watchdog:
        return False, "Not a watchdog catch-up run; admission granted.", requested_cohorts

    if verified_bootstrap:
        return False, "Verified first-run bootstrap on main with no prior history; admission granted.", requested_cohorts

    if not runs and not verified_bootstrap:
        return True, "Fail-closed: Unverified empty history or missing runs; admission denied.", []

    now = current_time or datetime.now(timezone.utc)

    # Track independent latest success and latest attempt per cohort
    latest_success_time: Dict[str, datetime] = {}
    latest_attempt_time: Dict[str, datetime] = {}

    for run in runs:
        # Strict scope: head_branch must be main
        if run.get("head_branch") != "main":
            continue

        run_id = run.get("id")
        completed_str = run.get("updated_at") or run.get("completed_at") or run.get("run_started_at")
        run_dt = parse_iso8601(completed_str)
        if not run_dt:
            continue

        # Look up jobs for this run
        jobs = (jobs_by_run_id.get(run_id) if jobs_by_run_id else None) or []

        for c in all_cohorts:
            # Look for production write job: "Python ingestion [cohort] (write-production-expire)"
            prod_job = next(
                (
                    j for j in jobs
                    if f"[{c}]" in j.get("name", "") and "(write-production-expire)" in j.get("name", "")
                ),
                None,
            )

            if prod_job:
                # Track attempt
                if c not in latest_attempt_time or run_dt > latest_attempt_time[c]:
                    latest_attempt_time[c] = run_dt

                # Track success
                if prod_job.get("conclusion") == "success":
                    if c not in latest_success_time or run_dt > latest_success_time[c]:
                        latest_success_time[c] = run_dt

            # Note: jobs matching "(dry-run)" or skip-only runs have no prod_job and are ignored

    # Evaluate per requested cohort
    cohorts_to_run: List[str] = []
    reasons: List[str] = []
    attempt_cooldown_active = False

    for c in requested_cohorts:
        last_success = latest_success_time.get(c)
        last_attempt = latest_attempt_time.get(c)

        is_fresh = False
        if last_success:
            success_age_sec = (now - last_success).total_seconds()
            if 0 <= success_age_sec <= success_cooldown_seconds:
                is_fresh = True
                cooldown_min = int(success_cooldown_seconds // 60)
                age_min = int(success_age_sec // 60)
                reasons.append(f"Cohort '{c}' succeeded {age_min}m ago (within {cooldown_min}m threshold).")

        # A cohort that succeeded recently (e.g. 200m ago < 285m threshold) is fresh and never rewritten!
        if is_fresh:
            continue

        # Cohort is not fresh: check attempt cooldown
        if last_attempt:
            attempt_age_sec = (now - last_attempt).total_seconds()
            if 0 <= attempt_age_sec < attempt_cooldown_seconds:
                cooldown_min = int(attempt_cooldown_seconds // 60)
                age_min = int(attempt_age_sec // 60)
                reasons.append(f"Cohort '{c}' had attempt {age_min}m ago (within {cooldown_min}m attempt cooldown).")
                attempt_cooldown_active = True
                continue

        # Overdue and outside attempt cooldown
        cohorts_to_run.append(c)

    if not cohorts_to_run:
        summary_reason = " ".join(reasons)
        if attempt_cooldown_active:
            return True, f"Attempt cooldown active: {summary_reason} Skipping execution to prevent rapid retry loop.", []
        return True, f"Redundant watchdog dispatch: {summary_reason} Skipping execution.", []

    return False, f"Admission granted for cohort(s) {cohorts_to_run}. Overdue and outside attempt cooldown.", cohorts_to_run


def main() -> int:
    is_watchdog_env = os.environ.get("IS_WATCHDOG", "false").strip().lower()
    is_watchdog = is_watchdog_env in ("true", "1", "yes")

    target_cohort = os.environ.get("TARGET_COHORT", "both").strip()
    if target_cohort not in ("both", "non-workday", "workday"):
        target_cohort = "both"

    output_path = os.environ.get("GITHUB_OUTPUT")

    def write_output(skip: bool, reason: str, admitted_cohorts: List[str]) -> None:
        if output_path and os.path.exists(output_path):
            with open(output_path, "a", encoding="utf-8") as f:
                f.write(f"skip={'true' if skip else 'false'}\n")
                escaped_reason = reason.replace("\n", " ").replace("\r", "")
                f.write(f"skip_reason={escaped_reason}\n")
                f.write(f"admitted_cohorts={json.dumps(admitted_cohorts)}\n")

    if not is_watchdog:
        all_c = ["non-workday", "workday"] if target_cohort == "both" else [target_cohort]
        write_output(False, "Not a watchdog catch-up run; admission granted.", all_c)
        print("[Watchdog Admission Gate] Not a watchdog run. skip=false")
        return 0

    try:
        cadence_min = parse_bounded_timing(os.environ.get("CADENCE_MINUTES"), DEFAULT_CADENCE_MINUTES, "CADENCE_MINUTES", 15, 1440)
        grace_min = parse_bounded_timing(os.environ.get("OVERDUE_GRACE_MINUTES"), DEFAULT_OVERDUE_GRACE_MINUTES, "OVERDUE_GRACE_MINUTES", 0, 360)
        attempt_cooldown_min = parse_bounded_timing(os.environ.get("ATTEMPT_COOLDOWN_MINUTES"), 45, "ATTEMPT_COOLDOWN_MINUTES", 5, 360)
        overdue_threshold_seconds = (cadence_min + grace_min) * 60
        attempt_cooldown_seconds = attempt_cooldown_min * 60
    except GateVerificationError as e:
        err_msg = f"Fail-closed: {e}"
        print(f"::error title=Timing Configuration Error::{err_msg}", file=sys.stderr)
        write_output(True, err_msg, [])
        return 1

    github_token = os.environ.get("GITHUB_TOKEN", "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com").strip()

    if not github_token or not repo:
        err_msg = "Fail-closed: Missing GITHUB_TOKEN or GITHUB_REPOSITORY; cannot verify ingestion history."
        print(f"::error title=Admission Gate Failed::{err_msg}", file=sys.stderr)
        write_output(True, err_msg, [])
        return 1

    try:
        runs, jobs_by_run_id, is_bootstrap = fetch_workflow_runs_and_jobs(
            repo_full_name=repo,
            token=github_token,
            branch="main",
            api_url=api_url,
        )
    except GateVerificationError as e:
        err_msg = f"Fail-closed: {e}"
        print(f"::error title=Admission Gate Verification Failure::{err_msg}", file=sys.stderr)
        write_output(True, err_msg, [])
        return 1
    except Exception as e:
        err_msg = f"Fail-closed: Unexpected verification error: {e}"
        print(f"::error title=Admission Gate Error::{err_msg}", file=sys.stderr)
        write_output(True, err_msg, [])
        return 1

    should_skip, reason, cohorts_to_run = evaluate_watchdog_admission(
        is_watchdog=True,
        runs=runs,
        jobs_by_run_id=jobs_by_run_id,
        target_cohort=target_cohort,
        success_cooldown_seconds=overdue_threshold_seconds,
        attempt_cooldown_seconds=attempt_cooldown_seconds,
        verified_bootstrap=is_bootstrap,
    )

    print(f"[Watchdog Admission Gate] skip={should_skip}")
    print(f"[Watchdog Admission Gate] reason={reason}")
    print(f"[Watchdog Admission Gate] cohorts_to_run={cohorts_to_run}")

    write_output(should_skip, reason, cohorts_to_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
