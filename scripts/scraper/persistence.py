"""Shared pre-persistence validator for public.jobs rows (mirrors the LIVE CHECK constraints).

Rows are checked before any batch is sent: a row that would violate a CHECK is rejected individually
and reported (source key + field + reason, never the raw row), so valid rows still persist. Only known
semantic aliases are mapped (salary_period year/month/hour); everything else outside the allowed set is
rejected, never coerced. NULL passes a CHECK, so None stays None (truthful unknown).
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

# public.jobs CHECK constraints (NOT VALID ones still apply to new/updated rows).
ALLOWED: dict[str, frozenset[Any]] = {
    "job_type": frozenset({"job", "internship", "full-time", "part-time", "contract", "other"}),
    "remote_eligibility": frozenset({"worldwide", "country_restricted", "unknown"}),
    "remote_scope": frozenset({"remote", "hybrid", "onsite", "any"}),
    "role_category": frozenset({"SDE", "AI_ML", "CLOUD", "DATA", "OTHER"}),
    "seniority": frozenset({"entry", "mid", "senior", "staff", "lead", "director", "unknown"}),
    "source_priority": frozenset({1, 2}),
    "source_type": frozenset({
        "ats", "api", "feed", "direct", "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
        "amazon", "microsoft", "jobspy", "arbeitnow", "adzuna",
    }),
    "status": frozenset({"active", "expired"}),
    "salary_period": frozenset({"yearly", "monthly", "hourly"}),
}

SALARY_PERIOD_ALIASES = {"year": "yearly", "month": "monthly", "hour": "hourly"}


def normalize_salary_period(raw: Any) -> Any:
    """Canonical salary_period for a known alias; None stays None; anything else is returned unchanged
    so validate_job_row rejects it (never invented, never silently coerced)."""
    if raw is None:
        return None
    if isinstance(raw, str):
        key = raw.strip().lower()
        if key in ALLOWED["salary_period"]:
            return key
        if key in SALARY_PERIOD_ALIASES:
            return SALARY_PERIOD_ALIASES[key]
    return raw


def source_key(row: dict[str, Any]) -> str:
    return f"{row.get('source_id') or row.get('source_type') or '?'}/{row.get('source_job_id') or '?'}"[:160]


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        return None
    return float(value)


def validate_job_row(row: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Returns (row with salary_period canonicalized, problems). Empty problems means persistable."""
    out = dict(row)
    if "salary_period" in out:
        out["salary_period"] = normalize_salary_period(out["salary_period"])
    problems: list[str] = []
    for field, allowed in ALLOWED.items():
        if field not in out or out[field] is None:
            continue
        value = out[field]
        scalar = int if field == "source_priority" else str
        # Shape first: list/dict are unhashable and would raise on set membership. Never echo the value.
        if isinstance(value, bool) or not isinstance(value, scalar):
            problems.append(f"{field}: invalid type {type(value).__name__[:20]}")
        elif value not in allowed:
            problems.append(f"{field}: value not allowed")
    lo, hi = out.get("salary_min"), out.get("salary_max")
    for field, value in (("salary_min", lo), ("salary_max", hi)):
        if value is not None and _number(value) is None:
            problems.append(f"{field}: not a finite number")
    if _number(lo) is not None and _number(hi) is not None and float(lo) > float(hi):
        problems.append("salary_min > salary_max")
    return out, problems


def prevalidate_jobs(jobs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Splits jobs into (valid, rejected). Rejected entries carry only bounded, redacted diagnostics."""
    valid: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    for job in jobs:
        clean, problems = validate_job_row(job)
        if problems:
            rejected.append(rejection(job, "prevalidation", "; ".join(problems)))
        else:
            valid.append(clean)
    return valid, rejected


def rejection(row: dict[str, Any], stage: str, reason: str, code: str | None = None) -> dict[str, Any]:
    return {
        "source_id": str(row.get("source_id") or row.get("source_type") or "")[:120],
        "source_key": source_key(row),
        "stage": stage,
        "code": code,
        "reason": reason[:300],
    }


_CONSTRAINT = re.compile(r'constraint\s+\\?"([A-Za-z0-9_]{1,63})\\?"')


def db_error_diagnostic(status: int, body: str) -> tuple[str | None, str]:
    """(SQLSTATE code, redacted reason) from a PostgREST error body. Never echoes row values:
    PostgREST 'details' can contain the full failing row, so only code + constraint name are kept."""
    code: str | None = None
    try:
        data = json.loads(body)
        if isinstance(data, dict) and isinstance(data.get("code"), str):
            code = data["code"][:10]
        message = str(data.get("message") or "") if isinstance(data, dict) else ""
    except (ValueError, TypeError):
        message = ""
    match = _CONSTRAINT.search(message)
    constraint = match.group(1) if match else None
    reason = f"HTTP {status}" + (f" code {code}" if code else "") + (f" constraint {constraint}" if constraint else "")
    return code, reason
