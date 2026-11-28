"""Salary part of src/lib/jobs/ingestNormalization.ts for the Python writer (checklist #21).

Columns come from docs/proposed/20261127_salary_normalization_and_skill_requirements.NOT_APPLIED.sql and are
written only when the engine's probe finds them. A salary is annualized only when its fetcher marked the period
as stated by the source (salary_period_stated); a stored salary_period alone is never evidence.
"""

from __future__ import annotations

import math
from typing import Any

SALARY_NORMALIZATION_FIELDS = (
    "salary_annual_min", "salary_annual_max", "salary_period_inferred", "salary_conversion_assumed",
)

# Mirror of ANNUALIZATION_FACTORS in src/lib/salary/normalize.ts, limited to what jobs.salary_period can hold.
ANNUALIZATION: dict[str, tuple[int, bool]] = {"yearly": (1, False), "monthly": (12, False), "hourly": (2080, True)}


def _usable(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        return None
    return float(value)


def salary_normalization_columns(job: dict[str, Any]) -> dict[str, Any]:
    has_salary = job.get("salary_min") is not None or job.get("salary_max") is not None
    stated = job.get("salary_period_stated") is True
    lo, hi = _usable(job.get("salary_min")), _usable(job.get("salary_max"))
    out: dict[str, Any] = {
        "salary_annual_min": None,
        "salary_annual_max": None,
        "salary_period_inferred": (not stated) if has_salary else None,
        "salary_conversion_assumed": None,
    }
    rule = ANNUALIZATION.get(job.get("salary_period")) if stated else None
    if rule is None or (lo is None and hi is None) or (lo is not None and hi is not None and lo > hi):
        return out
    factor, assumed = rule
    annual = [None if v is None else v * factor for v in (lo, hi)]
    if any(v is not None and not math.isfinite(v) for v in annual):
        return out
    out.update(salary_annual_min=annual[0], salary_annual_max=annual[1], salary_conversion_assumed=assumed)
    return out
