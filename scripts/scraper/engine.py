"""Async orchestration and set-diff database upsert engine."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Any
from urllib.parse import urlparse

import httpx

from .required_years import REQUIRED_YEARS_SOURCE_DESCRIPTION, extract_required_years
from .fetchers import (
    fetch_amazon_jobs,
    fetch_ashby,
    fetch_greenhouse,
    fetch_lever,
    fetch_microsoft_jobs,
    fetch_smartrecruiters,
    fetch_workday_cxs,
    enrich_greenhouse_pay_transparency,
)
from .persistence import db_error_diagnostic, is_duplicate_apply_url, prevalidate_jobs, rejection, sanitize_salaries
from .rate_limiter import PerHostRateLimiter, redact_sensitive_params
from .salary_normalization import SALARY_NORMALIZATION_FIELDS, salary_normalization_columns

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


WRITE_FLAG = "--write-to-database"


class WriteAuthorizationError(RuntimeError):
    """Write mode was requested without valid Supabase credentials. Never carries the credential values."""


def validate_row_cap(
    *,
    dry_run: bool,
    max_rows: int | None,
    no_expire: bool = True,
    allow_uncapped: bool = False,
    allow_expire: bool = False,
) -> None:
    if max_rows is not None and (isinstance(max_rows, bool) or not isinstance(max_rows, int) or max_rows <= 0):
        raise WriteAuthorizationError("ingestion refused: --max-rows must be a positive integer")
    if not dry_run and max_rows is None and not allow_uncapped:
        raise WriteAuthorizationError("write mode refused: an explicit positive --max-rows cap is required")
    if not no_expire and not allow_expire:
        raise WriteAuthorizationError("ingestion refused: expiry requires the explicit --expire flag")
    if not no_expire and dry_run:
        raise WriteAuthorizationError("expiry refused: --expire requires --write-to-database")
    if not no_expire and max_rows is not None:
        raise WriteAuthorizationError("expiry refused: capped runs cannot expire jobs")


def select_unique_jobs(jobs: list[dict[str, Any]], max_rows: int | None) -> list[dict[str, Any]]:
    """Deduplicate and cap canonical source identities in stable key order."""
    selected_by_identity: dict[tuple[str, str], tuple[tuple[int, str], dict[str, Any]]] = {}
    for job in jobs:
        source_job_id = str(job.get("source_job_id") or "").strip()
        source_key = str(job.get("source_id") or job.get("source_type") or "").strip()
        if not source_job_id or not source_key:
            continue
        identity = (source_key, source_job_id)
        rank = (
            int(job.get("source_priority", 2)),
            json.dumps(job, ensure_ascii=False, sort_keys=True, default=str, separators=(",", ":")),
        )
        current = selected_by_identity.get(identity)
        if current is None or rank < current[0]:
            selected_by_identity[identity] = (rank, dict(job))
    ordered = [selected_by_identity[key][1] for key in sorted(selected_by_identity)]
    return ordered if max_rows is None else ordered[:max_rows]


def ingestion_has_errors(report: dict[str, Any]) -> bool:
    db = report.get("db") if isinstance(report.get("db"), dict) else {}
    expiry_reports = report.get("expiry_reports") if isinstance(report.get("expiry_reports"), list) else []
    return bool(
        report.get("errors")
        or report.get("failed_sources")
        or db.get("persistence_failed")
        or db.get("write_errors")
        or report.get("rejected")
        or db.get("rejected")
        or any(item.get("status") == "failed" for item in expiry_reports if isinstance(item, dict))
    )


def resolve_write_credentials() -> tuple[str, str]:
    """Fail-closed credential check for write mode, run before any network call."""
    url = (os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or os.environ.get("SUPABASE_URL") or "").strip()
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise WriteAuthorizationError("write mode refused: NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL must be set to an https URL")
    if len(key) < 20 or any(ch.isspace() for ch in key):
        raise WriteAuthorizationError("write mode refused: SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SERVICE_KEY is missing or malformed")
    return url, key


def add_write_mode_arguments(parser: argparse.ArgumentParser) -> None:
    """Dry-run is the default; write, uncapped, and expiry modes need explicit opt-ins."""
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Fetch and normalize only; never writes (the default)")
    mode.add_argument(WRITE_FLAG, dest="write_to_database", action="store_true",
                      help="Explicitly authorize company/job writes (requires valid Supabase service credentials)")
    parser.add_argument("--production", action="store_true", help="Allow uncapped writes when combined with --write-to-database")
    parser.add_argument("--max-rows", type=int, default=None, help="Hard cap on unique canonical job identities selected globally")
    expiry = parser.add_mutually_exclusive_group()
    expiry.add_argument("--no-expire", dest="no_expire", action="store_true", help="Keep stale-job expiry disabled (the default)")
    expiry.add_argument("--expire", dest="no_expire", action="store_false", help="Enable stale-job expiry (uncapped write mode only)")
    parser.set_defaults(no_expire=True)


def dry_run_from_args(args: argparse.Namespace) -> bool:
    if not args.write_to_database:
        print(f"[mode] DRY-RUN: nothing will be written. Pass {WRITE_FLAG} to authorize writes.", file=sys.stderr)
        return True
    return False


def load_company_seeds(path: str | Path = DEFAULT_SEEDS_PATH) -> dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


YEARS_COLUMNS_ENV = "CM_REQUIRED_YEARS_COLUMNS"
YEARS_FIELDS = ("min_experience_years", "max_experience_years", "experience_years_source")
YEARS_SELECT = ",min_experience_years,max_experience_years,experience_years_source"


def years_columns_enabled() -> bool:
    """Owner switch, off by default: the jobs years columns are written only after the owner has applied
    migration 20261126b and set CM_REQUIRED_YEARS_COLUMNS=1. Until then nothing about years is selected,
    sent or compared, so ingestion behaves exactly as before."""
    return os.environ.get(YEARS_COLUMNS_ENV, "").strip() == "1"


def apply_required_years(jobs: list[dict[str, Any]]) -> None:
    """Fill min/max_experience_years from the description when it states one unambiguous requirement.
    A job with no extractable bound gets no years keys at all (never an explicit null), so nothing existing is erased."""
    for job in jobs:
        bounds = extract_required_years(job.get("description"))
        if bounds is None:
            continue
        lo, hi = bounds
        job["min_experience_years"] = lo
        job["max_experience_years"] = hi
        job["experience_years_source"] = REQUIRED_YEARS_SOURCE_DESCRIPTION


def keep_existing_years(job: dict[str, Any], existing: dict[str, Any]) -> None:
    """Never replace a bound with nothing, and never replace a bound another source verified (any source other
    than 'description') with one parsed from text."""
    has_existing = existing.get("min_experience_years") is not None or existing.get("max_experience_years") is not None
    if not has_existing:
        return
    verified = (existing.get("experience_years_source") or "description") != "description"
    if verified or (job.get("min_experience_years") is None and job.get("max_experience_years") is None):
        for f in YEARS_FIELDS:
            job[f] = existing.get(f)


def compute_content_fingerprint(row: dict[str, Any]) -> str:
    """Fingerprint of all mutable job fields used for set-diff comparison."""
    skills = sorted(str(s).strip().lower() for s in (row.get("skills") or []) if str(s).strip())
    kws = sorted(str(k).strip().lower() for k in (row.get("top_keywords") or []) if str(k).strip())
    parts = [
        str(row.get("company") or "").strip(),
        str(row.get("company_id") or "").strip(),
        str(row.get("title") or "").strip(),
        str(row.get("posted_at") or "").strip(),
        str(row.get("description") or "").strip(),
        str(row.get("location") or "").strip(),
        str(row.get("country") or "").strip(),
        str(row.get("country_code") or "").strip(),
        str(row.get("currency") or "").strip(),
        str(bool(row.get("remote") if row.get("remote") is not None else row.get("is_remote", False))),
        str(bool(row.get("is_remote") if row.get("is_remote") is not None else row.get("remote", False))),
        str(row.get("remote_scope") or "").strip(),
        str(row.get("remote_eligibility") or "").strip(),
        str(row.get("job_type") or "").strip(),
        str(row.get("category") or "").strip(),
        str(row.get("role_category") or "").strip(),
        str(row.get("status") or "active").strip(),
        str(bool(row.get("is_active", True))),
        str(bool(row.get("verified", False))),
        str(row.get("logo_url") or "").strip(),
        str(row.get("apply_url") or "").strip(),
        str(row.get("salary_text") or "").strip(),
        str(row.get("salary_min") or ""),
        str(row.get("salary_max") or ""),
        # No-salary rows carry no period (legacy rows default to yearly): never churn them on that alone.
        str(row.get("salary_period") or "").strip().lower() if (row.get("salary_text") or row.get("salary_min") or row.get("salary_max")) else "",
        str(row.get("canonical_domain") or "").strip().lower(),
        str(row.get("source_id") or "").strip(),
        str(row.get("source_url") or "").strip(),
        str(int(row.get("source_priority") or 2)),
        ",".join(kws),
        "|".join(str(row.get(f) if row.get(f) is not None else "") for f in YEARS_FIELDS),
        ",".join(skills),
    ]
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def partition_set_diff(
    incoming_jobs: list[dict[str, Any]],
    existing_rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[tuple[str, dict[str, Any]]], list[str]]:
    """
    Set-diff partitioning:
    Returns (to_insert, to_update [(existing_id, payload)], unchanged_ids).
    - Deduplicates the incoming batch by board identity (source_id, source_job_id), legacy
      (source_type, source_job_id) when source_id is absent; higher priority (lower number) wins.
    - Matches existing DB rows by exact (source_id, source_job_id). The legacy fallback
      (source_type, source_job_id) only considers rows whose source_id IS NULL, and only when the
      match is unambiguous: exactly one such legacy row, exactly one incoming board claiming that
      native id, and the incoming board's vendor equals the row's source_type. Anything else inserts:
      a row with a different non-null source_id is never updated (greenhouse:b/42 never overwrites
      greenhouse:a/42).
      dedupe_hash is advisory (#643 contract): two boards with the same hash coexist, never merged.
    - Only emits writes for brand-new jobs or jobs whose content fingerprint / priority changed.
    """
    deduped_incoming: dict[str, dict[str, Any]] = {}
    for job in incoming_jobs:
        if not job.get("source_job_id"):
            deduped_incoming[f"no-id:{len(deduped_incoming)}"] = job  # no identity: never collapse
            continue
        key = f"{job.get('source_id') or job.get('source_type')}:{job.get('source_job_id')}"
        prev = deduped_incoming.get(key)
        if prev is None or int(job.get("source_priority", 2)) < int(prev.get("source_priority", 2)):
            deduped_incoming[key] = job

    by_source_id_key: dict[tuple[str, str], dict[str, Any]] = {}
    legacy_rows: dict[tuple[str, str], list[dict[str, Any]]] = {}  # source_id IS NULL rows only
    for ex in existing_rows:
        src_id = str(ex.get("source_id") or "")
        st = str(ex.get("source_type") or "")
        sid = str(ex.get("source_job_id") or "")
        if src_id and sid:
            by_source_id_key[(src_id, sid)] = ex
        elif st and sid:
            legacy_rows.setdefault((st, sid), []).append(ex)

    # Boards in this batch claiming each legacy (source_type, source_job_id): >1 means we cannot tell
    # which board a NULL-board legacy row belongs to.
    boards_per_legacy_key: dict[tuple[str, str], set[str]] = {}
    for job in deduped_incoming.values():
        st, sid = str(job.get("source_type") or ""), str(job.get("source_job_id") or "")
        if st and sid:
            boards_per_legacy_key.setdefault((st, sid), set()).add(str(job.get("source_id") or ""))

    to_insert: list[dict[str, Any]] = []
    to_update: list[tuple[str, dict[str, Any]]] = []
    unchanged_ids: list[str] = []

    for job in deduped_incoming.values():
        src_id_key = (str(job.get("source_id") or ""), str(job.get("source_job_id") or ""))
        s_key = (str(job.get("source_type") or ""), str(job.get("source_job_id") or ""))

        # Exact board identity first; then the guarded NULL-board legacy fallback.
        existing = None
        if src_id_key[0] and src_id_key[1]:
            existing = by_source_id_key.get(src_id_key)
        if existing is None and s_key[0] and s_key[1]:
            candidates = legacy_rows.get(s_key, [])
            vendor = src_id_key[0].split(":", 1)[0] if src_id_key[0] else s_key[0]
            if len(candidates) == 1 and len(boards_per_legacy_key.get(s_key, ())) == 1 and vendor == s_key[0]:
                existing = candidates[0]

        if existing is None:
            to_insert.append(job)
            continue

        ex_id = str(existing["id"])
        job["_existing_id"] = ex_id
        if not job.get("posted_at") and existing.get("posted_at"):
            job["posted_at"] = existing["posted_at"]
        if years_columns_enabled():
            keep_existing_years(job, existing)
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
        self.logo_enqueue: dict[str, Any] = {"requested": 0, "enqueued": 0, "status": "skipped", "coverage": None}
        self._salary_normalization_columns: bool | None = None  # probed once per run

    async def salary_normalization_columns_exist(self, client: httpx.AsyncClient) -> bool:
        """Best-effort probe for the NOT APPLIED proposal's salary columns, like scripts/ingest.ts: any failure
        means 'absent' for this run, so a schema without the proposal keeps working unchanged."""
        if self._salary_normalization_columns is None:
            try:
                resp = await client.get(f"{self.base_url}/jobs", headers=self.headers,
                                        params={"select": ",".join(SALARY_NORMALIZATION_FIELDS), "limit": "1"})
                self._salary_normalization_columns = resp.status_code == 200
            except Exception:
                self._salary_normalization_columns = False
        return self._salary_normalization_columns

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
                "logo_url": None,  # company-logo contract: raw logos must never be written by Python
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
            else:
                self.failed_writes += 1
                self.persistence_failed = True
                self.write_errors.append(f"Companies lookup error {get_resp.status_code if get_resp.status_code != 200 else 'invalid response'}")
                return {}
        except Exception as exc:
            self.write_errors.append(f"Companies lookup exception: {redact_sensitive_params(str(exc))}")
            self.failed_writes += 1
            self.persistence_failed = True
            return {}

        to_insert: list[dict[str, Any]] = []
        company_id_map: dict[str, str] = {slug: row["id"] for slug, row in existing_map.items() if "id" in row}

        for slug, inc in companies_by_slug.items():
            ex = existing_map.get(slug)
            if ex is None:
                insert_payload = {k: v for k, v in inc.items() if k != "source_priority"}
                insert_payload["logo_url"] = None
                to_insert.append(insert_payload)
            else:
                ex_prio = 1 if ex.get("ats_type") in ("greenhouse", "lever", "ashby", "smartrecruiters", "workday", "amazon", "microsoft") else 2
                inc_prio = inc.get("source_priority", 2)
                updates: dict[str, Any] = {}

                # Logos are never written here (company-logo contract): the TS repair worker owns logo_url.

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
                            break
                    except Exception as exc:
                        self.failed_writes += 1
                        self.persistence_failed = True
                        self.write_errors.append(f"Company update exception for {slug}: {redact_sensitive_params(str(exc))}")
                        break

        if to_insert and not self.persistence_failed:
            try:
                ins_resp = await client.post(
                    f"{self.base_url}/companies",
                    headers={**self.headers, "Prefer": "return=representation"},
                    json=to_insert,
                )
                if ins_resp.status_code >= 400:
                    self.failed_writes += len(to_insert)
                    self.persistence_failed = True
                    self.write_errors.append(f"Company insert error: {db_error_diagnostic(ins_resp.status_code, ins_resp.text)[1]}")
                else:
                    try:
                        data = ins_resp.json()
                    except ValueError:
                        data = None
                    confirmed = [row for row in data if isinstance(row, dict) and row.get("slug") and row.get("id")] if isinstance(data, list) else []
                    if len(confirmed) != len(to_insert):
                        self.failed_writes += len(to_insert) - len(confirmed) or 1
                        self.persistence_failed = True
                        self.write_errors.append("Company insert response did not confirm every row")
                    else:
                        for row in confirmed:
                            company_id_map[row["slug"]] = row["id"]
            except Exception as exc:
                self.failed_writes += len(to_insert)
                self.persistence_failed = True
                self.write_errors.append(f"Company insert exception: {redact_sensitive_params(str(exc))}")

        if not self.persistence_failed:
            # Every company seen is handed over; SQL keeps only those without an eligible hosted logo.
            seen = [company_id_map[slug] for slug in companies_by_slug if slug in company_id_map]
            await self.enqueue_company_logos(client, seen)

        return company_id_map

    async def enqueue_company_logos(self, client: httpx.AsyncClient, company_ids: list[str]) -> None:
        """Hand new / ineligible-logo companies to the shared logo repair loop. Fail-open: never
        marks persistence failed and never raises, so branding can't block job ingestion."""
        ids = sorted({i for i in company_ids if isinstance(i, str) and i})
        origin = self.base_url[: -len("/rest/v1")] if self.base_url.endswith("/rest/v1") else self.base_url
        self.logo_enqueue = {"requested": len(ids), "enqueued": 0, "status": "skipped" if not ids else "pending",
                             "company_ids": ids[:200], "coverage": None}
        for start in range(0, len(ids), 500):
            batch = ids[start:start + 500]
            try:
                resp = await client.post(
                    f"{self.base_url}/rpc/enqueue_company_logos",
                    headers=self.headers,
                    json={"p_ids": batch, "p_origin": origin},
                )
            except Exception as exc:  # noqa: BLE001 - fail-open by design
                self.logo_enqueue["status"] = f"error: {redact_sensitive_params(str(exc))}"
                return
            if resp.status_code == 404 or "PGRST202" in resp.text:
                self.logo_enqueue["status"] = "not-migrated"
                return
            if resp.status_code >= 400:
                self.logo_enqueue["status"] = f"error: HTTP {resp.status_code}"
                return
            try:
                raw_val = resp.json()
            except Exception:  # noqa: BLE001
                self.logo_enqueue["status"] = "invalid: unparseable json"
                return
            if isinstance(raw_val, bool) or not isinstance(raw_val, int):
                val_type = type(raw_val).__name__[:30]
                self.logo_enqueue["status"] = f"invalid: expected integer count, got {val_type}"
                return
            if raw_val < 0:
                self.logo_enqueue["status"] = "invalid: negative enqueue count"
                return
            if raw_val > len(batch):
                self.logo_enqueue["status"] = f"invalid: count exceeds requested ({len(batch)})"
                return
            self.logo_enqueue["enqueued"] += raw_val
        if ids:
            self.logo_enqueue["status"] = "ok"
            # Same coverage / backlog / orphan counts as the TS ingest and the sweep summary.
            try:
                cov = await client.post(f"{self.base_url}/rpc/company_logo_coverage", headers=self.headers, json={"p_origin": origin})
                if cov.status_code < 400:
                    try:
                        cov_val = cov.json()
                    except Exception:
                        self.logo_enqueue["coverage"] = "unknown"
                        self.logo_enqueue["status"] = "invalid: unparseable coverage json"
                        return
                    if isinstance(cov_val, bool) or not isinstance(cov_val, dict):
                        cov_type = type(cov_val).__name__[:30]
                        self.logo_enqueue["coverage"] = "unknown"
                        self.logo_enqueue["status"] = f"invalid: unexpected coverage shape (got {cov_type})"
                        return

                    # Real company_logo_coverage contract (20261122 base + 20261123 review state)
                    base_keys = {
                        "companies_with_active_jobs",
                        "eligible_hosted",
                        "missing_or_ineligible",
                        "pending",
                        "failed",
                        "missing",
                        "queued_retries",
                        "orphan_links",
                    }
                    review_state_keys = {"held", "intentional_initials", "approved"}
                    allowed_keys = base_keys | review_state_keys

                    if not base_keys.issubset(cov_val.keys()):
                        self.logo_enqueue["coverage"] = "unknown"
                        self.logo_enqueue["status"] = "invalid: coverage missing required keys"
                        return

                    unexpected = set(cov_val.keys()) - allowed_keys
                    if unexpected:
                        self.logo_enqueue["coverage"] = "unknown"
                        self.logo_enqueue["status"] = "invalid: unexpected coverage keys"
                        return

                    for k, v in cov_val.items():
                        if isinstance(v, bool) or not isinstance(v, int):
                            self.logo_enqueue["coverage"] = "unknown"
                            self.logo_enqueue["status"] = f"invalid: coverage {k} must be integer"
                            return
                        if v < 0:
                            self.logo_enqueue["coverage"] = "unknown"
                            self.logo_enqueue["status"] = f"invalid: coverage {k} cannot be negative"
                            return

                    self.logo_enqueue["coverage"] = cov_val
            except Exception:  # noqa: BLE001 - reporting only, never fatal
                pass

    async def _post_jobs(self, client: httpx.AsyncClient, rows: list[dict[str, Any]]) -> tuple[str, Any]:
        """One atomic insert. Returns ("ok", confirmed_rows) / ("check", reason) for a definitive 23514
        rejection (nothing was written) / ("error", reason) for anything else, including ambiguous ones."""
        try:
            resp = await client.post(
                f"{self.base_url}/jobs",
                headers={**self.headers, "Prefer": "return=representation"},
                json=rows,
            )
        except Exception as exc:  # timeout / connection reset: outcome unknown, never retried
            return "error", f"Job insert exception: {redact_sensitive_params(str(exc))}"
        if resp.status_code >= 300:
            code, reason = db_error_diagnostic(resp.status_code, resp.text)
            if is_duplicate_apply_url(resp.status_code, resp.text):
                return "duplicate", reason
            return ("check" if code == "23514" and resp.status_code == 400 else "error"), reason
        try:
            data = resp.json()
        except ValueError:
            data = None
        return "ok", [row for row in data if isinstance(row, dict) and row.get("id")] if isinstance(data, list) else []

    async def _insert_jobs(
        self,
        client: httpx.AsyncClient,
        to_insert: list[dict[str, Any]],
        db_columns: set[str],
        stats: dict[str, Any],
    ) -> list[dict[str, Any]]:
        """Inserts a batch; returns the source rows confirmed persisted. A definitive 23514 (CHECK) or
        jobs_apply_url_unique 23505 rejection of the atomic batch is isolated row by row (bounded by the batch
        size); every other failure stops writes."""
        clean = [{k: v for k, v in row.items() if k in db_columns} for row in to_insert]
        outcome, payload = await self._post_jobs(client, clean)
        if outcome in ("check", "duplicate") and len(clean) > 1:
            persisted: list[dict[str, Any]] = []
            for row in to_insert:
                persisted += await self._insert_jobs(client, [row], db_columns, stats)
                if self.persistence_failed:
                    break
            return persisted
        if outcome == "check":
            stats["rejected"].append(rejection(to_insert[0], "insert", payload, "23514"))
            return []
        if outcome == "duplicate":
            stats["duplicate_skipped"].append(rejection(to_insert[0], "insert", payload, "23505"))
            return []
        if outcome == "error":
            self.failed_writes += len(clean)
            self.persistence_failed = True
            self.write_errors.append(f"Job insert error: {payload}")
            return []
        stats["inserted"] += len(payload)
        stats["persisted_ids"].extend(row["id"] for row in payload)
        if len(payload) != len(clean):
            self.failed_writes += len(clean) - len(payload) or 1
            self.persistence_failed = True
            self.write_errors.append("Job insert response did not confirm every row")
            return []
        return list(to_insert)

    async def _existing_apply_urls(self, client: httpx.AsyncClient, urls: list[Any]) -> set[str]:
        """apply_urls already owned by some row (any source). A failed lookup stops writes, never guesses."""
        wanted = sorted({u for u in urls if isinstance(u, str) and u})
        found: set[str] = set()
        for k in range(0, len(wanted), 20):  # 20 URLs per GET keeps the query string bounded
            quoted = ",".join('"' + u.replace("\\", "\\\\").replace('"', '\\"') + '"' for u in wanted[k:k + 20])
            try:
                resp = await client.get(f"{self.base_url}/jobs", headers=self.headers,
                                        params={"select": "id,apply_url", "apply_url": f"in.({quoted})"})
                rows = resp.json() if resp.status_code == 200 else None
            except Exception as exc:
                self.failed_writes += 1
                self.persistence_failed = True
                self.write_errors.append(f"Jobs apply_url lookup exception: {redact_sensitive_params(str(exc))}")
                return found
            if not isinstance(rows, list):
                self.failed_writes += 1
                self.persistence_failed = True
                self.write_errors.append(f"Jobs apply_url lookup error {resp.status_code if resp.status_code != 200 else 'invalid response'}")
                return found
            found.update(str(r.get("apply_url")) for r in rows if isinstance(r, dict) and r.get("apply_url"))
        return found

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
            "persisted_source_keys": [],
            "rejected": [],
            "duplicate_skipped": [],
            "salary_sanitized": [],
        }
        persisted_source_keys: set[tuple[str, str]] = set()
        inserted_keys: set[tuple[str, str]] = set()
        updated_keys: set[tuple[str, str]] = set()
        batch_size = 50
        # Shared CHECK-constraint validator: invalid rows are reported individually, valid rows continue.
        jobs, stats["salary_sanitized"] = sanitize_salaries(jobs)
        jobs, stats["rejected"] = prevalidate_jobs(jobs)
        if years_columns_enabled():
            apply_required_years(jobs)

        db_columns = {
            "company", "company_id", "title", "location", "country", "country_code",
            "remote", "is_remote", "remote_scope", "remote_eligibility", "job_type", "category",
            "role_category", "top_keywords", "skills", "salary_text", "salary_min",
            "salary_max", "salary_period", "currency", "description", "apply_url", "logo_url",
            "source", "source_type", "source_id", "source_job_id", "source_url",
            "source_priority", "dedupe_hash", "verified", "canonical_domain", "posted_at",
            "last_seen_at", "is_active", "status",
        }
        if years_columns_enabled():
            db_columns.update(YEARS_FIELDS)
        if await self.salary_normalization_columns_exist(client):
            db_columns.update(SALARY_NORMALIZATION_FIELDS)
            for job in jobs:
                job.update(salary_normalization_columns(job))

        # Complete every identity lookup before the first job write. A later batch lookup
        # failure must not leave an earlier batch partially committed by this invocation.
        existing_by_start: dict[int, list[dict[str, Any]]] = {}
        for i in range(0, len(jobs), batch_size):
            chunk = jobs[i : i + batch_size]
            sids = [str(j["source_job_id"]) for j in chunk if j.get("source_job_id")]
            if not sids:
                existing_by_start[i] = []
                continue
            quoted_sids = ",".join(f'"{sid}"' for sid in sids)
            q_url = (
                f"{self.base_url}/jobs"
                f"?select=id,company,company_id,title,posted_at,location,country,country_code,currency,remote,is_remote,remote_scope,remote_eligibility,job_type,category,role_category,status,description,logo_url,apply_url,salary_text,salary_min,salary_max,salary_period,is_active,verified,source,source_id,source_type,source_job_id,source_url,source_priority,dedupe_hash,top_keywords,skills,canonical_domain{YEARS_SELECT if years_columns_enabled() else ''}"
                f"&or=(source_job_id.in.({quoted_sids}))"
            )
            try:
                get_resp = await client.get(q_url, headers=self.headers)
                rows = get_resp.json() if get_resp.status_code == 200 else None
                if not isinstance(rows, list):
                    self.failed_writes += 1
                    self.persistence_failed = True
                    self.write_errors.append(f"Jobs lookup error {get_resp.status_code if get_resp.status_code != 200 else 'invalid response'}")
                    break
                existing_by_start[i] = rows
            except Exception as exc:
                self.failed_writes += 1
                self.persistence_failed = True
                self.write_errors.append(f"Jobs lookup exception: {redact_sensitive_params(str(exc))}")
                break
        if self.persistence_failed:
            stats.update({
                "failed_writes": self.failed_writes,
                "persistence_failed": True,
                "write_errors": self.write_errors,
            })
            return stats

        partitions: dict[int, tuple[list[dict[str, Any]], list[tuple[str, dict[str, Any]]], list[str]]] = {}
        for i in range(0, len(jobs), batch_size):
            chunk = jobs[i : i + batch_size]
            for j in chunk:
                slug = j.get("company_slug")
                if slug and slug in company_id_map:
                    j["company_id"] = company_id_map[slug]
            partitions[i] = partition_set_diff(chunk, existing_by_start[i])

        # Identity is the source key; apply_url is unique too. A planned insert whose apply_url another row
        # already owns, or a row of this run has been CONFIRMED inserted with, is that existing job: skip it,
        # never a second row. A URL is claimed only after a confirmed insert, so a rejected first candidate
        # never blocks the next valid one.
        existing_urls = await self._existing_apply_urls(client, [row.get("apply_url") for p in partitions.values() for row in p[0]])
        if self.persistence_failed:
            stats.update({"failed_writes": self.failed_writes, "persistence_failed": True, "write_errors": self.write_errors})
            return stats
        claimed_urls: set[str] = set()

        for i in range(0, len(jobs), batch_size):
            chunk = jobs[i : i + batch_size]
            planned_inserts, to_update, unchanged_ids = partitions[i]
            to_insert: list[dict[str, Any]] = []
            next_candidates: list[dict[str, Any]] = []  # same URL as an earlier row of this batch: tried after it
            batch_urls: set[str] = set()
            for row in planned_inserts:
                url = row.get("apply_url")
                if isinstance(url, str) and url and (url in existing_urls or url in claimed_urls):
                    stats["duplicate_skipped"].append(rejection(row, "prelookup", "apply_url already owned by another job"))
                    continue
                if isinstance(url, str) and url:
                    if url in batch_urls:
                        next_candidates.append(row)
                        continue
                    batch_urls.add(url)
                to_insert.append(row)

            # Unchanged jobs must still refresh last_seen_at
            if unchanged_ids:
                now_iso = datetime.now(timezone.utc).isoformat()
                for k in range(0, len(unchanged_ids), 50):
                    u_chunk = unchanged_ids[k : k + 50]
                    quoted_u = ",".join(f'"{uid}"' for uid in u_chunk)
                    try:
                        touch_resp = await client.patch(
                            f"{self.base_url}/jobs?id=in.({quoted_u})",
                            headers={**self.headers, "Prefer": "return=representation"},
                            json={"last_seen_at": now_iso},
                        )
                        touch_rows = touch_resp.json() if touch_resp.status_code < 300 and isinstance(touch_resp.json(), list) else []
                        confirmed_ids = [row["id"] for row in touch_rows if isinstance(row, dict) and row.get("id")]
                        if touch_resp.status_code >= 300 or len(confirmed_ids) != len(u_chunk):
                            self.failed_writes += len(u_chunk)
                            self.persistence_failed = True
                            self.write_errors.append(
                                f"Touch last_seen_at error {touch_resp.status_code}" if touch_resp.status_code >= 300
                                else "Touch last_seen_at response did not confirm every row"
                            )
                        else:
                            stats["skipped_unchanged"] += len(confirmed_ids)
                            stats["persisted_ids"].extend(confirmed_ids)
                            u_set = set(confirmed_ids)
                            for j in chunk:
                                if j.get("_existing_id") in u_set:
                                    sid = str(j.get("source_id") or "")
                                    sjid = str(j.get("source_job_id") or "")
                                    if sid and sjid:
                                        persisted_source_keys.add((sid, sjid))
                    except Exception as exc:
                        self.failed_writes += len(u_chunk)
                        self.persistence_failed = True
                        self.write_errors.append(f"Touch last_seen_at exception: {redact_sensitive_params(str(exc))}")

            if self.persistence_failed:
                break

            def record_inserted(rows: list[dict[str, Any]]) -> None:
                for row in rows:
                    if isinstance(row.get("apply_url"), str) and row["apply_url"]:
                        claimed_urls.add(row["apply_url"])  # claimed only once the insert is confirmed
                    sid = str(row.get("source_id") or "")
                    sjid = str(row.get("source_job_id") or "")
                    if sid and sjid:
                        persisted_source_keys.add((sid, sjid))
                        inserted_keys.add((sid, sjid))

            if to_insert:
                record_inserted(await self._insert_jobs(client, to_insert, db_columns, stats))
            # Next candidate per URL, one at a time: a duplicate once an earlier candidate owns the URL,
            # otherwise (the earlier one was rejected) it gets its own chance.
            for row in next_candidates:
                if self.persistence_failed:
                    break
                if row["apply_url"] in claimed_urls:
                    stats["duplicate_skipped"].append(rejection(row, "prelookup", "apply_url already owned by another job"))
                    continue
                record_inserted(await self._insert_jobs(client, [row], db_columns, stats))

            if self.persistence_failed:
                break

            for ex_id, row in to_update:
                clean_upd = {k: v for k, v in row.items() if k in db_columns}
                try:
                    upd_resp = await client.patch(
                        f"{self.base_url}/jobs?id=eq.{ex_id}",
                        headers={**self.headers, "Prefer": "return=representation"},
                        json=clean_upd,
                    )
                    if upd_resp.status_code < 300:
                        try:
                            updated_rows = upd_resp.json()
                        except ValueError:
                            updated_rows = None
                        confirmed_ids = [item["id"] for item in updated_rows if isinstance(item, dict) and item.get("id")] if isinstance(updated_rows, list) else []
                        if ex_id not in confirmed_ids:
                            self.failed_writes += 1
                            self.persistence_failed = True
                            self.write_errors.append(f"Job update response did not confirm row {ex_id}")
                        else:
                            stats["updated"] += 1
                            stats["persisted_ids"].append(ex_id)
                            sid = str(row.get("source_id") or "")
                            sjid = str(row.get("source_job_id") or "")
                            if sid and sjid:
                                persisted_source_keys.add((sid, sjid))
                                updated_keys.add((sid, sjid))
                    else:
                        code, reason = db_error_diagnostic(upd_resp.status_code, upd_resp.text)
                        if code == "23514" and upd_resp.status_code == 400:  # definitive CHECK rejection of this row only
                            stats["rejected"].append(rejection(row, "update", reason, code))
                        elif is_duplicate_apply_url(upd_resp.status_code, upd_resp.text):  # another row owns the URL
                            stats["duplicate_skipped"].append(rejection(row, "update", reason, code))
                        else:
                            self.failed_writes += 1
                            self.persistence_failed = True
                            self.write_errors.append(f"Job update error on {ex_id}: {reason}")
                except Exception as exc:
                    self.failed_writes += 1
                    self.persistence_failed = True
                    self.write_errors.append(f"Job update exception on {ex_id}: {redact_sensitive_params(str(exc))}")

                if self.persistence_failed:
                    break
            if self.persistence_failed:
                break

        stats["persisted_source_keys"] = [list(k) for k in persisted_source_keys]
        stats["inserted_source_keys"] = [list(k) for k in inserted_keys]
        stats["updated_source_keys"] = [list(k) for k in updated_keys]
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
    max_rows: int | None = None,
    no_expire: bool = True,
    allow_uncapped: bool = False,
    allow_expire: bool = False,
    max_seeds_per_layer: int | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Runs Layer 1 (Public ATS) and Layer 2 (Workday CXS, Amazon, Microsoft) ingestion."""
    if not no_expire:
        raise WriteAuthorizationError(
            "--expire is unsupported by engine.py; use python -m scripts.scraper.run_ingestion"
        )
    validate_row_cap(
        dry_run=dry_run, max_rows=max_rows, no_expire=no_expire,
        allow_uncapped=allow_uncapped, allow_expire=allow_expire,
    )
    load_dotenv_into_env()
    credentials = None if dry_run else resolve_write_credentials()  # fail closed before any fetch
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

        fetched_count = len(all_jobs)
        all_jobs, sanitized = sanitize_salaries(all_jobs)
        all_jobs, rejected = prevalidate_jobs(all_jobs)  # before dedupe: dedupe ranks on int(source_priority)
        validated_count = len(all_jobs)
        unique_jobs = select_unique_jobs(all_jobs, None)
        all_jobs = unique_jobs if max_rows is None else unique_jobs[:max_rows]
        selected_count = len(all_jobs)
        enrichment_warnings: list[dict[str, str]] = []
        for seed in layer1_seeds:
            if (seed.get("ats") or "").lower() != "greenhouse":
                continue
            greenhouse_seed = {**seed, "token": seed.get("token") or seed.get("slug")}
            board_source_id = f"greenhouse:{greenhouse_seed['token']}"
            try:
                warnings = await enrich_greenhouse_pay_transparency(
                    client, limiter, greenhouse_seed,
                    [job for job in all_jobs if job.get("source_id") == board_source_id],
                )
                if warnings:
                    enrichment_warnings.extend(warnings)
                    withheld = {w["source_job_id"] for w in warnings}
                    all_jobs = [j for j in all_jobs if not (
                        j.get("source_id") == board_source_id and j.get("source_job_id") in withheld
                    )]
            except Exception as exc:
                errors.append(redact_sensitive_params(str(exc)))
        to_insert, to_update, unchanged = partition_set_diff(all_jobs, [])
        projected_counts = {"inserted": len(to_insert), "updated": len(to_update), "unchanged": len(unchanged)}
        db_stats: dict[str, Any] = {
            "inserted": len(to_insert),
            "updated": len(to_update),
            "skipped_unchanged": len(unchanged),
            "failed_writes": 0,
            "persistence_failed": False,
            "write_errors": [],
            "persisted_ids": [],
            "persisted_source_keys": [],
        }

        if credentials is not None and errors:
            db_stats.update({"inserted": 0, "updated": 0, "skipped_unchanged": 0})
        elif credentials is not None:
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
                db_stats = await writer.sync_jobs_set_diff(client, all_jobs, company_map)

    return {
        "dry_run": dry_run,
        "fetched": fetched_count,
        "selected": selected_count,
        "skipped_by_cap": max(0, len(unique_jobs) - selected_count),
        "projected_counts": projected_counts,
        "persisted_counts": None if dry_run else {
            "inserted": db_stats["inserted"],
            "updated": db_stats["updated"],
            "unchanged": db_stats["skipped_unchanged"],
        },
        "unique_after_dedupe": db_stats["inserted"] + db_stats["updated"] + db_stats["skipped_unchanged"],
        "db": db_stats,
        "enrichment_warnings": enrichment_warnings,
        "errors": errors,
        "validated": validated_count,
        "rejected": rejected + list(db_stats.get("rejected") or []),
        "salary_sanitized_count": len(sanitized),
        "duplicate_skipped_count": len(db_stats.get("duplicate_skipped") or []),
        "sample": all_jobs[0] if all_jobs else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Career-Hound Async High-Volume Ingestion Engine")
    add_write_mode_arguments(parser)
    parser.add_argument("--limit", type=int, default=None, help="Max seeds per layer")
    args = parser.parse_args()

    try:
        dry_run = dry_run_from_args(args)
        if not args.no_expire:
            raise WriteAuthorizationError(
                "--expire is unsupported by engine.py; use python -m scripts.scraper.run_ingestion"
            )
        validate_row_cap(
            dry_run=dry_run, max_rows=args.max_rows, no_expire=args.no_expire,
            allow_uncapped=args.production, allow_expire=not args.no_expire,
        )
        summary = asyncio.run(run_ingestion(
            dry_run=dry_run, max_rows=args.max_rows, no_expire=args.no_expire,
            allow_uncapped=args.production, allow_expire=not args.no_expire,
            max_seeds_per_layer=args.limit,
        ))
    except WriteAuthorizationError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps(summary, indent=2))
    if ingestion_has_errors(summary):
        print("ingestion failed: source, persistence, or expiry errors were reported", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
