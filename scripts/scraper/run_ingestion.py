"""
Master CLI Runner for the 3-Layer High-Volume Job Ingestion Engine.

Features:
- `--source` filtering (`all`, `layer1`, `layer2`, `layer3`, `greenhouse`, `lever`,
  `ashby`, `smartrecruiters`, `workday`, `amazon`, `microsoft`, `jobspy`,
  `arbeitnow`, `adzuna`, or a specific company slug).
- `--cohort workday|non-workday`: independent runs that partition every planned source by type (no
  overlap, no omission); unknown filters, unknown cohorts and empty selections are refused.
- Strict per-source error isolation (one failing board never crashes the batch).
- Tracks per-source completeness and failures in the run report.
- Expiry is disabled by default. Explicit --expire enables it for uncapped write runs;
  partial-coverage, incomplete, or failed boards remain vetoed.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Awaitable, Callable

import httpx

from .engine import (
    DEFAULT_SEEDS_PATH,
    SupabaseSetDiffWriter,
    WriteAuthorizationError,
    add_write_mode_arguments,
    dry_run_from_args,
    fetch_layer1_seed,
    load_company_seeds,
    load_dotenv_into_env,
    partition_set_diff,
    resolve_write_credentials,
    select_unique_jobs,
    validate_row_cap,
    ingestion_has_errors,
)
from .fetch_aggregators_and_india import (
    fetch_adzuna,
    fetch_arbeitnow,
    fetch_jobspy_india,
)
from . import fetchers as fetchers_mod, workday_schedule
from .fetchers import (
    WorkdayRateLimited,
    fetch_amazon_jobs,
    fetch_microsoft_jobs,
    fetch_workday_cxs,
    enrich_greenhouse_pay_transparency,
)
from .persistence import prevalidate_jobs
from .rate_limiter import PerHostRateLimiter, redact_sensitive_params

PARTIAL_COVERAGE_SOURCES: frozenset[str] = frozenset({"workday", "amazon", "microsoft", "arbeitnow", "smartrecruiters", "jobspy", "adzuna"})


def evaluate_count_drop_guard(
    persisted_count: int,
    baseline_active_count: int,
    *,
    source_name: str = "all",
    min_ratio: float = 0.5,
) -> dict[str, Any]:
    """
    Per-source 50% count-drop guard before expiring old jobs.
    Blocks expiration if baseline query returned <= 0 or if persisted_count < baseline * 0.5.
    """
    if baseline_active_count <= 0:
        return {
            "allowed": False,
            "source": source_name,
            "persisted_count": persisted_count,
            "baseline_active_count": baseline_active_count,
            "reason": f"Baseline count query failed or returned no baseline for {source_name}; skipping expiration.",
        }
    ratio = persisted_count / float(baseline_active_count)
    if ratio < min_ratio:
        return {
            "allowed": False,
            "source": source_name,
            "persisted_count": persisted_count,
            "baseline_active_count": baseline_active_count,
            "ratio": round(ratio, 4),
            "reason": (
                f"50% count-drop guard triggered for {source_name}: persisted {persisted_count} vs "
                f"baseline {baseline_active_count} ({ratio:.1%} < {min_ratio:.0%}). Aborting expiration."
            ),
        }
    return {
        "allowed": True,
        "source": source_name,
        "persisted_count": persisted_count,
        "baseline_active_count": baseline_active_count,
        "ratio": round(ratio, 4),
        "reason": f"Healthy volume for {source_name} ({ratio:.1%} >= {min_ratio:.0%}); expiration allowed.",
    }


async def run_isolated_source(
    source_id: str,
    source_type: str,
    coro_factory: Callable[[], Awaitable[Any]],
    *,
    is_full_coverage: bool = True,
) -> dict[str, Any]:
    """Executes a single source coroutine with complete error isolation."""
    try:
        raw_result = await coro_factory()
        if isinstance(raw_result, tuple) and len(raw_result) == 2:
            jobs, error_msg = raw_result
        else:
            jobs, error_msg = raw_result, None

        has_error = error_msg is not None
        return {
            "source": source_id,
            "source_type": source_type,
            "status": "failed" if has_error else "ok",
            "completed": not has_error,
            "is_full_coverage": is_full_coverage and not has_error,
            "fetched": len(jobs) if isinstance(jobs, list) else 0,
            "jobs": jobs if isinstance(jobs, list) else [],
            "error": redact_sensitive_params(error_msg) if error_msg else None,
        }
    except Exception as exc:
        clean_err = redact_sensitive_params(str(exc))
        return {
            "source": source_id,
            "source_type": source_type,
            "status": "failed",
            "completed": False,
            "is_full_coverage": False,
            "fetched": 0,
            "jobs": [],
            "error": f"{type(exc).__name__}: {clean_err}",
        }


def _matches_source_filter(source_filter: set[str], *candidates: str) -> bool:
    if "all" in source_filter:
        return True
    lower_candidates = {c.lower().strip() for c in candidates if c}
    return bool(source_filter & lower_candidates)


class SourceSelectionError(ValueError):
    """Unknown, empty or contradictory source/cohort selection: refuse instead of guessing."""


# Independent execution cohorts. Membership is decided by source_type only (never by slug/alias), so the
# two cohorts partition every planned source exactly: no overlap, no omission, new sources land somewhere.
COHORTS: dict[str, Callable[[str], bool]] = {
    "workday": lambda source_type: source_type == "workday",
    "non-workday": lambda source_type: source_type != "workday",
}


def plan_sources(config: dict[str, Any]) -> list[dict[str, Any]]:
    """Every source this seed config can schedule, with the filter aliases that select it."""
    plan: list[dict[str, Any]] = []
    for s in config.get("layer1_public_ats") or []:
        ats = str(s.get("ats") or "").lower()
        slug = str(s.get("slug") or "").lower()
        board_id = f"{ats}:{slug}"
        plan.append({"id": board_id, "type": ats, "full": ats != "smartrecruiters", "kind": "layer1",
                     "seed": s, "aliases": {"layer1", ats, slug, board_id}})
    layer2_cfg = config.get("layer2_enterprise_json") or {}
    for wd in layer2_cfg.get("workday_cxs") or []:
        slug = str(wd.get("slug") or "").lower()
        board_id = f"workday:{slug}"
        plan.append({"id": board_id, "type": "workday", "full": False, "kind": "workday",
                     "seed": wd, "aliases": {"layer2", "workday", slug, board_id}})
    for name in ("amazon", "microsoft"):
        if name in layer2_cfg:
            plan.append({"id": name, "type": name, "full": False, "kind": name,
                         "seed": layer2_cfg[name], "aliases": {"layer2", name}})
    plan.append({"id": "jobspy:india", "type": "jobspy", "full": False, "kind": "jobspy",
                 "seed": None, "aliases": {"layer3", "jobspy", "india"}})
    plan.append({"id": "arbeitnow", "type": "arbeitnow", "full": False, "kind": "arbeitnow",
                 "seed": None, "aliases": {"layer3", "arbeitnow"}})
    plan.append({"id": "adzuna:in", "type": "adzuna", "full": False, "kind": "adzuna",
                 "seed": None, "aliases": {"layer3", "adzuna"}})
    return plan


def normalize_source_filter(
    sources: list[str] | set[str] | tuple[str, ...] | None,
    cohort: str | None = None,
) -> set[str]:
    """
    Normalizes and validates source filter tokens.
    - None defaults to {"all"}.
    - Explicit --cohort and --source together: reject (even if source was empty/whitespace).
    - Explicit empty collection (sources=[] or set()), empty token ('', '   '), or containing
      empty comma segments (',', ',greenhouse', 'greenhouse,'): reject with SourceSelectionError.
    - Strips whitespace and lowercases valid tokens.
    """
    if cohort is not None and sources is not None:
        raise SourceSelectionError("--cohort cannot be combined with --source")

    if sources is None:
        return {"all"}

    if len(sources) == 0:
        raise SourceSelectionError("explicit empty source filter supplied; omit --source for default all")

    tokens: set[str] = set()
    for item in sources:
        if not isinstance(item, str):
            item = str(item)
        if not item.strip():
            raise SourceSelectionError("empty or whitespace source filter token is invalid")
        segments = item.split(",")
        for seg in segments:
            stripped = seg.strip()
            if not stripped:
                raise SourceSelectionError(f"source filter contains empty comma segment: {item!r}")
            tokens.add(stripped.lower())

    if not tokens:
        raise SourceSelectionError("source filter resulted in an empty selection")

    return tokens


def select_sources(plan: list[dict[str, Any]], source_filter: set[str], cohort: str | None) -> list[dict[str, Any]]:
    """Validated, deterministic selection. Unknown tokens, unknown cohorts and empty results are errors."""
    known = {"all"}.union(*(p["aliases"] for p in plan)) if plan else {"all"}
    unknown = sorted(source_filter - known)
    if unknown:
        raise SourceSelectionError(f"unknown source filter(s): {', '.join(unknown)}")
    if cohort is not None:
        if cohort not in COHORTS:
            raise SourceSelectionError(f"unknown cohort {cohort!r}; expected one of: {', '.join(sorted(COHORTS))}")
        if source_filter != {"all"}:
            raise SourceSelectionError("--cohort cannot be combined with --source")
    selected = [
        p for p in plan
        if ("all" in source_filter or source_filter & p["aliases"])
        and (cohort is None or COHORTS[cohort](p["type"]))
    ]
    if not selected:
        raise SourceSelectionError("source selection is empty; refusing a run that would cover nothing")
    return selected


async def run_master_ingestion(
    *,
    sources: list[str] | None = None,
    seeds_path: str | Path = DEFAULT_SEEDS_PATH,
    dry_run: bool = True,
    max_rows: int | None = None,
    no_expire: bool = True,
    allow_uncapped: bool = False,
    allow_expire: bool = False,
    baseline_active_count: int = 0,
    expire_stale_hours: int = 72,
    transport: httpx.AsyncBaseTransport | None = None,
    jobspy_scrape_fn: Callable[..., Any] | None = None,
    cohort: str | None = None,
) -> dict[str, Any]:
    """
    Runs selected ingestion layers/sources with per-source error isolation,
    safe set-diff upserts; expiry requires an explicit opt-in on an uncapped write.
    """
    validate_row_cap(
        dry_run=dry_run, max_rows=max_rows, no_expire=no_expire,
        allow_uncapped=allow_uncapped, allow_expire=allow_expire,
    )
    load_dotenv_into_env()
    credentials = None if dry_run else resolve_write_credentials()  # fail closed before any fetch
    source_filter = normalize_source_filter(sources, cohort)

    config = load_company_seeds(seeds_path)
    rl_cfg = config.get("rate_limit") or {}
    limiter = PerHostRateLimiter(
        default_rps=float(rl_cfg.get("default_rps_per_host", 4.0)),
        burst=float(rl_cfg.get("burst_per_host", 1.0)),
    )

    layer1_seeds = list(config.get("layer1_public_ats") or [])
    plan = plan_sources(config)
    known = {"all"}.union(*(p["aliases"] for p in plan)) if plan else {"all"}
    unknown = sorted(source_filter - known)
    if unknown:
        raise SourceSelectionError(f"unknown source filter(s): {', '.join(unknown)}")
    selected_plan = select_sources(plan, source_filter, cohort)
    started_at = datetime.now(timezone.utc).isoformat()

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(25.0),
        follow_redirects=True,
        transport=transport,
        headers={"User-Agent": "CareerHound-HighVolumeIngest/1.0"},
    ) as client:
        def factory(p: dict[str, Any]) -> Callable[[], Awaitable[Any]]:
            kind, seed = p["kind"], p["seed"]
            if kind == "layer1":
                return lambda: fetch_layer1_seed(client, limiter, seed)
            if kind == "workday":  # partial coverage, max_pages=1
                return lambda: fetch_workday_cxs(client, limiter, seed, max_pages=1)
            if kind == "amazon":
                return lambda: fetch_amazon_jobs(client, limiter, seed, max_pages=1)
            if kind == "microsoft":
                return lambda: fetch_microsoft_jobs(client, limiter, seed, max_pages=1)
            if kind == "jobspy":
                return lambda: fetch_jobspy_india()
            if kind == "arbeitnow":
                return lambda: fetch_arbeitnow(client, limiter, max_pages=1)
            if kind == "adzuna":
                return lambda: fetch_adzuna(client, limiter)
            raise SourceSelectionError(f"no fetcher for source kind {kind!r}")

        # Workday: persistent per-board cooldown + fair rotation; boards run one at a time inside a run budget.
        wd_plan = {p["id"]: p for p in selected_plan if p["type"] == "workday"}
        wd_lim = workday_schedule.limits()
        wd_state_path = os.environ.get("WORKDAY_STATE_PATH") or None
        wd_boards, wd_state_status = workday_schedule.load_state(wd_state_path) if wd_plan else ({}, "unused")
        wd_chosen, wd_deferred = (
            workday_schedule.plan_boards(list(wd_plan), wd_boards, wd_state_status, datetime.now(timezone.utc), wd_lim)
            if wd_plan else ([], [])
        )

        async def run_workday_boards() -> list[dict[str, Any]]:
            reports: list[dict[str, Any]] = []
            started = time.monotonic()
            per_board_worst = fetchers_mod.get_workday_tenant_spacing_seconds() + fetchers_mod.WORKDAY_MAX_BACKOFF_PER_PAGE_SECONDS
            for i, sid in enumerate(wd_chosen):
                cooldown = fetchers_mod._WORKDAY_COOLDOWN_UNTIL - time.monotonic()
                if cooldown > fetchers_mod.WORKDAY_MAX_COOLDOWN_SECONDS:  # an earlier board hit a long 429
                    until = datetime.now(timezone.utc) + timedelta(seconds=cooldown)
                    for rest in wd_chosen[i:]:
                        workday_schedule.defer_until(wd_boards, rest, until, "workday cooldown (429 this run)")
                        wd_deferred.append({"source": rest, "reason": "workday cooldown (429 this run)", "next_eligible_at": until.isoformat()})
                    break
                if time.monotonic() - started + per_board_worst > wd_lim["run_budget_seconds"]:
                    wd_deferred.extend({"source": rest, "reason": "run budget", "next_eligible_at": None} for rest in wd_chosen[i:])
                    break
                seen: dict[str, Any] = {}

                async def fetch(seed: dict[str, Any] = wd_plan[sid]["seed"], seen: dict[str, Any] = seen) -> Any:
                    try:
                        return await fetch_workday_cxs(client, limiter, seed, max_pages=1)
                    except WorkdayRateLimited as exc:
                        seen["retry_after"] = exc.retry_after
                        raise

                rep = await run_isolated_source(sid, "workday", fetch, is_full_coverage=False)
                workday_schedule.record_attempt(
                    wd_boards, sid, datetime.now(timezone.utc), wd_lim, ok=rep["completed"],
                    reason="rate_limited" if "retry_after" in seen else (rep["error"] or "failed")[:80],
                    retry_after=seen.get("retry_after"),
                )
                reports.append(rep)
            workday_schedule.save_state(wd_state_path, wd_boards)  # cooldowns persist even if writes fail later
            return reports

        other_tasks = [
            asyncio.create_task(run_isolated_source(p["id"], p["type"], factory(p), is_full_coverage=p["full"]))
            for p in selected_plan if p["type"] != "workday"
        ]
        other_reports, workday_reports = await asyncio.gather(asyncio.gather(*other_tasks), run_workday_boards())
        task_reports = [*other_reports, *workday_reports]

        all_jobs: list[dict[str, Any]] = []
        source_reports: list[dict[str, Any]] = []
        failed_sources: list[dict[str, str]] = []
        board_status_map: dict[str, dict[str, Any]] = {}

        for rep in task_reports:
            bsid = rep["source"]
            st = rep["source_type"]
            if rep["completed"] or st != "workday":  # a failed Workday board contributes nothing
                all_jobs.extend(rep["jobs"])
            source_reports.append(
                {
                    "source": bsid,
                    "source_id": bsid,
                    "source_type": st,
                    "status": rep["status"],
                    "completed": rep["completed"],
                    "is_full_coverage": rep["is_full_coverage"],
                    "fetched": rep["fetched"],
                    "error": rep["error"],
                }
            )
            if not rep["completed"] or rep["status"] == "failed":
                failed_sources.append({"source": bsid, "source_type": st, "error": rep["error"] or "Board incomplete or failed"})

            board_status_map[bsid] = {
                "source_id": bsid,
                "source_type": st,
                "completed": rep["completed"],
                "is_full_coverage": rep["is_full_coverage"],
                "error": rep["error"],
                "fetched_jobs": rep["jobs"],
            }

        fetched_count = len(all_jobs)
        all_jobs, rejected = prevalidate_jobs(all_jobs)  # before dedupe: dedupe ranks on int(source_priority)
        validated_count = len(all_jobs)
        unique_jobs = select_unique_jobs(all_jobs, None)
        all_jobs = unique_jobs if max_rows is None else unique_jobs[:max_rows]
        selected_count = len(all_jobs)
        for seed in layer1_seeds:
            if (seed.get("ats") or "").lower() != "greenhouse":
                continue
            greenhouse_seed = {**seed, "token": seed.get("token") or seed.get("slug")}
            board_source_id = f"greenhouse:{greenhouse_seed['token']}"
            try:
                await enrich_greenhouse_pay_transparency(
                    client, limiter, greenhouse_seed,
                    [job for job in all_jobs if job.get("source_id") == board_source_id],
                )
            except Exception as exc:
                error = redact_sensitive_params(str(exc))
                failed_sources.append({"source": board_source_id, "error": error})
                for source_report in source_reports:
                    if source_report["source_id"] == board_source_id:
                        source_report.update({"status": "failed", "completed": False, "error": error})
                if board_source_id in board_status_map:
                    board_status_map[board_source_id].update({"completed": False, "error": error})
        to_insert, to_update, unchanged = partition_set_diff(all_jobs, [])
        projected_counts = {"inserted": len(to_insert), "updated": len(to_update), "unchanged": len(unchanged)}
        db_stats: dict[str, Any] = {
            "inserted": len(to_insert),
            "updated": len(to_update),
            "skipped_unchanged": len(unchanged),
            "expired": 0,
            "failed_writes": 0,
            "persistence_failed": False,
            "write_errors": [],
            "persisted_ids": [],
        }

        # The non-Workday guard is unchanged: any failed non-Workday source withholds every write. A failed
        # Workday board only withholds itself (its rows were never added); completed boards still write.
        blocking_failures = [f for f in failed_sources if f.get("source_type") != "workday"]
        writes_attempted = credentials is not None and not blocking_failures and bool(all_jobs or not failed_sources)
        if not writes_attempted:
            db_stats.update({"inserted": 0, "updated": 0, "skipped_unchanged": 0})
        else:
            writer = SupabaseSetDiffWriter(*credentials)
            company_map = await writer.sync_companies(client, all_jobs)
            if writer.persistence_failed:
                db_stats.update({
                    "inserted": 0,
                    "updated": 0,
                    "skipped_unchanged": 0,
                    "failed_writes": writer.failed_writes,
                    "persistence_failed": True,
                    "write_errors": list(writer.write_errors),
                })
            else:
                sync_res = await writer.sync_jobs_set_diff(client, all_jobs, company_map)
                db_stats.update(sync_res)

        # Expiration safety checks:
        # 1. Any persistence failure vetos expiry completely.
        # 2. Expiry is scoped strictly per board (source_id), never whole-vendor.
        # 3. With --source, only scheduled boards are in board_status_map; unscheduled boards are never touched.
        # 4. Workday, Amazon, Microsoft, Arbeitnow, SmartRecruiters are partial coverage -> never expire.
        # 5. Incomplete or failed boards -> skip expiry for that board.
        # 6. Baseline query failure / null -> skip expiry for that board (never treat as 0).
        # 7. Per-board 50% drop guard -> skip if persisted < baseline * 0.5.
        expiry_vetoed = db_stats.get("persistence_failed", False)
        expiry_reports: list[dict[str, Any]] = []
        rejected += list(db_stats.get("rejected") or [])
        # A board with any rejected (unpersisted) row is not fully persisted: never expire on its behalf.
        for item in rejected:
            if item["source_id"] in board_status_map and not board_status_map[item["source_id"]]["error"]:
                board_status_map[item["source_id"]]["error"] = "rows rejected before persistence"

        if credentials is not None and not no_expire and not expiry_vetoed:
            writer = SupabaseSetDiffWriter(*credentials)
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=expire_stale_hours)).isoformat()
            persisted_keys = set(tuple(k) for k in db_stats.get("persisted_source_keys") or [])

            for bsid, b_info in board_status_map.items():
                st = b_info["source_type"]

                if not b_info["completed"] or b_info["error"]:
                    expiry_reports.append({
                        "source_id": bsid,
                        "source_type": st,
                        "expired": 0,
                        "status": "skipped_incomplete_source",
                        "reason": f"Board {bsid} had errors or incomplete fetch ({b_info['error']}).",
                    })
                    continue

                if not b_info["is_full_coverage"] or st in PARTIAL_COVERAGE_SOURCES or bsid in PARTIAL_COVERAGE_SOURCES:
                    expiry_reports.append({
                        "source_id": bsid,
                        "source_type": st,
                        "expired": 0,
                        "status": "skipped_partial_coverage",
                        "reason": f"Board {bsid} is partial coverage; stale expiry is disabled.",
                    })
                    continue

                # Query baseline count for this exact board (source_id)
                try:
                    cnt_resp = await client.get(
                        f"{writer.base_url}/jobs",
                        params={
                            "select": "id",
                            "is_active": "eq.true",
                            "source_id": f"eq.{bsid}",
                            "limit": "1",
                        },
                        headers={**writer.headers, "Prefer": "count=exact"},
                    )
                    content_range = cnt_resp.headers.get("content-range") or ""
                    if cnt_resp.status_code == 200 and "/" in content_range and content_range.split("/")[-1].isdigit():
                        board_baseline = int(content_range.split("/")[-1])
                    else:
                        board_baseline = None
                except Exception as exc:
                    board_baseline = None

                if board_baseline is None or board_baseline <= 0:
                    expiry_reports.append({
                        "source_id": bsid,
                        "source_type": st,
                        "expired": 0,
                        "status": "skipped_no_baseline",
                        "reason": f"Baseline query failed or returned no baseline for {bsid}; skipping expiration.",
                    })
                    continue

                # Count only DISTINCT confirmed persisted (source_id, source_job_id) keys for this board.
                # Zero persisted keys means 0, never fall back to raw fetch length.
                board_persisted_keys = {
                    (str(j.get("source_id") or ""), str(j.get("source_job_id") or ""))
                    for j in b_info["fetched_jobs"]
                    if str(j.get("source_id") or "") == bsid
                    and (str(j.get("source_id") or ""), str(j.get("source_job_id") or "")) in persisted_keys
                }
                persisted_board_count = len(board_persisted_keys)

                guard = evaluate_count_drop_guard(persisted_board_count, board_baseline, source_name=bsid, min_ratio=0.5)

                if not guard["allowed"]:
                    expiry_reports.append({
                        "source_id": bsid,
                        "source_type": st,
                        "expired": 0,
                        "status": "skipped_drop_guard",
                        "guard": guard,
                    })
                    continue

                # Run safe per-board stale job expiration
                try:
                    exp_resp = await client.patch(
                        f"{writer.base_url}/jobs",
                        params={
                            "is_active": "eq.true",
                            "source_id": f"eq.{bsid}",
                            "last_seen_at": f"lt.{cutoff}",
                        },
                        headers={**writer.headers, "Prefer": "return=representation"},
                        json={"is_active": False, "status": "expired"},
                    )
                    if exp_resp.status_code >= 300:
                        raise RuntimeError(f"HTTP {exp_resp.status_code}: {exp_resp.text}")
                    response_rows = exp_resp.json()
                    if not isinstance(response_rows, list) or any(not isinstance(row, dict) for row in response_rows):
                        raise ValueError("invalid expiry response: expected a JSON array of job rows")
                    exp_count = len(response_rows)
                    db_stats["expired"] += exp_count
                    expiry_reports.append({
                        "source_id": bsid,
                        "source_type": st,
                        "expired": exp_count,
                        "status": "completed",
                    })
                except Exception as exc:
                    expiry_reports.append({
                        "source_id": bsid,
                        "source_type": st,
                        "expired": 0,
                        "status": "failed",
                        "error": redact_sensitive_params(str(exc)),
                    })

        # Per-source confirmed counts (by exact source identity, never inferred from fetched rows).
        key_sets = {name: {tuple(k) for k in db_stats.get(name) or []}
                    for name in ("inserted_source_keys", "updated_source_keys", "persisted_source_keys")}
        rejected_keys = {r["source_key"] for r in rejected}
        now_dt = datetime.now(timezone.utc)
        for rep, src in zip(task_reports, source_reports):
            keys = {(str(j.get("source_id") or ""), str(j.get("source_job_id") or "")) for j in rep["jobs"]}
            rej = sum(1 for k in keys if f"{k[0]}/{k[1]}"[:160] in rejected_keys)
            src.update(validated=len(keys) - rej, rejected=rej,
                       inserted=len(keys & key_sets["inserted_source_keys"]), updated=len(keys & key_sets["updated_source_keys"]))
            if (src["source_type"] == "workday" and rep["completed"] and writes_attempted and not rej
                    and not db_stats.get("persistence_failed") and keys <= key_sets["persisted_source_keys"]):
                workday_schedule.mark_persisted(wd_boards, src["source"], now_dt)
        for src in source_reports:
            if src["source_type"] == "workday":
                entry = wd_boards.get(src["source"], {})
                src.update(next_eligible_at=entry.get("next_eligible_at"), last_success_at=entry.get("last_success_at"),
                           cooldown_reason=entry.get("last_reason"))
        if wd_plan:
            workday_schedule.save_state(wd_state_path, wd_boards)

        category_counts: dict[str, int] = {}
        for j in to_insert:
            cat = str(j.get("company_category") or "OTHER_STARTUPS")
            category_counts[cat] = category_counts.get(cat, 0) + 1

        greenhouse_jobs = [
            job for report in task_reports if report["source_type"] == "greenhouse"
            for job in report["jobs"]
        ]
        greenhouse_inspection = {
            "fetched": len(greenhouse_jobs),
            "salary_known": sum(job.get("salary_min") is not None or job.get("salary_max") is not None for job in greenhouse_jobs),
            "salary_null": sum(job.get("salary_min") is None and job.get("salary_max") is None for job in greenhouse_jobs),
            "country_known": sum(bool(job.get("country_code")) for job in greenhouse_jobs),
            "country_unknown": sum(not job.get("country_code") for job in greenhouse_jobs),
            "posted_at_known": sum(bool(job.get("posted_at")) for job in greenhouse_jobs),
            "posted_at_unknown": sum(not job.get("posted_at") for job in greenhouse_jobs),
            "descriptions_over_4000": sum(len(job.get("description") or "") > 4000 for job in greenhouse_jobs),
            "description_tail_samples": [
                {"source_job_id": job.get("source_job_id"), "characters": len(job.get("description") or ""),
                 "tail": (job.get("description") or "")[-160:]}
                for job in greenhouse_jobs if len(job.get("description") or "") > 4000
            ][:3],
            "date_samples": [
                {"source_job_id": job.get("source_job_id"), "posted_at": job.get("posted_at"),
                 "last_seen_at": job.get("last_seen_at")}
                for job in greenhouse_jobs[:5]
            ],
            "identity_samples": [
                {"source_id": job.get("source_id"), "source_job_id": job.get("source_job_id"),
                 "dedupe_hash": job.get("dedupe_hash"), "apply_url": job.get("apply_url")}
                for job in greenhouse_jobs[:5]
            ],
        }

        if dry_run:
            guard_block_reason = "dry_run: projections only, nothing was written or expired"
        elif blocking_failures:
            guard_block_reason = (
                f"write_withheld: {len(failed_sources)} failed source(s) in this run; "
                "no inserts, updates, company sync or expiry"
            )
        elif failed_sources and not writes_attempted:
            guard_block_reason = f"write_withheld: all {len(failed_sources)} attempted Workday board(s) failed; nothing written"
        elif db_stats.get("persistence_failed"):
            guard_block_reason = "persistence_failed: writes stopped and expiry vetoed"
        elif failed_sources:
            guard_block_reason = (
                f"workday_isolated: {len(failed_sources)} failed Workday board(s) wrote nothing; "
                "completed boards were written; Workday never expires"
            )
        else:
            guard_block_reason = None
        failed_ids = {f["source"] for f in failed_sources}
        return {
            "cohort": cohort or ("all" if source_filter == {"all"} else "custom"),
            "git_sha": os.environ.get("GITHUB_SHA") or None,
            "started_at": started_at,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "selected_sources": [p["id"] for p in selected_plan],
            "completed_sources": [r["source"] for r in source_reports if r["source"] not in failed_ids],
            "deferred_sources": wd_deferred,
            "workday": None if not wd_plan else {
                "state_status": wd_state_status,
                "selected": len(wd_plan),
                "attempted": len(workday_reports),
                "completed": sum(1 for r in workday_reports if r["completed"]),
                "failed": sum(1 for r in workday_reports if not r["completed"]),
                "deferred": len(wd_deferred),
                "request_cap": len(wd_chosen) * (fetchers_mod.WORKDAY_MAX_RETRIES + 1),  # 1 page/board, bounded retries
                "limits": wd_lim,
            },
            "guard_block_reason": guard_block_reason,
            "dry_run": dry_run,
            "fetched": fetched_count,
            "selected": selected_count,
            "validated": validated_count,
            "rejected": rejected[:200],
            "rejected_count": len(rejected),
            "skipped_by_cap": max(0, len(unique_jobs) - selected_count),
            "projected_counts": projected_counts,
            "persisted_counts": None if dry_run else {
                "inserted": db_stats["inserted"],
                "updated": db_stats["updated"],
                "unchanged": db_stats["skipped_unchanged"],
            },
            "sources_requested": sorted(source_filter),
            "total_fetched": fetched_count,
            "category_breakdown": category_counts,
            "db": db_stats,
            "expiry_vetoed": expiry_vetoed,
            "expiry_reports": expiry_reports,
            "failed_sources": failed_sources,
            "sources": source_reports,
            "greenhouse_inspection": greenhouse_inspection,
            "logo_enqueue": (
                getattr(writer, "logo_enqueue", None)
                if "writer" in locals() and writer is not None
                else None
            ) or {"requested": 0, "enqueued": 0, "status": "skipped", "coverage": None},
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Master CLI Runner for 3-Layer High-Volume Ingestion")
    parser.add_argument(
        "--source",
        action="append",
        default=None,
        help="Source filter: all, layer1, layer2, layer3, greenhouse, lever, ashby, smartrecruiters, workday, amazon, microsoft, jobspy, arbeitnow, adzuna, or slug",
    )
    parser.add_argument(
        "--cohort",
        choices=sorted(COHORTS),
        default=None,
        help="Independent cohort: workday or non-workday (exact partition by source type; not combinable with --source)",
    )
    add_write_mode_arguments(parser)
    parser.add_argument("--baseline-count", type=int, default=0, help="Baseline active job count for 50%% drop guard")
    args = parser.parse_args()

    try:
        dry_run = dry_run_from_args(args)
        validate_row_cap(
            dry_run=dry_run, max_rows=args.max_rows, no_expire=args.no_expire,
            allow_uncapped=args.production, allow_expire=not args.no_expire,
        )
        report = asyncio.run(
            run_master_ingestion(
                sources=args.source,
                dry_run=dry_run,
                max_rows=args.max_rows,
                no_expire=args.no_expire,
                allow_uncapped=args.production,
                allow_expire=not args.no_expire,
                baseline_active_count=args.baseline_count,
                cohort=args.cohort,
            )
        )
    except (WriteAuthorizationError, SourceSelectionError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps(report, indent=2))
    if ingestion_has_errors(report):
        print("ingestion failed: source, persistence, or expiry errors were reported", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
