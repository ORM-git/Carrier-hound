"""
watchdog_gate.py - Concurrency-serialized admission gate for python-ingest workflow.

When a scheduled or catch-up watchdog dispatches python-ingest.yml, this gate executes
inside the 'plan' job AFTER the workflow acquires the 'ingest-pipeline' concurrency lock.

Because concurrency is serialized (max-parallel: 1, cancel-in-progress: false), any
prior run has finished before this gate runs. The gate re-reads recent completed workflow
runs / cohort outcomes from the GitHub Actions API and skips redundant catch-up runs
if a successful ingestion completed within the bounded cooldown window (default: 195m = 3h15m).

Zero database migrations. Zero KV/Durable Object assumptions. Safety lives inside the
serialized workflow.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from typing import Any, Tuple, List, Dict, Optional


DEFAULT_COOLDOWN_SECONDS = 195 * 60  # 3 hours 15 minutes (cadence is 4h)


def parse_iso8601(dt_str: str) -> Optional[datetime]:
    if not dt_str:
        return None
    try:
        # Standard ISO 8601: e.g. "2026-11-24T01:09:11Z"
        clean = dt_str.replace("Z", "+00:00")
        return datetime.fromisoformat(clean).astimezone(timezone.utc)
    except Exception:
        return None


def evaluate_watchdog_admission(
    is_watchdog: bool,
    recent_runs: List[Dict[str, Any]],
    current_time: Optional[datetime] = None,
    cooldown_seconds: int = DEFAULT_COOLDOWN_SECONDS,
) -> Tuple[bool, str]:
    """
    Evaluates whether a watchdog catch-up run should be admitted or skipped.

    Returns:
        (should_skip: bool, reason: str)
    """
    if not is_watchdog:
        return False, "Not a watchdog catch-up run; admission granted."

    now = current_time or datetime.now(timezone.utc)

    for run in recent_runs:
        status = str(run.get("status", "")).lower()
        conclusion = str(run.get("conclusion", "")).lower()

        # Only evaluate completed successful runs
        if status == "completed" and conclusion == "success":
            # Prefer updated_at (completion time) over created_at / run_started_at
            completed_str = run.get("updated_at") or run.get("completed_at") or run.get("run_started_at")
            completed_dt = parse_iso8601(completed_str)
            if not completed_dt:
                continue

            age_seconds = (now - completed_dt).total_seconds()
            run_id = run.get("id") or run.get("databaseId") or "unknown"

            # Check if within cooldown window
            if 0 <= age_seconds < cooldown_seconds:
                age_minutes = int(age_seconds // 60)
                cooldown_minutes = int(cooldown_seconds // 60)
                return (
                    True,
                    f"Redundant watchdog dispatch: successful run #{run_id} completed {age_minutes}m ago "
                    f"(within {cooldown_minutes}m cooldown window). Skipping execution.",
                )

    cooldown_minutes = int(cooldown_seconds // 60)
    return False, f"No successful run found within {cooldown_minutes}m cooldown window. Admission granted."


def fetch_recent_workflow_runs(
    repo_full_name: str,
    token: str,
    workflow_file: str = "python-ingest.yml",
    api_url: str = "https://api.github.com",
    per_page: int = 10,
) -> List[Dict[str, Any]]:
    """
    Queries GitHub Actions API for recent workflow runs.
    """
    url = f"{api_url.rstrip('/')}/repos/{repo_full_name}/actions/workflows/{workflow_file}/runs?status=completed&per_page={per_page}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "ingest-watchdog-admission-gate",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("workflow_runs", [])
    except Exception as e:
        print(f"::warning::Watchdog gate: failed to fetch recent runs from GitHub API: {e}", file=sys.stderr)
        return []


def main() -> int:
    event_name = os.environ.get("EVENT", "workflow_dispatch")
    is_watchdog_env = os.environ.get("IS_WATCHDOG", "false").strip().lower()
    is_watchdog = is_watchdog_env in ("true", "1", "yes")

    cooldown_min_env = os.environ.get("COOLDOWN_MINUTES", "").strip()
    cooldown_seconds = int(cooldown_min_env) * 60 if cooldown_min_env.isdigit() else DEFAULT_COOLDOWN_SECONDS

    github_token = os.environ.get("GITHUB_TOKEN", "").strip()
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com").strip()

    recent_runs: List[Dict[str, Any]] = []

    if is_watchdog and github_token and repo:
        recent_runs = fetch_recent_workflow_runs(repo, github_token, api_url=api_url)

    should_skip, reason = evaluate_watchdog_admission(
        is_watchdog=is_watchdog,
        recent_runs=recent_runs,
        cooldown_seconds=cooldown_seconds,
    )

    print(f"[Watchdog Admission Gate] skip={should_skip}")
    print(f"[Watchdog Admission Gate] reason={reason}")

    # Output to GITHUB_OUTPUT if available
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path and os.path.exists(output_path):
        with open(output_path, "a", encoding="utf-8") as f:
            f.write(f"skip={'true' if should_skip else 'false'}\n")
            # Escaping newlines for GitHub Action outputs
            escaped_reason = reason.replace("\n", " ").replace("\r", "")
            f.write(f"skip_reason={escaped_reason}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
