"""Offline intake of the company master Sheet (local CSV export) into review reports.

Writes only to --out-dir. Never touches company_seeds.json, the database or the network.

  python -m scripts.scraper.company_sheet_intake --csv master.csv --company-col Company \
      --website-col "Scraping Website" --out-dir out/intake

Every input row yields exactly one output record (keyed by its CSV row number; header = row 1).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from scripts.scraper import ats_detect as ad

REPORT_FIELDS = ["source_row", "company", "url_column", "original_url", "normalized_url", "normalized_domain",
                 "ats_candidate", "identifiers", "status", "reason", "merged_into_row", "review_groups"]
# Which URL wins when a row maps both columns and neither is an ATS candidate: the more specific outcome.
_STATUS_ORDER = [ad.CANDIDATE, ad.INCOMPLETE, ad.UNSUPPORTED, ad.LOOKALIKE, ad.WEBSITE, ad.AMBIGUOUS, ad.INVALID, ad.BLANK]


class MappingError(ValueError):
    pass


def read_rows(csv_path: Path, mapping: dict[str, str | None]) -> tuple[list[str], list[tuple[int, dict]]]:
    """mapping: {"company": header, "website": header|None, "careers": header|None}. Fails on any bad mapping."""
    with open(csv_path, newline="", encoding="utf-8-sig") as fh:
        reader = csv.reader(fh)
        headers = next(reader, None)
        if not headers:
            raise MappingError(f"{csv_path}: no header row")
        headers = [h.strip() for h in headers]
        dupes = sorted({h for h in headers if headers.count(h) > 1})
        if dupes:
            raise MappingError(f"duplicate headers {dupes}; mapping would be ambiguous")
        if not mapping.get("company"):
            raise MappingError(f"--company-col is required. Headers found: {headers}")
        if not (mapping.get("website") or mapping.get("careers")):
            raise MappingError(f"map at least one of --website-col / --careers-col. Headers found: {headers}")
        used = [v for v in mapping.values() if v]
        if len(set(used)) != len(used):
            raise MappingError(f"one header mapped to two roles: {mapping}")
        missing = [v for v in used if v not in headers]
        if missing:
            raise MappingError(f"mapped headers {missing} not in CSV. Headers found: {headers}")
        idx = {role: headers.index(col) for role, col in mapping.items() if col}
        rows = []
        for cells in reader:
            row_no = reader.line_num  # physical line of the record's end; equals sheet row unless cells hold newlines
            if not any(c.strip() for c in cells):
                rows.append((row_no, {"_shape": "empty row"}))
                continue
            rec = {role: (cells[i] if i < len(cells) else "") for role, i in idx.items()}
            if len(cells) != len(headers):
                rec["_shape"] = f"row has {len(cells)} cells, header has {len(headers)}"
            rows.append((row_no, rec))
    return headers, rows


def name_key(name: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", name).casefold().split())


def loose_name_key(name: str) -> str:
    return re.sub(r"[^\w]", "", name_key(name))


def build_record(row_no: int, rec: dict, mapping: dict) -> dict:
    company = (rec.get("company") or "").strip()
    tried = []
    for role in ("careers", "website"):
        col = mapping.get(role)
        if col:
            tried.append((col, rec.get(role, ""), ad.detect_ats(rec.get(role))))
    candidates = {(d["ats"], json.dumps(d["identifiers"], sort_keys=True)) for _, _, d in tried if d["status"] == ad.CANDIDATE}
    col, raw, det = min(tried, key=lambda t: _STATUS_ORDER.index(t[2]["status"]))
    status, reason = det["status"], det["reason"]
    if len(candidates) > 1:
        status, reason = ad.AMBIGUOUS, f"columns point at different ATS boards: {sorted(candidates)}"
    if rec.get("_shape"):
        status, reason = ad.INVALID if status != ad.BLANK else ad.BLANK, f"{rec['_shape']}; {reason}"
    if not company:
        status, reason = "blank_company", f"company name blank; url outcome was {det['status']}"
    return {"source_row": row_no, "company": company, "url_column": col, "original_url": raw,
            "normalized_url": det["normalized_url"], "normalized_domain": det["normalized_domain"],
            "ats_candidate": det["ats"], "identifiers": det["identifiers"], "status": status, "reason": reason,
            "all_urls": {c: r for c, r, _ in tried}, "merged_into_row": None, "review_groups": []}


def identity_key(r: dict) -> str | None:
    """Same URL identity: same ATS board, else same normalized URL. None when there is nothing to compare."""
    if r["ats_candidate"] and r["identifiers"]:
        return f"{r['ats_candidate']}:{json.dumps(r['identifiers'], sort_keys=True)}"
    return r["normalized_url"]


def dedupe(records: list[dict]) -> tuple[list[dict], list[dict]]:
    """Merges only exact-name + same-URL-identity rows. Everything else that looks similar becomes a review group."""
    merged: dict[tuple, list[dict]] = defaultdict(list)
    for r in records:
        key = identity_key(r)
        if r["company"] and key:
            merged[(name_key(r["company"]), key)].append(r)
    companies = []
    for group in merged.values():
        head = group[0]
        for r in group[1:]:
            r["merged_into_row"] = head["source_row"]
        companies.append({"company": head["company"], "canonical_row": head["source_row"],
                          "source_rows": [r["source_row"] for r in group],
                          "urls": sorted({u for r in group for u in r["all_urls"].values() if u.strip()}),
                          "ats_candidate": head["ats_candidate"], "identifiers": head["identifiers"], "status": head["status"]})
    singles = [r for r in records if not (r["company"] and identity_key(r))]
    for r in singles:  # unmergeable rows (blank/invalid url or blank name) are still companies to account for
        companies.append({"company": r["company"], "canonical_row": r["source_row"], "source_rows": [r["source_row"]],
                          "urls": sorted(u for u in r["all_urls"].values() if u.strip()),
                          "ats_candidate": r["ats_candidate"], "identifiers": r["identifiers"], "status": r["status"]})

    # Review groups: similar name, or same board/domain under different names. Never merged.
    buckets: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in records:
        if r["merged_into_row"] is not None:
            continue
        if r["company"]:
            buckets[("similar_name", loose_name_key(r["company"]))].append(r)
        if r["ats_candidate"] and r["identifiers"]:
            buckets[("same_ats_board", identity_key(r))].append(r)
        elif r["normalized_domain"] and r["status"] == ad.WEBSITE:
            buckets[("same_domain", r["normalized_domain"])].append(r)
    groups = []
    for (kind, key), rs in sorted(buckets.items(), key=lambda kv: kv[0]):
        if len(rs) < 2:
            continue
        gid = f"{kind}:{key}"
        for r in rs:
            r["review_groups"].append(gid)
        groups.append({"group": gid, "kind": kind, "source_rows": [r["source_row"] for r in rs],
                       "companies": sorted({r["company"] for r in rs}), "urls": sorted({r["original_url"] for r in rs})})
    return companies, groups


def run(csv_path: Path, mapping: dict, out_dir: Path) -> dict:
    headers, rows = read_rows(csv_path, mapping)
    records = [build_record(n, rec, mapping) for n, rec in rows]
    companies, groups = dedupe(records)
    merged_away = sum(1 for r in records if r["merged_into_row"] is not None)
    reconciliation = {
        "input_rows": len(rows), "output_records": len(records), "merged_duplicate_rows": merged_away,
        "unique_companies_after_merge": len(companies), "review_groups": len(groups),
        "rows_in_review_groups": len({n for g in groups for n in g["source_rows"]}),
        "by_status": dict(Counter(r["status"] for r in records).most_common()),
        "by_ats_candidate": dict(Counter(r["ats_candidate"] for r in records if r["status"] == ad.CANDIDATE).most_common()),
    }
    # Every row is reported once, and every row lands in exactly one company.
    assert reconciliation["output_records"] == reconciliation["input_rows"]
    assert sum(len(c["source_rows"]) for c in companies) == len(records)
    assert len(companies) == len(records) - merged_away

    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "intake_records.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=REPORT_FIELDS, extrasaction="ignore")
        w.writeheader()
        for r in records:
            w.writerow({**r, "identifiers": json.dumps(r["identifiers"], sort_keys=True) if r["identifiers"] else "",
                        "review_groups": "; ".join(r["review_groups"])})
    report = {"source_csv": str(csv_path), "headers": headers, "mapping": mapping,
              "note": "ats_candidate means the URL matches a board pattern; no board was fetched or verified.",
              "reconciliation": reconciliation, "records": records, "companies": companies, "review_groups": groups}
    (out_dir / "intake_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--csv", required=True, type=Path)
    p.add_argument("--out-dir", required=True, type=Path)
    p.add_argument("--company-col")
    p.add_argument("--website-col")
    p.add_argument("--careers-col")
    a = p.parse_args(argv)
    mapping = {"company": a.company_col, "website": a.website_col, "careers": a.careers_col}
    try:
        report = run(a.csv, mapping, a.out_dir)
    except (MappingError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(report["reconciliation"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
