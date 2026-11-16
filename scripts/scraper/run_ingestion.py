"""
Master CLI Runner for the 3-Layer High-Volume Job Ingestion Engine.

Features:
- `--source` filtering (`all`, `layer1`, `layer2`, `layer3`, `greenhouse`, `lever`,
  `ashby`, `smartrecruiters`, `workday`, `amazon`, `microsoft`, `jobspy`,
  `arbeitnow`, `adzuna`, or a specific company slug).
- Strict per-source error isolation (one failing board never crashes the batch).
- Tracks per-source completeness: only sources that fetched with full coverage and zero errors can participate in expiry.
- Workday, Amazon, Microsoft, and Arbeitnow (fetched with partial pages) are marked partial coverage and never expired.
- Persistence failure on company or job writes vetos the expiry step.
- 50% count-drop safety guard evaluated per-source before expiring unseen old jobs.
"""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from .engine import (
    DEFAULT_SEEDS_PATH,
    SupabaseSetDiffWriter,
    fetch_layer1_seed,
    load_company_seeds,
    load_dotenv_into_env,
    partition_set_diff,
)
from .fetch_aggregators_and_india import (
    fetch_adzuna,
    fetch_arbeitnow,
    fetch_jobspy_india,
)
from .fetchers import (
    fetch_amazon_jobs,
    fetch_microsoft_jobs,
    fetch_workday_cxs,
)
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


async def run_master_ingestion(
    *,
    sources: list[str] | None = None,
    seeds_path: str | Path = DEFAULT_SEEDS_PATH,
    dry_run: bool = True,
    baseline_active_count: int = 0,
    expire_stale_hours: int = 72,
    transport: httpx.AsyncBaseTransport | None = None,
    jobspy_scrape_fn: Callable[..., Any] | None = None,
) -> dict[str, Any]:
    """
    Runs selected ingestion layers/sources with per-source error isolation,
    safe set-diff upserts, and strict per-source expiration safety guards.
    """
    load_dotenv_into_env()
    raw_filters = sources or ["all"]
    source_filter = {s.strip().lower() for item in raw_filters for s in item.split(",") if s.strip()}
    if not source_filter:
        source_filter = {"all"}

    config = load_company_seeds(seeds_path)
    rl_cfg = config.get("rate_limit") or {}
    limiter = PerHostRateLimiter(
        default_rps=float(rl_cfg.get("default_rps_per_host", 4.0)),
        burst=float(rl_cfg.get("burst_per_host", 1.0)),
    )

    layer1_seeds = list(config.get("layer1_public_ats") or [])
    layer2_cfg = config.get("layer2_enterprise_json") or {}
    workday_seeds = list(layer2_cfg.get("workday_cxs") or [])

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(25.0),
        follow_redirects=True,
        transport=transport,
        headers={"User-Agent": "CareerHound-HighVolumeIngest/1.0"},
    ) as client:
        scheduled_tasks: list[asyncio.Task[dict[str, Any]]] = []

        # Layer 1: Public ATS APIs (Greenhouse, Lever, Ashby full coverage; SmartRecruiters single page = partial)
        for s in layer1_seeds:
            ats = str(s.get("ats") or "").lower()
            slug = str(s.get("slug") or "").lower()
            board_id = f"{ats}:{slug}"
            is_full = False if ats == "smartrecruiters" else True
            if _matches_source_filter(source_filter, "layer1", ats, slug, board_id):
                scheduled_tasks.append(
                    asyncio.create_task(
                        run_isolated_source(
                            board_id,
                            ats,
                            lambda seed=s: fetch_layer1_seed(client, limiter, seed),
                            is_full_coverage=is_full,
                        )
                    )
                )

        # Layer 2: Enterprise & Big Tech JSON APIs (Partial coverage, max_pages=1)
        for wd in workday_seeds:
            slug = str(wd.get("slug") or "").lower()
            board_id = f"workday:{slug}"
            if _matches_source_filter(source_filter, "layer2", "workday", slug, board_id):
                scheduled_tasks.append(
                    asyncio.create_task(
                        run_isolated_source(
                            board_id,
                            "workday",
                            lambda seed=wd: fetch_workday_cxs(client, limiter, seed, max_pages=1),
                            is_full_coverage=False,
                        )
                    )
                )

        if "amazon" in layer2_cfg and _matches_source_filter(source_filter, "layer2", "amazon"):
            amz_seed = layer2_cfg["amazon"]
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "amazon",
                        "amazon",
                        lambda: fetch_amazon_jobs(client, limiter, amz_seed, max_pages=1),
                        is_full_coverage=False,
                    )
                )
            )

        if "microsoft" in layer2_cfg and _matches_source_filter(source_filter, "layer2", "microsoft"):
            ms_seed = layer2_cfg["microsoft"]
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "microsoft",
                        "microsoft",
                        lambda: fetch_microsoft_jobs(client, limiter, ms_seed, max_pages=1),
                        is_full_coverage=False,
                    )
                )
            )

        # Layer 3: Scheduled India Batch (JobSpy) & Public JSON Aggregators
        if _matches_source_filter(source_filter, "layer3", "jobspy", "india"):
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "jobspy:india",
                        "jobspy",
                        lambda: fetch_jobspy_india(),
                        is_full_coverage=False,
                    )
                )
            )

        if _matches_source_filter(source_filter, "layer3", "arbeitnow"):
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "arbeitnow",
                        "arbeitnow",
                        lambda: fetch_arbeitnow(client, limiter, max_pages=1),
                        is_full_coverage=False,
                    )
                )
            )

        if _matches_source_filter(source_filter, "layer3", "adzuna"):
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "adzuna:in",
                        "adzuna",
                        lambda: fetch_adzuna(client, limiter),
                        is_full_coverage=False,
                    )
                )
            )

        task_reports = await asyncio.gather(*scheduled_tasks)

        all_jobs: list[dict[str, Any]] = []
        source_reports: list[dict[str, Any]] = []
        failed_sources: list[dict[str, str]] = []
        board_status_map: dict[str, dict[str, Any]] = {}

        for rep in task_reports:
            bsid = rep["source"]
            st = rep["source_type"]
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
                failed_sources.append({"source": bsid, "error": rep["error"] or "Board incomplete or failed"})

            board_status_map[bsid] = {
                "source_id": bsid,
                "source_type": st,
                "completed": rep["completed"],
                "is_full_coverage": rep["is_full_coverage"],
                "error": rep["error"],
                "fetched_jobs": rep["jobs"],
            }

        # Sort: Direct ATS (priority 1) before Aggregators (priority 2)
        all_jobs.sort(key=lambda j: int(j.get("source_priority", 2)))

        to_insert, to_update, unchanged = partition_set_diff(all_jobs, [])
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

        supabase_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")

        if not dry_run and supabase_url and service_key:
            writer = SupabaseSetDiffWriter(supabase_url, service_key)
            company_map = await writer.sync_companies(client, all_jobs)
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

        if not dry_run and supabase_url and service_key and not expiry_vetoed:
            writer = SupabaseSetDiffWriter(supabase_url, service_key)
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
                        f"{writer.base_url}/jobs?select=id&is_active=eq.true&source_id=eq.{bsid}&limit=1",
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

                if persisted_keys:
                    persisted_board_count = sum(
                        1 for j in b_info["fetched_jobs"]
                        if (str(j.get("source_id") or "") == bsid and (str(j.get("source_id") or ""), str(j.get("source_job_id") or "")) in persisted_keys)
                    )
                else:
                    persisted_board_count = len(b_info["fetched_jobs"])

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
                        f"{writer.base_url}/jobs?is_active=eq.true&source_id=eq.{bsid}&last_seen_at=lt.{cutoff}",
                        headers={**writer.headers, "Prefer": "return=representation"},
                        json={"is_active": False, "status": "expired"},
                    )
                    if exp_resp.status_code < 300 and isinstance(exp_resp.json(), list):
                        exp_count = len(exp_resp.json())
                        db_stats["expired"] += exp_count
                        expiry_reports.append({
                            "source_id": bsid,
                            "source_type": st,
                            "expired": exp_count,
                            "status": "completed",
                        })
                    else:
                        expiry_reports.append({
                            "source_id": bsid,
                            "source_type": st,
                            "expired": 0,
                            "status": "failed",
                            "error": f"HTTP {exp_resp.status_code}: {exp_resp.text}",
                        })
                except Exception as exc:
                    expiry_reports.append({
                        "source_id": bsid,
                        "source_type": st,
                        "expired": 0,
                        "status": "failed",
                        "error": redact_sensitive_params(str(exc)),
                    })

        category_counts: dict[str, int] = {}
        for j in to_insert:
            cat = str(j.get("company_category") or "OTHER_STARTUPS")
            category_counts[cat] = category_counts.get(cat, 0) + 1

        return {
            "sources_requested": sorted(source_filter),
            "total_fetched": len(all_jobs),
            "category_breakdown": category_counts,
            "db": db_stats,
            "expiry_vetoed": expiry_vetoed,
            "expiry_reports": expiry_reports,
            "failed_sources": failed_sources,
            "sources": source_reports,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Master CLI Runner for 3-Layer High-Volume Ingestion")
    parser.add_argument(
        "--source",
        action="append",
        default=None,
        help="Source filter: all, layer1, layer2, layer3, greenhouse, lever, ashby, smartrecruiters, workday, amazon, microsoft, jobspy, arbeitnow, adzuna, or slug",
    )
    parser.add_argument("--dry-run", action="store_true", default=False, help="Run without writing to Supabase")
    parser.add_argument("--baseline-count", type=int, default=0, help="Baseline active job count for 50%% drop guard")
    args = parser.parse_args()

    report = asyncio.run(
        run_master_ingestion(
            sources=args.source,
            dry_run=args.dry_run,
            baseline_active_count=args.baseline_count,
        )
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
