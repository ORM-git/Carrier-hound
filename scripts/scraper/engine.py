"""Async orchestration and set-diff database upsert engine."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
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
from .rate_limiter import PerHostRateLimiter, redact_sensitive_params

DEFAULT_SEEDS_PATH = Path(__file__).resolve().parent / "company_seeds.json"


def find_repo_root() -> Path:
    """Finds repository root by searching upward for .git or package.json."""
    curr = Path(__file__).resolve().parent
    for _ in range(5):
        if (curr / ".git").exists() or (curr / "package.json").exists():
            return curr
        if curr.parent == curr:
            break
        curr = curr.parent
    return Path(__file__).resolve().parents[2]


def load_dotenv_into_env() -> None:
    """Populates os.environ from .env and .env.local at repo root if not set."""
    root = find_repo_root()
    for fname in (".env", ".env.local"):
        fpath = root / fname
        if not fpath.exists():
            continue
        try:
            for line in fpath.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                k_clean = k.strip()
                if k_clean not in os.environ:
                    os.environ[k_clean] = v.strip().strip('"').strip("'")
        except Exception:
            pass


def load_company_seeds(path: str | Path = DEFAULT_SEEDS_PATH) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def compute_content_fingerprint(row: dict[str, Any]) -> str:
    """Fingerprint of all mutable job fields used for set-diff comparison."""
    kws = sorted(str(k).lower() for k in (row.get("top_keywords") or []))
    parts = [
        str(row.get("company") or "").strip(),
        str(row.get("title") or "").strip(),
        str(row.get("description") or "").strip(),
        str(row.get("location") or "").strip(),
        str(row.get("country") or "").strip(),
        str(row.get("country_code") or "").strip(),
        str(row.get("currency") or "").strip(),
        str(bool(row.get("remote") if row.get("remote") is not None else row.get("is_remote", False))),
        str(bool(row.get("is_remote") if row.get("is_remote") is not None else row.get("remote", False))),
        str(row.get("status") or "active").strip(),
        str(row.get("logo_url") or "").strip(),
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
    - Compares incoming jobs against existing DB rows by (source_type, source_job_id) first,
      then by active dedupe_hash for cross-source deduplication.
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

        # Look up by primary source key first, then fall back to dedupe_hash for cross-source dedupe
        existing = by_source_key.get(s_key)
        if existing is None and d_hash:
            existing = by_dedupe_hash.get(d_hash)

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
    """PostgREST writer performing safe set-diff upserts in batches of 50."""

    def __init__(self, supabase_url: str, service_key: str) -> None:
        self.base_url = supabase_url.rstrip("/") + "/rest/v1"
        self.headers = {
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }
        self.write_errors: list[str] = []
        self.failed_writes: int = 0
        self.persistence_failed: bool = False

    async def sync_companies(
        self,
        client: httpx.AsyncClient,
        jobs: list[dict[str, Any]],
    ) -> dict[str, str]:
        """
        Safely syncs unique companies without overwriting existing high-quality
        logos, canonical domains, or categories with null or lower-quality values.
        """
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
                "source_priority": int(j.get("source_priority") or 2),
                "enabled": True,
            }

        if not companies_by_slug:
            return {}

        slugs = list(companies_by_slug.keys())
        quoted = ",".join(f'"{s}"' for s in slugs)
        get_url = f"{self.base_url}/companies?select=id,slug,name,logo_url,domain,canonical_domain,category,ats_type&slug=in.({quoted})"
        try:
            get_resp = await client.get(get_url, headers=self.headers)
            existing_map: dict[str, dict[str, Any]] = {}
            if get_resp.status_code == 200 and isinstance(get_resp.json(), list):
                for row in get_resp.json():
                    if isinstance(row, dict) and "slug" in row:
                        existing_map[row["slug"]] = row
        except Exception as exc:
            self.write_errors.append(f"Companies lookup exception: {redact_sensitive_params(str(exc))}")
            self.persistence_failed = True
            existing_map = {}

        to_insert: list[dict[str, Any]] = []
        company_id_map: dict[str, str] = {slug: row["id"] for slug, row in existing_map.items() if "id" in row}

        for slug, inc in companies_by_slug.items():
            ex = existing_map.get(slug)
            if ex is None:
                insert_payload = {k: v for k, v in inc.items() if k != "source_priority"}
                to_insert.append(insert_payload)
            else:
                ex_prio = 1 if ex.get("ats_type") in ("greenhouse", "lever", "ashby", "smartrecruiters", "workday", "amazon", "microsoft") else 2
                inc_prio = inc.get("source_priority", 2)
                updates: dict[str, Any] = {}

                # Never overwrite a known better logo with null or lower-quality aggregator value
                if not ex.get("logo_url") and inc.get("logo_url"):
                    updates["logo_url"] = inc["logo_url"]
                elif inc_prio == 1 and ex_prio > 1 and inc.get("logo_url"):
                    updates["logo_url"] = inc["logo_url"]

                # Never overwrite canonical domain with null
                if not ex.get("canonical_domain") and inc.get("canonical_domain"):
                    updates["canonical_domain"] = inc["canonical_domain"]
                    updates["domain"] = inc["canonical_domain"]

                # Never downgrade company category
                if not ex.get("category") and inc.get("category"):
                    updates["category"] = inc["category"]
                elif inc_prio == 1 and ex.get("category") in ("OTHER_STARTUPS", "INDIAN_IT_AND_OTHER") and inc.get("category") in ("MNC_BIGTECH", "HIGH_PRODUCT_YC"):
                    updates["category"] = inc["category"]

                if updates:
                    try:
                        upd_resp = await client.patch(
                            f"{self.base_url}/companies?id=eq.{ex['id']}",
                            headers={**self.headers, "Prefer": "return=minimal"},
                            json=updates,
                        )
                        if upd_resp.status_code >= 400:
                            self.failed_writes += 1
                            self.persistence_failed = True
                            self.write_errors.append(f"Company update error {upd_resp.status_code} for {slug}")
                    except Exception as exc:
                        self.failed_writes += 1
                        self.persistence_failed = True
                        self.write_errors.append(f"Company update exception for {slug}: {redact_sensitive_params(str(exc))}")

        if to_insert:
            try:
                ins_resp = await client.post(
                    f"{self.base_url}/companies",
                    headers={**self.headers, "Prefer": "return=representation"},
                    json=to_insert,
                )
                if ins_resp.status_code >= 400:
                    self.failed_writes += len(to_insert)
                    self.persistence_failed = True
                    self.write_errors.append(f"Company insert error {ins_resp.status_code}: {ins_resp.text}")
                else:
                    data = ins_resp.json()
                    if isinstance(data, list):
                        for row in data:
                            if isinstance(row, dict) and "slug" in row and "id" in row:
                                company_id_map[row["slug"]] = row["id"]
            except Exception as exc:
                self.failed_writes += len(to_insert)
                self.persistence_failed = True
                self.write_errors.append(f"Company insert exception: {redact_sensitive_params(str(exc))}")

        return company_id_map

    async def sync_jobs_set_diff(
        self,
        client: httpx.AsyncClient,
        jobs: list[dict[str, Any]],
        company_id_map: dict[str, str],
    ) -> dict[str, Any]:
        """Performs set-diff upsert on jobs in batches of 50."""
        stats: dict[str, Any] = {
            "inserted": 0,
            "updated": 0,
            "skipped_unchanged": 0,
            "failed_writes": 0,
            "persistence_failed": False,
            "write_errors": [],
            "persisted_ids": [],
        }
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

            # Look up existing rows by source_job_id and dedupe_hash
            sids = [j["source_job_id"] for j in chunk if j.get("source_job_id")]
            hashes = [j["dedupe_hash"] for j in chunk if j.get("dedupe_hash")]
            or_parts: list[str] = []
            if sids:
                quoted_sids = ",".join(f'"{s}"' for s in sids)
                or_parts.append(f"source_job_id.in.({quoted_sids})")
            if hashes:
                quoted_hashes = ",".join(f'"{h}"' for h in hashes)
                or_parts.append(f"dedupe_hash.in.({quoted_hashes})")

            existing_rows: list[dict[str, Any]] = []
            if or_parts:
                q_url = (
                    f"{self.base_url}/jobs"
                    f"?select=id,company,title,location,country,country_code,currency,remote,is_remote,status,description,logo_url,apply_url,role_category,salary_text,salary_min,salary_max,is_active,source,source_type,source_job_id,source_priority,dedupe_hash,top_keywords"
                    f"&or=({','.join(or_parts)})"
                )
                try:
                    get_resp = await client.get(q_url, headers=self.headers)
                    if get_resp.status_code == 200 and isinstance(get_resp.json(), list):
                        existing_rows = get_resp.json()
                    elif get_resp.status_code >= 400:
                        self.failed_writes += 1
                        self.persistence_failed = True
                        self.write_errors.append(f"Jobs lookup error {get_resp.status_code}")
                except Exception as exc:
                    self.failed_writes += 1
                    self.persistence_failed = True
                    self.write_errors.append(f"Jobs lookup exception: {redact_sensitive_params(str(exc))}")

            to_insert, to_update, unchanged_ids = partition_set_diff(chunk, existing_rows)

            # Unchanged jobs must still refresh last_seen_at
            if unchanged_ids:
                now_iso = datetime.now(timezone.utc).isoformat()
                for k in range(0, len(unchanged_ids), 50):
                    u_chunk = unchanged_ids[k : k + 50]
                    quoted_u = ",".join(f'"{uid}"' for uid in u_chunk)
                    try:
                        touch_resp = await client.patch(
                            f"{self.base_url}/jobs?id=in.({quoted_u})",
                            headers={**self.headers, "Prefer": "return=minimal"},
                            json={"last_seen_at": now_iso},
                        )
                        if touch_resp.status_code >= 400:
                            self.failed_writes += len(u_chunk)
                            self.persistence_failed = True
                            self.write_errors.append(f"Touch last_seen_at error {touch_resp.status_code}")
                        else:
                            stats["skipped_unchanged"] += len(u_chunk)
                            stats["persisted_ids"].extend(u_chunk)
                    except Exception as exc:
                        self.failed_writes += len(u_chunk)
                        self.persistence_failed = True
                        self.write_errors.append(f"Touch last_seen_at exception: {redact_sensitive_params(str(exc))}")

            if to_insert:
                clean_insert = [{k: v for k, v in row.items() if k in db_columns} for row in to_insert]
                try:
                    ins_resp = await client.post(
                        f"{self.base_url}/jobs",
                        headers={**self.headers, "Prefer": "return=representation"},
                        json=clean_insert,
                    )
                    if ins_resp.status_code < 300:
                        inserted_rows = ins_resp.json() if isinstance(ins_resp.json(), list) else []
                        stats["inserted"] += len(clean_insert)
                        for r in inserted_rows:
                            if isinstance(r, dict) and "id" in r:
                                stats["persisted_ids"].append(r["id"])
                    else:
                        self.failed_writes += len(clean_insert)
                        self.persistence_failed = True
                        self.write_errors.append(f"Job insert error {ins_resp.status_code}: {ins_resp.text}")
                except Exception as exc:
                    self.failed_writes += len(clean_insert)
                    self.persistence_failed = True
                    self.write_errors.append(f"Job insert exception: {redact_sensitive_params(str(exc))}")

            for ex_id, row in to_update:
                clean_upd = {k: v for k, v in row.items() if k in db_columns}
                try:
                    upd_resp = await client.patch(
                        f"{self.base_url}/jobs?id=eq.{ex_id}",
                        headers={**self.headers, "Prefer": "return=minimal"},
                        json=clean_upd,
                    )
                    if upd_resp.status_code < 300:
                        stats["updated"] += 1
                        stats["persisted_ids"].append(ex_id)
                    else:
                        self.failed_writes += 1
                        self.persistence_failed = True
                        self.write_errors.append(f"Job update error {upd_resp.status_code} on {ex_id}: {upd_resp.text}")
                except Exception as exc:
                    self.failed_writes += 1
                    self.persistence_failed = True
                    self.write_errors.append(f"Job update exception on {ex_id}: {redact_sensitive_params(str(exc))}")

        stats["failed_writes"] = self.failed_writes
        stats["persistence_failed"] = self.persistence_failed
        stats["write_errors"] = self.write_errors
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
    load_dotenv_into_env()
    config = load_company_seeds(seeds_path)
    rl_cfg = config.get("rate_limit") or {}
    limiter = PerHostRateLimiter(
        default_rps=float(rl_cfg.get("default_rps_per_host", 4.0)),
        burst=float(rl_cfg.get("burst_per_host", 1.0)),
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
                errors.append(redact_sensitive_params(str(res)))
            elif isinstance(res, list):
                all_jobs.extend(res)

        to_insert, to_update, unchanged = partition_set_diff(all_jobs, [])
        db_stats: dict[str, Any] = {
            "inserted": len(to_insert),
            "updated": len(to_update),
            "skipped_unchanged": len(unchanged),
            "failed_writes": 0,
            "persistence_failed": False,
            "write_errors": [],
            "persisted_ids": [],
        }

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
