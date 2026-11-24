"""
Per-cohort ingestion reports and the honest aggregate (stdlib only, so CI needs no extra installs).

    python -m scripts.scraper.ingest_report cohort --cohort workday --report r.json --exit-code 1 --out s.json
    python -m scripts.scraper.ingest_report aggregate --dir reports --expect non-workday,workday

A cohort is "ok" only when the runner exited 0 with a parseable report. The aggregate is "ok" only when
every expected cohort is ok; a missing report counts as failed, never as zero. Fetched jobs are not newly
added jobs: only persisted counts from a write run are confirmed writes, dry runs report projections.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any


PER_SOURCE_COLUMNS = ("source", "status", "fetched", "validated", "rejected", "salary_sanitized", "duplicate_skipped",
                      "inserted", "updated", "failed", "expired", "cooldown_reason", "next_eligible_at", "last_success_at")


def cohort_summary(report: dict[str, Any] | None, exit_code: str | int | None, cohort: str) -> dict[str, Any]:
    code = str(exit_code) if exit_code not in (None, "") else "n/a"
    if not isinstance(report, dict):
        return {"cohort": cohort, "status": "no_report", "exit_code": code}
    db = report.get("db") if isinstance(report.get("db"), dict) else {}
    dry_run = bool(report.get("dry_run", True))
    persisted = report.get("persisted_counts") if not dry_run else None
    failed = [
        {"source": str(f.get("source")), "error": str(f.get("error") or "")[:300].replace("\n", " ")}
        for f in (report.get("failed_sources") or []) if isinstance(f, dict)
    ]
    return {
        "cohort": cohort,
        # exit 3 = deferred no-op (nothing written): explicitly not ok, so the aggregate is never green on it
        "status": "ok" if code == "0" else ("deferred_noop" if code == "3" else "failed"),
        "exit_code": code,
        "dry_run": dry_run,
        "git_sha": report.get("git_sha"),
        "started_at": report.get("started_at"),
        "finished_at": report.get("finished_at"),
        "selected_sources": len(report.get("selected_sources") or report.get("sources") or []),
        "completed_sources": len(report.get("completed_sources") or []),
        "enrichment_warnings": report.get("enrichment_warnings") or [],
        "failed_sources": failed,
        "fetched": report.get("fetched"),
        "deduped": report.get("selected"),
        "validated": report.get("validated"),
        "rejected": int(report.get("rejected_count") or len(report.get("rejected") or [])),
        "rejected_samples": [
            {k: str(r.get(k) or "")[:160] for k in ("source_key", "stage", "code", "reason")}
            for r in (report.get("rejected") or [])[:10] if isinstance(r, dict)
        ],
        "failed_writes": int(db.get("failed_writes") or 0),
        "workday": report.get("workday"),
        "deferred_sources": [
            {"source": str(d.get("source")), "reason": str(d.get("reason") or "")[:120], "next_eligible_at": d.get("next_eligible_at")}
            for d in (report.get("deferred_sources") or []) if isinstance(d, dict)
        ],
        "salary_sanitized": int(report.get("salary_sanitized_count") or 0),
        "duplicate_skipped": int(report.get("duplicate_skipped_count") or 0),
        "duplicate_samples": [
            {k: str(r.get(k) or "")[:160] for k in ("source_key", "stage", "code", "reason")}
            for r in (report.get("duplicate_skipped") or [])[:10] if isinstance(r, dict)
        ],
        "per_source": [
            {k: src.get(k) for k in PER_SOURCE_COLUMNS}
            for src in (report.get("sources") or []) if isinstance(src, dict)
        ],
        "projected": report.get("projected_counts") if dry_run else None,
        "confirmed_writes": None if dry_run or not isinstance(persisted, dict) else {
            "inserted": persisted.get("inserted"),
            "updated": persisted.get("updated"),
            "unchanged": persisted.get("unchanged"),
            "expired": db.get("expired"),
        },
        "persistence_failed": bool(db.get("persistence_failed")),
        "write_errors": [str(e)[:300] for e in (db.get("write_errors") or [])][:10],
        "expiry_failures": [
            str(e.get("source_id")) for e in (report.get("expiry_reports") or [])
            if isinstance(e, dict) and e.get("status") == "failed"
        ],
        "guard_block_reason": report.get("guard_block_reason"),
        "logo_enqueue": {
            "requested": int((report.get("logo_enqueue") or {}).get("requested", 0)),
            "enqueued": int((report.get("logo_enqueue") or {}).get("enqueued", 0)),
            "status": str((report.get("logo_enqueue") or {}).get("status", "skipped")),
            "coverage": (report.get("logo_enqueue") or {}).get("coverage"),
        },
    }


def render_cohort(s: dict[str, Any]) -> str:
    title = f"### Python ingestion [{s['cohort']}]: {s['status'].upper()} (exit {s['exit_code']})"
    if s["status"] == "no_report":
        return f"{title}\n\nNo report: auth refusal, crash or timeout before the runner printed it. Counts unknown, not zero."
    rows = [
        ("mode", "DRY RUN (projections only)" if s["dry_run"] else "write"),
        ("sha", s.get("git_sha")), ("started", s.get("started_at")), ("finished", s.get("finished_at")),
        ("sources selected / completed / failed",
         f"{s['selected_sources']} / {s['completed_sources']} / {len(s['failed_sources'])}"),
        ("fetched (not new jobs)", s.get("fetched")), ("unique after dedupe", s.get("deduped")),
        ("validated / rejected", f"{s.get('validated')} / {s.get('rejected', 0)}"),
        ("salary sanitized (non-finite -> null, job kept)", s.get("salary_sanitized", 0)),
        ("duplicate apply_url skipped (existing job kept; not a failure)", s.get("duplicate_skipped", 0)),
    ]
    wd = s.get("workday")
    if isinstance(wd, dict):
        rows.append(("workday selected / attempted / completed / failed / deferred",
                     f"{wd.get('selected')} / {wd.get('attempted')} / {wd.get('completed')} / {wd.get('failed')} / {wd.get('deferred')}"))
        rows.append(("workday cooldown state", f"{wd.get('state_status')} (request cap {wd.get('request_cap')})"))
    if s["dry_run"]:
        p = s.get("projected") or {}
        rows.append(("projected insert / update / unchanged", f"{p.get('inserted')} / {p.get('updated')} / {p.get('unchanged')}"))
    else:
        c = s.get("confirmed_writes") or {}
        rows += [("confirmed inserted", c.get("inserted")), ("confirmed updated", c.get("updated")),
                 ("unchanged", c.get("unchanged")), ("failed writes", s.get("failed_writes", 0)),
                 ("expired", c.get("expired"))]
    rows += [("persistence failed", s["persistence_failed"]), ("guard", s.get("guard_block_reason") or "none")]
    logo = s.get("logo_enqueue") or {}
    cov = logo.get("coverage")
    cov_str = "n/a" if cov is None else (json.dumps(cov) if isinstance(cov, dict) else str(cov))
    rows += [
        ("company logos requested / enqueued / status", f"{logo.get('requested', 0)} / {logo.get('enqueued', 0)} / {logo.get('status', 'skipped')}"),
        ("company logo coverage", cov_str),
    ]
    lines = [title, "", "| metric | value |", "|---|---|"] + [f"| {k} | {v} |" for k, v in rows]
    if s["failed_sources"]:
        lines += ["", "**Failed sources (this cohort's writes and expiry withheld):**", ""]
        lines += [f"- `{f['source']}`: {f['error']}" for f in s["failed_sources"]]
    if s.get("per_source"):
        lines += ["", "| " + " | ".join(c.replace("_", " ") for c in PER_SOURCE_COLUMNS) + " |",
                  "|" + "---|" * len(PER_SOURCE_COLUMNS)]
        lines += ["| " + " | ".join(str(p.get(k) if p.get(k) is not None else "-") for k in PER_SOURCE_COLUMNS) + " |"
                  for p in s["per_source"]]
    if s.get("duplicate_samples"):
        lines += ["", f"**Duplicate apply_url rows skipped ({s.get('duplicate_skipped', 0)}; existing job kept):**", ""]
        lines += [f"- `{r['source_key']}` [{r['stage']}] {r['reason']}" for r in s["duplicate_samples"]]
    if s.get("enrichment_warnings"):
        lines += ["", "**Pay detail warnings (rows withheld, affected board expiry skipped):**", ""]
        lines += [f"- `{w['source_id']}/{w['source_job_id']}`: {w['reason']}" for w in s["enrichment_warnings"]]
    if s.get("deferred_sources"):
        lines += ["", "**Deferred Workday boards (not attempted this run; not a success):**", ""]
        lines += [f"- `{d['source']}`: {d['reason']} (next eligible {d['next_eligible_at'] or 'next run'})" for d in s["deferred_sources"]]
    if s.get("rejected_samples"):
        lines += ["", f"**Rejected rows ({s.get('rejected', 0)}; not persisted, board expiry withheld):**", ""]
        lines += [f"- `{r['source_key']}` [{r['stage']}] {r['reason']}" for r in s["rejected_samples"]]
    return "\n".join(lines)


def annotations(s: dict[str, Any]) -> list[str]:
    out = [f"::error title=Ingestion source failed [{s['cohort']}]::{f['source']}: {f['error']}" for f in s.get("failed_sources") or []]
    out += [f"::error title=Ingestion write error [{s['cohort']}]::{e}" for e in s.get("write_errors") or []]
    out += [f"::error title=Ingestion row rejected [{s['cohort']}]::{r['source_key']}: {r['reason']}" for r in s.get("rejected_samples") or []]
    out += [f"::warning title=Ingestion pay detail unavailable [{s['cohort']}]::{w['source_id']}/{w['source_job_id']}: {w['reason']}; row withheld, board expiry skipped" for w in s.get("enrichment_warnings") or []]
    if s["status"] == "deferred_noop":
        out.append(f"::warning title=Ingestion no-op [{s['cohort']}]::every selected Workday board was deferred; nothing written")
    if s["status"] == "no_report":
        out.append(f"::error title=Ingestion report missing [{s['cohort']}]::exit {s['exit_code']}")
    return out


def aggregate(summaries: list[dict[str, Any]], expected: list[str]) -> tuple[str, str]:
    by_cohort = {s["cohort"]: s for s in summaries}
    states = {c: (by_cohort[c]["status"] if c in by_cohort else "missing") for c in expected}
    ok = [c for c, st in states.items() if st == "ok"]
    overall = "ok" if len(ok) == len(expected) else ("degraded" if ok else "failed")
    lines = [f"## Python ingestion overall: {overall.upper()}", "", "| cohort | result |", "|---|---|"]
    lines += [f"| {c} | {st} |" for c, st in states.items()]
    return overall, "\n".join(lines)


def _write_summary(text: str) -> None:
    print(text)
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cohort")
    c.add_argument("--cohort", required=True)
    c.add_argument("--report", required=True)
    c.add_argument("--exit-code", default="")
    c.add_argument("--out", required=True)
    a = sub.add_parser("aggregate")
    a.add_argument("--dir", required=True)
    a.add_argument("--expect", required=True)
    args = parser.parse_args(argv)

    if args.cmd == "cohort":
        try:
            report = json.loads(Path(args.report).read_text(encoding="utf-8"))
        except Exception:
            report = None
        summary = cohort_summary(report, args.exit_code, args.cohort)
        Path(args.out).write_text(json.dumps(summary, indent=2), encoding="utf-8")
        for line in annotations(summary):
            print(line)
        _write_summary(render_cohort(summary))
        return 0

    summaries = []
    for path in sorted(Path(args.dir).rglob("python-ingest-summary-*.json")):
        try:
            summaries.append(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            continue
    expected = [x for x in args.expect.split(",") if x]
    overall, text = aggregate(summaries, expected)
    _write_summary(text)
    return 0 if overall == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
