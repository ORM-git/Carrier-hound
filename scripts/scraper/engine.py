"""Async orchestration and set-diff database upsert engine."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import httpx

from .fetchers import (
    fetch_amazon_jobs,
    fetch_ashby,
    fetch_greenhouse,
    fetch_lever,
    fetch_microsoft_jobs,
    fetch_smartrecruiters,
    fetch_workday_cxs,
)
from .rate_limiter import PerHostRateLimiter

DEFAULT_SEEDS_PATH = Path(__file__).resolve().parent / "company_seeds.json"


def load_company_seeds(path: str | Path = DEFAULT_SEEDS_PATH) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def compute_content_fingerprint(row: dict[str, Any]) -> str:
    """Fingerprint of mutable job fields used for set-diff comparison."""
    kws = sorted(str(k).lower() for k in (row.get("top_keywords") or []))
    parts = [
        str(row.get("title") or "").strip(),
        str(row.get("location") or "").strip(),
        str(row.get("apply_url") or "").strip(),
        str(row.get("role_category") or "").strip(),
        str(row.get("salary_text") or "").strip(),
        str(row.get("salary_min") or ""),
        str(row.get("salary_max") or ""),
        str(bool(row.get("is_active", True))),
        str(int(row.get("source_priority") or 2)),
        ",".join(kws),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def partition_set_diff(
    incoming_jobs: list[dict[str, Any]],
    existing_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[tuple[str, dict[str, Any]]], list[str]]:
    """
    Set-diff partitioning:
    Returns (to_insert, to_update [(existing_id, payload)], unchanged_ids).
    - Deduplicates incoming batch by dedupe_hash (Direct ATS priority=1 beats Aggregator priority=2).
    - Compares incoming jobs against existing DB rows by (source_type, source_job_id) and active dedupe_hash.
    - Only emits writes for brand-new jobs or jobs whose content fingerprint / priority changed.
    """
    deduped_incoming: dict[str, dict[str, Any]] = {}
    for job in incoming_jobs:
        d_hash = job.get("dedupe_hash") or f"{job.get('source_type')}:{job.get('source_job_id')}"
        prev = deduped_incoming.get(d_hash)
        if prev is None or int(job.get("source_priority", 2)) < int(prev.get("source_priority", 2)):
            deduped_incoming[d_hash] = job

    by_source_key: dict[tuple[str, str], dict[str, Any]] = {}
    by_dedupe_hash: dict[str, dict[str, Any]] = {}
    for ex in existing_rows:
        st = str(ex.get("source_type") or "")
        sid = str(ex.get("source_job_id") or "")
        if st and sid:
            by_source_key[(st, sid)] = ex
        dh = ex.get("dedupe_hash")
        if dh and ex.get("is_active", True):
            by_dedupe_hash[str(dh)] = ex

    to_insert: list[dict[str, Any]] = []
    to_update: list[tuple[str, dict[str, Any]]] = []
    unchanged_ids: list[str] = []

    for job in deduped_incoming.values():
        s_key = (str(job.get("source_type") or ""), str(job.get("source_job_id") or ""))
        d_hash = str(job.get("dedupe_hash") or "")
        existing = by_source_key.get(s_key) or (by_dedupe_hash.get(d_hash) if d_hash else None)

        if existing is None:
            to_insert.append(job)
            continue

        ex_id = str(existing["id"])
        ex_priority = int(existing.get("source_priority") or 2)
        in_priority = int(job.get("source_priority") or 2)

        # Never downgrade an existing Direct ATS row (priority 1) with an Aggregator row (priority 2)
        if in_priority > ex_priority:
            unchanged_ids.append(ex_id)
            continue

        if compute_content_fingerprint(job) == compute_content_fingerprint(existing):
            unchanged_ids.append(ex_id)
        else:
            to_update.append((ex_id, job))

    return to_insert, to_update, unchanged_ids


class SupabaseSetDiffWriter:
    """Minimal PostgREST writer performing set-diff upserts in batches of 50."""

    def __init__(self, supabase_url: str, service_key: str) -> None:
        self.base_url = supabase_url.rstrip("/") + "/rest/v1"
        self.headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }

    async def sync_companies(
        self,
        client: httpx.AsyncClient,
        jobs: list[dict[str, Any]],
    ) -> dict[str, str]:
        """Upserts unique companies and returns slug -> company_id map."""
        companies_by_slug: dict[str, dict[str, Any]] = {}
        for j in jobs:
            slug = j.get("company_slug")
            if not slug or slug in companies_by_slug:
                continue
            companies_by_slug[slug] = {
                "slug": slug,
                "name": j["company"],
                "canonical_domain": j.get("canonical_domain"),
                "domain": j.get("canonical_domain"),
                "category": j.get("company_category"),
                "logo_url": j.get("logo_url"),
                "ats_type": j.get("source"),
                "enabled": True,
            }

        if not companies_by_slug:
            return {}

        resp = await client.post(
            f"{self.base_url}/companies?on_conflict=slug",
            headers={**self.headers, "Prefer": "resolution=merge-duplicates,return=representation"},
            json=list(companies_by_slug.values()),
        )
        if resp.status_code >= 400:
            return {}
        data = resp.json()
        return {row["slug"]: row["id"] for row in data if isinstance(row, dict) and "slug" in row and "id" in row}

    async def sync_jobs_set_diff(
        self,
        client: httpx.AsyncClient,
        jobs: list[dict[str, Any]],
        company_id_map: dict[str, str],
    ) -> dict[str, int]:
        """Performs set-diff upsert on jobs in batches of 50."""
        stats = {"inserted": 0, "updated": 0, "skipped_unchanged": 0}
        batch_size = 50

        db_columns = {
            "company", "company_id", "title", "location", "country", "country_code",
            "remote", "is_remote", "remote_scope", "job_type", "category",
            "role_category", "top_keywords", "skills", "salary_text", "salary_min",
            "salary_max", "currency", "description", "apply_url", "logo_url",
            "source", "source_type", "source_job_id", "source_url",
            "source_priority", "dedupe_hash", "verified", "posted_at",
            "last_seen_at", "is_active", "status",
        }

        for i in range(0, len(jobs), batch_size):
            chunk = jobs[i : i + batch_size]
            for j in chunk:
                slug = j.get("company_slug")
                if slug and slug in company_id_map:
                    j["company_id"] = company_id_map[slug]

            hashes = [j["dedupe_hash"] for j in chunk if j.get("dedupe_hash")]
            existing_rows: list[dict[str, Any]] = []
            if hashes:
                quoted = ",".join(f'"{h}"' for h in hashes)
                q_url = (
                    f"{self.base_url}/jobs"
                    f"?select=id,title,location,apply_url,role_category,salary_text,salary_min,salary_max,is_active,source_type,source_job_id,source_priority,dedupe_hash,top_keywords"
                    f"&dedupe_hash=in.({quoted})"
                )
                get_resp = await client.get(q_url, headers=self.headers)
                if get_resp.status_code == 200 and isinstance(get_resp.json(), list):
                    existing_rows = get_resp.json()

            to_insert, to_update, unchanged_ids = partition_set_diff(chunk, existing_rows)
            stats["skipped_unchanged"] += len(unchanged_ids)

            if to_insert:
                clean_insert = [{k: v for k, v in row.items() if k in db_columns} for row in to_insert]
                ins_resp = await client.post(
                    f"{self.base_url}/jobs?on_conflict=source,source_job_id",
                    headers={**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
                    json=clean_insert,
                )
                if ins_resp.status_code < 300:
                    stats["inserted"] += len(clean_insert)

            for ex_id, row in to_update:
                clean_upd = {k: v for k, v in row.items() if k in db_columns}
                upd_resp = await client.patch(
                    f"{self.base_url}/jobs?id=eq.{ex_id}",
                    headers={**self.headers, "Prefer": "return=minimal"},
                    json=clean_upd,
                )
                if upd_resp.status_code < 300:
                    stats["updated"] += 1

        return stats


async def fetch_layer1_seed(
    client: httpx.AsyncClient,
    limiter: PerHostRateLimiter,
    seed: dict[str, Any],
) -> list[dict[str, Any]]:
    ats = (seed.get("ats") or "").lower()
    if ats == "greenhouse":
        return await fetch_greenhouse(client, limiter, seed)
    if ats == "lever":
        return await fetch_lever(client, limiter, seed)
    if ats == "ashby":
        return await fetch_ashby(client, limiter, seed)
    if ats == "smartrecruiters":
        return await fetch_smartrecruiters(client, limiter, seed)
    return []


async def run_ingestion(
    *,
    seeds_path: str | Path = DEFAULT_SEEDS_PATH,
    dry_run: bool = True,
    max_seeds_per_layer: int | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Runs Layer 1 (Public ATS) and Layer 2 (Workday CXS, Amazon, Microsoft) ingestion."""
    config = load_company_seeds(seeds_path)
    rl_cfg = config.get("rate_limit") or {}
    limiter = PerHostRateLimiter(
        default_rps=float(rl_cfg.get("default_rps_per_host", 4.0)),
        burst=float(rl_cfg.get("burst_per_host", 5.0)),
    )

    layer1_seeds = list(config.get("layer1_public_ats") or [])
    layer2_cfg = config.get("layer2_enterprise_json") or {}
    workday_seeds = list(layer2_cfg.get("workday_cxs") or [])

    if max_seeds_per_layer is not None:
        layer1_seeds = layer1_seeds[:max_seeds_per_layer]
        workday_seeds = workday_seeds[:max_seeds_per_layer]

    all_jobs: list[dict[str, Any]] = []
    errors: list[str] = []

    async with httpx.AsyncClient(
        timeout=httpx.Timeout(25.0),
        follow_redirects=True,
        transport=transport,
        headers={"User-Agent": "CareerHound-HighVolumeIngest/1.0"},
    ) as client:
        tasks: list[asyncio.Task[list[dict[str, Any]]]] = []
        for s in layer1_seeds:
            tasks.append(asyncio.create_task(fetch_layer1_seed(client, limiter, s)))
        for wd in workday_seeds:
            tasks.append(asyncio.create_task(fetch_workday_cxs(client, limiter, wd, max_pages=1)))
        if "amazon" in layer2_cfg:
            tasks.append(asyncio.create_task(fetch_amazon_jobs(client, limiter, layer2_cfg["amazon"], max_pages=1)))
        if "microsoft" in layer2_cfg:
            tasks.append(asyncio.create_task(fetch_microsoft_jobs(client, limiter, layer2_cfg["microsoft"], max_pages=1)))

        results = await asyncio.gather(*tasks, return_exceptions=True)
        for res in results:
            if isinstance(res, Exception):
                errors.append(str(res))
            elif isinstance(res, list):
                all_jobs.extend(res)

        to_insert, to_update, unchanged = partition_set_diff(all_jobs, [])
        db_stats = {"inserted": len(to_insert), "updated": len(to_update), "skipped_unchanged": len(unchanged)}

        if not dry_run:
            supabase_url = os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL")
            service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY")
            if supabase_url and service_key:
                writer = SupabaseSetDiffWriter(supabase_url, service_key)
                company_map = await writer.sync_companies(client, all_jobs)
                db_stats = await writer.sync_jobs_set_diff(client, all_jobs, company_map)

    return {
        "fetched": len(all_jobs),
        "unique_after_dedupe": db_stats["inserted"] + db_stats["updated"] + db_stats["skipped_unchanged"],
        "db": db_stats,
        "errors": errors,
        "sample": all_jobs[0] if all_jobs else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Career-Hound Async High-Volume Ingestion Engine")
    parser.add_argument("--dry-run", action="store_true", default=False, help="Fetch & normalize without DB writes")
    parser.add_argument("--limit", type=int, default=None, help="Max seeds per layer")
    args = parser.parse_args()

    summary = asyncio.run(run_ingestion(dry_run=args.dry_run, max_seeds_per_layer=args.limit))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
