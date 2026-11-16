"""
Master CLI Runner for the 3-Layer High-Volume Job Ingestion Engine.

Features:
- `--source` filtering (`all`, `layer1`, `layer2`, `layer3`, `greenhouse`, `lever`,
  `ashby`, `smartrecruiters`, `workday`, `amazon`, `microsoft`, `jobspy`,
  `arbeitnow`, `adzuna`, or a specific company slug).
- Strict per-source error isolation (one failing board never crashes the batch).
- 50% count-drop safety guard before expiring unseen old jobs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from .engine import (
    DEFAULT_SEEDS_PATH,
    SupabaseSetDiffWriter,
     fetch_layer1_seed,
    load_company_seeds,
    partition_set_diff,
)
from .fetch_aggregators_and_india import (
    fetch_adzuna,
    fetch_arbeitnow,
    fetch_jobspy_india_batch,
)
from .fetchers import (
    fetch_amazon_jobs,
    fetch_microsoft_jobs,
    fetch_workday_cxs,
)
from .rate_limiter import PerHostRateLimiter


def evaluate_count_drop_guard(
    fetched_count: int,
    baseline_active_count: int,
    *,
    is_full_run: bool = True,
    min_ratio: float = 0.5,
) -> dict[str, Any]:
    """
    50% count-drop guard before expiring old jobs:
    Blocks expiration when a partial `--source` filter was used or when
    `fetched_count < baseline_active_count * 0.5`.
    """
    if not is_full_run:
        return {
            "allowed": False,
            "fetched_count": fetched_count,
            "baseline_active_count": baseline_active_count,
            "reason": "Partial source run (--source != all); skipping stale job expiration.",
        }
    if baseline_active_count <= 0:
        return {
            "allowed": fetched_count > 0,
            "fetched_count": fetched_count,
            "baseline_active_count": baseline_active_count,
            "reason": "No prior active baseline; expiration allowed only if fetched_count > 0.",
        }
    ratio = fetched_count / float(baseline_active_count)
    if ratio < min_ratio:
        return {
            "allowed": False,
            "fetched_count": fetched_count,
            "baseline_active_count": baseline_active_count,
            "ratio": round(ratio, 4),
            "reason": (
                f"50% count-drop guard triggered: fetched {fetched_count} vs "
                f"baseline {baseline_active_count} ({ratio:.1%} < {min_ratio:.0%}). Aborting expiration."
            ),
        }
    return {
        "allowed": True,
        "fetched_count": fetched_count,
        "baseline_active_count": baseline_active_count,
        "ratio": round(ratio, 4),
        "reason": f"Healthy volume ({ratio:.1%} of baseline >= {min_ratio:.0%}); expiration allowed.",
    }


async def run_isolated_source(
    source_id: str,
    coro_factory: Callable[[], Awaitable[list[dict[str, Any]]]],
) -> dict[str, Any]:
    """Executes a single source coroutine with complete error isolation."""
    try:
        jobs = await coro_factory()
        return {
            "source": source_id,
            "status": "ok",
            "fetched": len(jobs),
            "jobs": jobs,
            "error": None,
        }
    except Exception as exc:
        return {
            "source": source_id,
            "status": "failed",
            "fetched": 0,
            "jobs": [],
            "error": f"{type(exc).__name__}: {exc}",
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
    set-diff upserts, and the 50% count-drop guard before expiring stale jobs.
    """
    raw_filters = sources or ["all"]
    source_filter = {s.strip().lower() for item in raw_filters for s in item.split(",") if s.strip()}
    if not source_filter:
        source_filter = {"all"}
    is_full_run = "all" in source_filter

    config = load_company_seeds(seeds_path)
    rl_cfg = config.get("rate_limit") or {}
    limiter = PerHostRateLimiter(
        default_rps=float(rl_cfg.get("default_rps_per_host", 4.0)),
        burst=float(rl_cfg.get("burst_per_host", 5.0)),
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

        # Layer 1: Public ATS APIs
        for s in layer1_seeds:
            ats = str(s.get("ats") or "").lower()
            slug = str(s.get("slug") or "").lower()
            if _matches_source_filter(source_filter, "layer1", ats, slug, f"{ats}:{slug}"):
                scheduled_tasks.append(
                    asyncio.create_task(
                        run_isolated_source(
                            f"layer1:{ats}:{slug}",
                            lambda seed=s: fetch_layer1_seed(client, limiter, seed),
                        )
                    )
                )

        # Layer 2: Enterprise & Big Tech JSON APIs
        for wd in workday_seeds:
            slug = str(wd.get("slug") or "").lower()
            if _matches_source_filter(source_filter, "layer2", "workday", slug, f"workday:{slug}"):
                scheduled_tasks.append(
                    asyncio.create_task(
                        run_isolated_source(
                            f"layer2:workday:{slug}",
                            lambda seed=wd: fetch_workday_cxs(client, limiter, seed, max_pages=1),
                        )
                    )
                )

        if "amazon" in layer2_cfg and _matches_source_filter(source_filter, "layer2", "amazon"):
            amz_seed = layer2_cfg["amazon"]
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "layer2:amazon",
                        lambda: fetch_amazon_jobs(client, limiter, amz_seed, max_pages=1),
                    )
                )
            )

        if "microsoft" in layer2_cfg and _matches_source_filter(source_filter, "layer2", "microsoft"):
            ms_seed = layer2_cfg["microsoft"]
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "layer2:microsoft",
                        lambda: fetch_microsoft_jobs(client, limiter, ms_seed, max_pages=1),
                    )
                )
            )

        # Layer 3: Scheduled India Batch (JobSpy) & Public JSON Aggregators (Arbeitnow, Adzuna)
        if _matches_source_filter(source_filter, "layer3", "jobspy", "india"):
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "layer3:jobspy_india",
                        lambda: fetch_jobspy_india_batch(scrape_fn=jobspy_scrape_fn),
                    )
                )
            )

        if _matches_source_filter(source_filter, "layer3", "arbeitnow"):
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "layer3:arbeitnow",
                        lambda: fetch_arbeitnow(client, limiter, max_pages=1),
                    )
                )
            )

        if _matches_source_filter(source_filter, "layer3", "adzuna"):
            scheduled_tasks.append(
                asyncio.create_task(
                    run_isolated_source(
                        "layer3:adzuna",
                        lambda: fetch_adzuna(client, limiter),
                    )
                )
            )

        task_reports = await asyncio.gather(*scheduled_tasks)

        all_jobs: list[dict[str, Any]] = []
        source_reports: list[dict[str, Any]] = []
        failed_sources: list[dict[str, str]] = []

        for rep in task_reports:
            all_jobs.extend(rep["jobs"])
            source_reports.append(
                {
                    "source": rep["source"],
                    "status": rep["status"],
                    "fetched": rep["fetched"],
                    "error": rep["error"],
                }
            )
            if rep["status"] == "failed":
                failed_sources.append({"source": rep["source"], "error": rep["error"] or "Unknown error"})

        # Process Direct ATS (priority 1) before Aggregators (priority 2)
        all_jobs.sort(key=lambda j: int(j.get("source_priority", 2)))

        to_insert, to_update, unchanged = partition_set_diff(all_jobs, [])
        db_stats = {
            "inserted": len(to_insert),
            "updated": len(to_update),
            "skipped_unchanged": len(unchanged),
            "expired": 0,
        }

        supabase_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")

        if not dry_run and supabase_url and service_key:
            writer = SupabaseSetDiffWriter(supabase_url, service_key)
            if baseline_active_count <= 0:
                cnt_resp = await client.get(
                    f"{writer.base_url}/jobs?select=id&is_active=eq.true&limit=1",
                    headers={**writer.headers, "Prefer": "count=exact"},
                )
                content_range = cnt_resp.headers.get("content-range") or ""
                if "/" in content_range and content_range.split("/")[-1].isdigit():
                    baseline_active_count = int(content_range.split("/")[-1])

            company_map = await writer.sync_companies(client, all_jobs)
            sync_res = await writer.sync_jobs_set_diff(client, all_jobs, company_map)
            db_stats.update(sync_res)

        drop_guard = evaluate_count_drop_guard(
            len(all_jobs),
            baseline_active_count,
            is_full_run=is_full_run,
            min_ratio=0.5,
        )

        if not dry_run and drop_guard["allowed"] and supabase_url and service_key:
            writer = SupabaseSetDiffWriter(supabase_url, service_key)
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=expire_stale_hours)).isoformat()
            exp_resp = await client.patch(
                f"{writer.base_url}/jobs?is_active=eq.true&last_seen_at=lt.{cutoff}",
                headers={**writer.headers, "Prefer": "return=representation"},
                json={"is_active": False, "status": "expired"},
            )
            if exp_resp.status_code < 300 and isinstance(exp_resp.json(), list):
                db_stats["expired"] = len(exp_resp.json())

        category_counts: dict[str, int] = {}
        for j in to_insert:
            cat = str(j.get("company_category") or "OTHER_STARTUPS")
            category_counts[cat] = category_counts.get(cat, 0) + 1

        return {
            "sources_requested": sorted(source_filter),
            "total_fetched": len(all_jobs),
            "category_breakdown": category_counts,
            "db": db_stats,
            "count_drop_guard": drop_guard,
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
