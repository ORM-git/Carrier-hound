"""
watchdog_gate.py - Concurrency-serialized admission gate for python-ingest workflow.

When a scheduled or catch-up watchdog dispatches python-ingest.yml, this gate executes
inside the 'plan' job AFTER the workflow acquires the 'ingest-pipeline' concurrency lock.

Safe & Truthful Guarantees:
1. Concurrency admission runs strictly AFTER acquiring existing ingest-pipeline lock.
2. Fails CLOSED when credentials, history, or cohort reports cannot be verified
   (missing token/repo, 401/403/429/timeout, malformed history/jobs).
3. Distinguishes verified first-run bootstrap (API 200 with zero runs) from API failures.
4. Derives freshness from verified production-write cohort jobs on main, not generic green status.
5. Tracks both cohorts independently (non-workday and workday); dry-runs, skip-only,
   and other-branch runs are strictly excluded from production freshness.
6. Enforces bounded attempt cooldown separate from success freshness to prevent
   rapid retry loops after failure, and prevents rewriting a healthy cohort.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any, Tuple, List, Dict, Optional


DEFAULT_SUCCESS_COOLDOWN_SECONDS = 195 * 60  # 3 hours 15 minutes (cadence is 4h)
DEFAULT_ATTEMPT_COOLDOWN_SECONDS = 45 * 60   # 45 minutes attempt backoff


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


def fetch_workflow_runs_and_jobs(
    repo_full_name: str,
    token: str,
    branch: str = "main",
    workflow_file: str = "python-ingest.yml",
    api_url: str = "https://api.github.com",
    per_page: int = 15,
) -> Tuple[List[Dict[str, Any]], Dict[int, List[Dict[str, Any]]], bool]:
    """
    Queries GitHub Actions API for completed workflow runs on branch, and fetches
    the job steps for each run.

    Returns:
        (runs, jobs_by_run_id, is_verified_bootstrap)
    Raises:
        GateVerificationError on any API failure, rate limit, timeout, or malformed JSON.
    """
    if not repo_full_name or not token:
        raise GateVerificationError("Missing GITHUB_REPOSITORY or GITHUB_TOKEN: cannot verify history.")

    runs_url = f"{api_url.rstrip('/')}/repos/{repo_full_name}/actions/workflows/{workflow_file}/runs?branch={branch}&status=completed&per_page={per_page}"
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
        raise GateVerificationError(f"GitHub API error fetching runs: {e}") from e

    if not isinstance(data, dict) or "workflow_runs" not in data:
        raise GateVerificationError("Malformed GitHub API response: missing 'workflow_runs' field.")

    raw_runs = data.get("workflow_runs", [])
    if not isinstance(raw_runs, list):
        raise GateVerificationError("Malformed GitHub API response: 'workflow_runs' is not a list.")

    # Filter strictly to runs on target branch
    runs = [r for r in raw_runs if isinstance(r, dict) and r.get("head_branch") == branch]

    # Check for verified first-run bootstrap
    total_count = data.get("total_count", len(raw_runs))
    if total_count == 0 or len(runs) == 0:
        return [], {}, True

    jobs_by_run_id: Dict[int, List[Dict[str, Any]]] = {}

    for r in runs:
        run_id = r.get("id")
        if not run_id:
            continue

        jobs_url = f"{api_url.rstrip('/')}/repos/{repo_full_name}/actions/runs/{run_id}/jobs"
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
            raise GateVerificationError(f"Failed to fetch jobs for run #{run_id}: {e}") from e

        if not isinstance(jdata, dict) or "jobs" not in jdata:
            raise GateVerificationError(f"Malformed jobs API response for run #{run_id}.")

        jobs_list = jdata.get("jobs", [])
        if not isinstance(jobs_list, list):
            raise GateVerificationError(f"Malformed jobs list for run #{run_id}.")

        jobs_by_run_id[run_id] = jobs_list

    return runs, jobs_by_run_id, False


def evaluate_watchdog_admission(
    is_watchdog: bool,
    runs: List[Dict[str, Any]],
    jobs_by_run_id: Optional[Dict[int, List[Dict[str, Any]]]] = None,
    target_cohort: str = "both",
    current_time: Optional[datetime] = None,
    success_cooldown_seconds: int = DEFAULT_SUCCESS_COOLDOWN_SECONDS,
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

        # If jobs are not available but run has a conclusion, inspect job names or fallback safely
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

            # Note: jobs matching "(dry-run)" or skip-only runs have no prod_job and are ignored!

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
            if 0 <= success_age_sec < success_cooldown_seconds:
                is_fresh = True
                cooldown_min = int(success_cooldown_seconds // 60)
                age_min = int(success_age_sec // 60)
                reasons.append(f"Cohort '{c}' succeeded {age_min}m ago (within {cooldown_min}m success cooldown).")

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

    success_cooldown_min = os.environ.get("COOLDOWN_MINUTES", "").strip()
    success_cooldown_seconds = (
        int(success_cooldown_min) * 60
        if success_cooldown_min.isdigit()
        else DEFAULT_SUCCESS_COOLDOWN_SECONDS
    )

    attempt_cooldown_min = os.environ.get("ATTEMPT_COOLDOWN_MINUTES", "").strip()
    attempt_cooldown_seconds = (
        int(attempt_cooldown_min) * 60
        if attempt_cooldown_min.isdigit()
        else DEFAULT_ATTEMPT_COOLDOWN_SECONDS
    )

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
        success_cooldown_seconds=success_cooldown_seconds,
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
