"""
Python cohort run outcome -> one row in the existing public.ingest_runs table (rows 46/78: source health covers
both pipelines). Existing columns only, existing service-role env only, no new SQL.

    python -m scripts.scraper.health_record record --cohort workday --mode write-production-expire \
        --report reports/python-ingest-workday.json --summary reports/python-ingest-summary-workday.json --exit-code 1
    python -m scripts.scraper.health_record expected-sources --check     # CI drift guard
    python -m scripts.scraper.health_record expected-sources --write     # regenerate expected_sources.json

Row contract (read by src/lib/observability/sourceHealth.ts):
- per_source_counts["python_run"] holds the run metadata and marks the row as Python; it is never a source key and
  never "coverage", so the TypeScript shard-cycle logic (cleanup safety, evaluateSourceHealth) does not treat it as
  a TS shard.
- every other per_source_counts key is a source this run actually executed, spelled exactly as the Python report's
  source_id (e.g. "greenhouse:stripe", "workday:nvidia"); its value is inserted+updated, or null when unknown
  (failed, incomplete pagination, writes withheld). Deferred (cooldown/budget) boards are metadata only.
- status is "success" only for an exit-0 cohort whose every executed source completed with full pagination;
  a deferred no-op or incomplete Workday pagination is "warning"; failures without confirmed writes are "failed".
- total_active / total_verified are null: the Python runner does not measure them, so nothing is invented.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

PYTHON_RUN_KEY = "python_run"
RECORD_VERSION = 1
WRITE_MODE = "write-production-expire"
WRITE_TIMEOUT_SECONDS = 15
EXPECTED_SOURCES_PATH = Path(__file__).resolve().parent / "expected_sources.json"


# ---- row building (pure) ------------------------------------------------------------------------

def _int_or_none(v: Any) -> int | None:
    return v if type(v) is int and v >= 0 else None


def _parse(ts: Any) -> datetime | None:
    try:
        dt = datetime.fromisoformat(str(ts))
    except (TypeError, ValueError):
        return None
    return dt if dt.tzinfo else None


def source_state(src: dict[str, Any]) -> str:
    """completed | incomplete | failed for one executed source (#873 measures for Workday)."""
    if not src.get("completed") or src.get("status") == "failed":
        return "failed"
    if src.get("source_type") == "workday" and src.get("pagination_complete") is not True:
        return "incomplete"  # one page of a larger board, or completeness unknown: never full success
    return "completed"


def build_run_record(report: dict[str, Any] | None, summary: dict[str, Any], cohort: str,
                     now: datetime, run_env: dict[str, str] | None = None) -> dict[str, Any]:
    """The ingest_runs row for one cohort run. Pure: no I/O, no clock reads."""
    run_env = run_env or {}
    outcome = str(summary.get("status") or "no_report")          # ok | failed | deferred_noop | no_report
    exit_code = str(summary.get("exit_code") or "n/a")
    meta: dict[str, Any] = {
        "pipeline": "python", "version": RECORD_VERSION, "cohort": cohort,
        "run": {"github_run_id": run_env.get("GITHUB_RUN_ID"), "github_run_attempt": run_env.get("GITHUB_RUN_ATTEMPT")},
        "git_sha": None, "exit_code": exit_code, "outcome": outcome, "guard": None,
        "selected_sources": None, "executed_sources": None, "sources": {}, "deferred": {},
        "confirmed_writes": None, "counts_basis": "per-source inserted+updated; null = unknown, never zero",
    }
    if not isinstance(report, dict):
        meta["timing"] = "no report: times are when this record was written"
        return {"started_at": None, "finished_at": now.isoformat(), "duration_seconds": None,
                "companies_processed": None, "total_active": None, "total_verified": None,
                "per_source_counts": {PYTHON_RUN_KEY: meta}, "status": "failed",
                "error": f"no_report: python {cohort} cohort produced no parseable report (exit {exit_code})"}

    guard = str(report.get("guard_block_reason") or "").split(":")[0] or None
    writes_confirmed = not report.get("dry_run", True) and guard not in ("write_withheld", "persistence_failed", "dry_run")
    sources = [s for s in (report.get("sources") or []) if isinstance(s, dict) and s.get("source_id")]
    per_source: dict[str, Any] = {}
    states: dict[str, str] = {}
    for s in sources:
        sid = str(s["source_id"])  # verbatim: exact source-ID compatibility with the Python report
        state = source_state(s)
        states[sid] = state
        ins, upd = _int_or_none(s.get("inserted")), _int_or_none(s.get("updated"))
        per_source[sid] = ins + upd if state == "completed" and writes_confirmed and ins is not None and upd is not None else None
        meta["sources"][sid] = {
            "state": state, "source_type": s.get("source_type"), "fetched": _int_or_none(s.get("fetched")),
            "inserted": ins, "updated": upd,
            "pagination_complete": s.get("pagination_complete") if s.get("source_type") == "workday" else None,
            "source_total": _int_or_none(s.get("source_total")), "error_class": s.get("error_class"),
        }
    for d in report.get("deferred_sources") or []:
        if isinstance(d, dict) and d.get("source"):
            meta["deferred"][str(d["source"])] = {"reason": str(d.get("deferred_reason") or d.get("reason") or "")[:80],
                                                  "next_eligible_at": d.get("next_eligible_at")}
    pc = report.get("persisted_counts") if writes_confirmed else None
    meta.update(git_sha=report.get("git_sha"), guard=guard, selected_sources=len(report.get("selected_sources") or []),
                executed_sources=len(sources),
                confirmed_writes={k: _int_or_none(pc.get(k)) for k in ("inserted", "updated", "unchanged")} if isinstance(pc, dict) else None)

    written = sum((meta["confirmed_writes"] or {}).get(k) or 0 for k in ("inserted", "updated"))
    if outcome == "ok" and exit_code == "0" and all(st == "completed" for st in states.values()):
        status, error = "success", None
    elif outcome == "ok" and exit_code == "0":
        n = sum(1 for st in states.values() if st == "incomplete")
        status, error = "warning", f"incomplete: {n} Workday board(s) fetched without full pagination"
    elif outcome == "deferred_noop":
        status, error = "warning", f"deferred_noop: every selected Workday board was deferred ({len(meta['deferred'])}); nothing written"
    else:
        failed = sum(1 for st in states.values() if st == "failed")
        status = "warning" if written > 0 else "failed"
        error = f"{outcome}: exit {exit_code}; {failed} failed source(s)" + (f"; guard {guard}" if guard else "")

    started, finished = _parse(report.get("started_at")), _parse(report.get("finished_at"))
    return {
        "started_at": started.isoformat() if started else None,
        "finished_at": (finished or now).isoformat(),
        "duration_seconds": max(0, round((finished - started).total_seconds())) if started and finished else None,
        "companies_processed": len(sources),
        "total_active": None, "total_verified": None,
        "per_source_counts": {**per_source, PYTHON_RUN_KEY: meta},
        "status": status,
        "error": error,
    }


# ---- write (single bounded attempt) -------------------------------------------------------------

def post_run_record(row: dict[str, Any], url: str, key: str, *, timeout: float = WRITE_TIMEOUT_SECONDS,
                    opener: Callable[..., Any] | None = None) -> tuple[bool, str]:
    """One POST to PostgREST, no retries. Returns (ok, message); the message never contains the key."""
    req = urllib.request.Request(
        url.rstrip("/") + "/rest/v1/ingest_runs", data=json.dumps([row]).encode("utf-8"), method="POST",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
                 "Prefer": "return=minimal"})
    try:
        with (opener or urllib.request.urlopen)(req, timeout=timeout) as resp:
            code = getattr(resp, "status", None) or resp.getcode()
    except urllib.error.HTTPError as exc:
        body = exc.read(300).decode("utf-8", errors="replace").replace(key, "<redacted>") if exc.fp else ""
        return False, f"HTTP {exc.code}: {body}".strip()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return False, f"{type(exc).__name__}: {str(getattr(exc, 'reason', exc)).replace(key, '<redacted>')}"[:300]
    return (True, f"HTTP {code}") if 200 <= int(code) < 300 else (False, f"HTTP {code}")


# ---- expected sources (derived from checked-in seeds + cohort partition) --------------------------

def expected_sources_by_cohort(seeds_path: str | Path | None = None) -> dict[str, list[str]]:
    from scripts.scraper import run_ingestion as ri  # the runner's own planner, so the list cannot drift
    config = ri.load_company_seeds(seeds_path or ri.DEFAULT_SEEDS_PATH)
    plan = ri.plan_sources(config)
    return {c: sorted(p["id"] for p in ri.select_sources(plan, ri.normalize_source_filter(None, c), c)) for c in sorted(ri.COHORTS)}


def expected_sources_document(seeds_path: str | Path | None = None) -> dict[str, Any]:
    return {"generated_by": "python -m scripts.scraper.health_record expected-sources --write",
            "source": "scripts/scraper/company_seeds.json via run_ingestion.plan_sources/select_sources",
            "cohorts": expected_sources_by_cohort(seeds_path)}


# ---- CLI ------------------------------------------------------------------------------------------

def _summary(text: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


def _load_json(path: str | None) -> Any:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8")) if path else None
    except (OSError, ValueError):
        return None


def record(args: argparse.Namespace, *, opener: Callable[..., Any] | None = None, now: datetime | None = None) -> int:
    summary = _load_json(args.summary) or {"status": "no_report", "exit_code": args.exit_code or "n/a"}
    ingestion = f"ingestion result: {summary.get('status')} (exit {summary.get('exit_code')})"
    if args.mode != WRITE_MODE:
        print(f"health record skipped: mode {args.mode!r} is not {WRITE_MODE}; nothing written")
        return 0
    report = _load_json(args.report)
    if isinstance(report, dict) and report.get("dry_run", True):
        print("health record skipped: report is a dry run; nothing written")
        return 0
    row = build_run_record(report if isinstance(report, dict) else None, summary, args.cohort,
                           now or datetime.now(timezone.utc), dict(os.environ))
    from scripts.scraper.engine import WriteAuthorizationError, resolve_write_credentials
    try:
        url, key = resolve_write_credentials()
    except WriteAuthorizationError as exc:
        ok, msg = False, str(exc)
    else:
        ok, msg = post_run_record(row, url, key, opener=opener)
    if ok:
        print(f"health record written: python {args.cohort} status={row['status']} ({msg}); {ingestion}")
        _summary(f"Health record: written to ingest_runs (python {args.cohort}, status {row['status']}). {ingestion}.")
        return 0
    print(f"::error title=Health record not written [{args.cohort}]::{msg}. {ingestion} (unchanged).", file=sys.stderr)
    print(f"health record NOT written: {msg}", file=sys.stderr)
    _summary(f"**Health record NOT written** (python {args.cohort}): {msg}. {ingestion} (unchanged by this failure).")
    return 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("--cohort", required=True)
    r.add_argument("--mode", required=True)
    r.add_argument("--report")
    r.add_argument("--summary")
    r.add_argument("--exit-code", default="")
    e = sub.add_parser("expected-sources")
    g = e.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true")
    g.add_argument("--write", action="store_true")
    args = p.parse_args(argv)
    if args.cmd == "record":
        return record(args)
    doc = expected_sources_document()
    text = json.dumps(doc, indent=2) + "\n"
    if args.write:
        EXPECTED_SOURCES_PATH.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {EXPECTED_SOURCES_PATH.name}")
        return 0
    current = EXPECTED_SOURCES_PATH.read_text(encoding="utf-8") if EXPECTED_SOURCES_PATH.exists() else ""
    if current != text:
        print("expected_sources.json is out of date: run python -m scripts.scraper.health_record expected-sources --write",
              file=sys.stderr)
        return 1
    print("expected_sources.json matches the seed plan")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
