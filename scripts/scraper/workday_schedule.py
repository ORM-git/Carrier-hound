"""Persistent per-board Workday cooldown + fair rotation (a JSON file; no database table).

The file at WORKDAY_STATE_PATH survives between runs (CI keeps it in actions/cache). Missing or corrupt state
never permits a burst: the run is capped to WORKDAY_COLD_START_BOARDS boards. A rate-limited or failed board
gets next_eligible_at = now + max(Retry-After, exponential backoff), so a later run defers it instead of
retrying early. A board whose rows were all confirmed persisted waits WORKDAY_MIN_INTERVAL_SECONDS, so a duplicate
trigger sends nothing; a fetched-but-unpersisted board stays eligible. Dry runs read the state but never write it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from typing import Any

STATE_VERSION = 1


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(os.environ.get(name, default))))
    except ValueError:
        return default


def limits() -> dict[str, int]:
    return {
        "max_boards": _env_int("WORKDAY_MAX_BOARDS_PER_RUN", 4, 1, 20),
        "cold_start_boards": _env_int("WORKDAY_COLD_START_BOARDS", 1, 1, 20),
        "run_budget_seconds": _env_int("WORKDAY_RUN_BUDGET_SECONDS", 1200, 60, 4800),
        "min_interval_seconds": _env_int("WORKDAY_MIN_INTERVAL_SECONDS", 3 * 3600, 0, 7 * 86400),
        "failure_base_seconds": _env_int("WORKDAY_FAILURE_BASE_SECONDS", 4 * 3600, 60, 7 * 86400),
        "failure_cap_seconds": _env_int("WORKDAY_FAILURE_CAP_SECONDS", 24 * 3600, 60, 14 * 86400),
    }


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


def _parse(value: Any) -> datetime | None:
    if value is None:
        return None
    dt = datetime.fromisoformat(str(value))  # ValueError -> corrupt
    if dt.tzinfo is None:
        raise ValueError("naive timestamp")
    return dt


def load_state(path: str | None) -> tuple[dict[str, dict[str, Any]], str]:
    """(boards, status) with status ok / missing / corrupt. Any malformed entry makes the whole file corrupt."""
    if not path or not Path(path).is_file():
        return {}, "missing"
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        boards = data["sources"]
        if data.get("version") != STATE_VERSION or not isinstance(boards, dict):
            raise ValueError("version/shape")
        for entry in boards.values():
            if not isinstance(entry, dict) or not isinstance(entry.get("consecutive_failures", 0), int):
                raise ValueError("entry")
            for key in ("next_eligible_at", "last_attempt_at", "last_success_at"):
                _parse(entry.get(key))
        return boards, "ok"
    except (OSError, ValueError, KeyError, TypeError):
        return {}, "corrupt"


def save_state(path: str | None, boards: dict[str, dict[str, Any]]) -> None:
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    tmp.write_text(json.dumps({"version": STATE_VERSION, "sources": boards}, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, target)


def plan_boards(
    ids: list[str], boards: dict[str, dict[str, Any]], status: str, now: datetime, lim: dict[str, int]
) -> tuple[list[str], list[dict[str, Any]]]:
    """Chosen ids (never-attempted first, then least recently attempted) and deferred entries with reasons."""
    deferred: list[dict[str, Any]] = []
    eligible: list[str] = []
    for sid in ids:
        nxt = _parse(boards.get(sid, {}).get("next_eligible_at"))
        if nxt is not None and nxt > now:
            deferred.append({"source": sid, "reason": boards[sid].get("last_reason") or "cooldown", "next_eligible_at": _iso(nxt)})
        else:
            eligible.append(sid)
    eligible.sort(key=lambda sid: (boards.get(sid, {}).get("last_attempt_at") or "", sid))
    cap = lim["max_boards"] if status == "ok" else min(lim["max_boards"], lim["cold_start_boards"])
    for sid in eligible[cap:]:
        deferred.append({"source": sid, "reason": "rotation (per-run cap)" if status == "ok" else f"cold start: state {status}",
                         "next_eligible_at": None})
    return eligible[:cap], deferred


def record_attempt(
    boards: dict[str, dict[str, Any]], sid: str, now: datetime, lim: dict[str, int], *,
    ok: bool, reason: str | None = None, retry_after: float | None = None,
) -> None:
    entry = boards.setdefault(sid, {"consecutive_failures": 0, "last_success_at": None})
    entry["last_attempt_at"] = _iso(now)
    if ok:
        entry.update(consecutive_failures=0, last_reason="completed",
                     next_eligible_at=_iso(now + timedelta(seconds=lim["min_interval_seconds"])))
        return
    failures = int(entry.get("consecutive_failures") or 0) + 1
    backoff = min(lim["failure_cap_seconds"], lim["failure_base_seconds"] * 2 ** (failures - 1))
    wait = max(backoff, float(retry_after or 0))  # never earlier than the server asked
    entry.update(consecutive_failures=failures, last_reason=(reason or "failed")[:120],
                 next_eligible_at=_iso(now + timedelta(seconds=wait)))


def defer_until(boards: dict[str, dict[str, Any]], sid: str, until: datetime, reason: str) -> None:
    """An unattempted board that must not run before `until` (shared in-run cooldown)."""
    entry = boards.setdefault(sid, {"consecutive_failures": 0, "last_success_at": None})
    current = _parse(entry.get("next_eligible_at"))
    if current is None or until > current:
        entry["next_eligible_at"] = _iso(until)
        entry["last_reason"] = reason[:120]


def note_attempt(boards: dict[str, dict[str, Any]], sid: str, now: datetime) -> None:
    """Fetched but not (yet) confirmed persisted: counts for rotation fairness only, never as completion."""
    boards.setdefault(sid, {"consecutive_failures": 0, "last_success_at": None})["last_attempt_at"] = _iso(now)


def mark_persisted(boards: dict[str, dict[str, Any]], sid: str, now: datetime) -> None:
    boards.setdefault(sid, {"consecutive_failures": 0})["last_success_at"] = _iso(now)
