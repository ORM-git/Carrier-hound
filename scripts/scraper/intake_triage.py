"""Offline triage of a company-sheet intake report (intake_report.json from PR #882's tool).

Buckets every source row exactly once, groups unsupported ATS records against the connectors that
actually exist in fetchers.py, classifies website-only URL shapes as discovery hints, and lists
missing-URL rows. Reads local files only; no network, no seeds, no DB.

  python -m scripts.scraper.intake_triage --report out/intake_report.json --out-dir out/triage

Nothing here verifies a board, a careers page or company ownership; every grouping is a hint for review.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlsplit

DEFAULT_FETCHERS = Path(__file__).resolve().parent / "fetchers.py"
SAMPLES = 5

# Primary bucket per report status. A merged row goes to "merged_duplicate" whatever its status.
STATUS_BUCKETS = {
    "ats_candidate": "connector_candidate", "ats_incomplete": "ats_incomplete", "unsupported_ats": "unsupported_ats",
    "rejected_lookalike": "rejected_lookalike", "website_only": "website_only", "blank": "missing_url",
    "blank_company": "missing_company", "invalid_url": "invalid_url", "ambiguous": "ambiguous",
}
BUCKETS = sorted({*STATUS_BUCKETS.values(), "merged_duplicate", "broken_merge_reference", "unrecognized_status"})

JOB_SOCIAL_HOSTS = (
    "linkedin.com", "indeed.com", "indeed.co.in", "glassdoor.com", "glassdoor.co.in", "naukri.com", "wellfound.com",
    "angel.co", "ycombinator.com", "instahyre.com", "cutshort.io", "internshala.com", "foundit.in", "monster.com",
    "twitter.com", "x.com", "facebook.com", "instagram.com", "youtube.com", "github.com", "medium.com", "notion.site",
    "notion.so", "docs.google.com", "sites.google.com", "forms.gle", "crunchbase.com", "t.me", "wa.me", "whatsapp.com",
)
FILE_EXTS = (".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".txt", ".zip", ".png", ".jpg", ".jpeg", ".gif")
_CAREERS_SEG = re.compile(r"^(careers?|jobs?|join|join-?us|work-with-us|openings|open-positions|vacanc(y|ies)|hiring|"
                          r"positions|opportunities|karriere|carreiras?|empleos?|stellenangebote)$")
_CAREERS_LABELS = {"careers", "career", "jobs", "join", "hiring"}
_HOME_SEG = re.compile(r"^([a-z]{2}(-[a-z]{2})?|home|index)$")
_URL_IN_TEXT = re.compile(r"[a-z][a-z0-9+.-]*://[^\s\"'|,]+", re.IGNORECASE)
_AT_TOKEN = re.compile(r"[^\s\"'|,]*@[^\s\"'|,]*\.[^\s\"'|,]*")  # user:pw@host, mail@host
_QUERY_TAIL = re.compile(r"(?<=[^\s\"'|,#])[?#][^\s\"'|,]*")  # attached tail only: Markdown "## Heading" survives
_NAME_DOT_TOKEN = re.compile(r"\b[a-z0-9][a-z0-9-]*\.[a-z]{2,}\b", re.IGNORECASE)


class TriageError(ValueError):
    pass


# ---- URLs ---------------------------------------------------------------------------------------

def split_url(url: object) -> tuple[str, int | None, str] | None:
    """(host, non-default port, path) with host lowercased, trailing dot and www. stripped. None if unparseable."""
    if not isinstance(url, str) or not url.strip():
        return None
    value = url.strip()
    if "://" not in value:
        value = "https://" + value
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    host = (parts.hostname or "").rstrip(".").lower()
    if not host or parts.scheme.lower() not in ("http", "https"):
        return None
    if host.startswith("www."):
        host = host[4:]
    return host, (None if port in (None, 80, 443) else port), parts.path


def redact_url(url: object) -> str | None:
    """Display form: no credentials, query or fragment."""
    if url is None or (isinstance(url, str) and not url.strip()):
        return None
    parts = split_url(url)
    if not parts:
        return "<unparseable>"
    host, port, path = parts
    return f"https://{host}{f':{port}' if port else ''}{path}"


def redact_text(text: object) -> str:
    """Strips query, fragment and credentials from free text: URLs are reduced to host+path, any other
    ?…/#… tail is dropped, and tokens with an @ are replaced."""
    text = _URL_IN_TEXT.sub(lambda m: redact_url(m.group(0)) or "", str(text or ""))
    return _QUERY_TAIL.sub("", _AT_TOKEN.sub("<redacted>", text))


def scrub(obj):
    """Final pass over everything written: every string, keys included, goes through redact_text."""
    if isinstance(obj, dict):
        return {redact_text(k) if isinstance(k, str) else k: scrub(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [scrub(v) for v in obj]
    return redact_text(obj) if isinstance(obj, str) else obj


def _on(host: str, base: str) -> bool:
    return host == base or host.endswith("." + base)


def website_evidence(url: object) -> tuple[str, str]:
    """(class, reason). URL shape only: a hint for discovery, never proof of a careers page or ownership."""
    parts = split_url(url)
    if not parts:
        return "unknown", "url not parseable"
    host, _, path = parts
    segs = [s.lower() for s in path.split("/") if s]
    if any(_on(host, h) for h in JOB_SOCIAL_HOSTS):
        return "job_board_or_social", f"host {host} is a job board, social or document host"
    if segs and segs[-1].endswith(FILE_EXTS):
        return "file", f"path ends in a file ({segs[-1].rsplit('.', 1)[-1]})"
    stems = [s.rsplit(".", 1)[0] if s.endswith((".html", ".htm", ".php", ".aspx")) else s for s in segs]
    hit = next((s for s in stems if _CAREERS_SEG.match(s)), None)
    if hit:
        return "explicit_careers_path", f"path segment /{hit}"
    if host.split(".")[0] in _CAREERS_LABELS:
        return "explicit_careers_path", f"host label {host.split('.')[0]}."
    if all(_HOME_SEG.match(s) for s in stems):
        return "homepage_like", "no path beyond locale/index"
    return "unknown", "path does not indicate careers or homepage"


# ---- connector evidence -------------------------------------------------------------------------

def connector_evidence(fetchers_path: Path) -> dict[str, dict]:
    """function name -> {function, line, api_hosts} for top-level fetch_* functions in fetchers.py (parsed, not imported)."""
    try:
        tree = ast.parse(fetchers_path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError) as exc:
        raise TriageError(f"cannot read connector code {fetchers_path}: {exc}") from exc
    out = {}
    for fn in tree.body:
        if not (isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name.startswith("fetch_")):
            continue
        hosts = set()
        for node in ast.walk(fn):
            if isinstance(node, ast.JoinedStr):
                text = "".join(v.value if isinstance(v, ast.Constant) else "{}" for v in node.values)
            elif isinstance(node, ast.Constant) and isinstance(node.value, str):
                text = node.value
            else:
                continue
            m = re.match(r"https://([^/?#]+)", text)
            if m and m.group(1).strip("{}"):
                hosts.add(m.group(1))
        out[fn.name] = {"function": fn.name, "line": fn.lineno, "api_hosts": sorted(hosts)}
    if not out:
        raise TriageError(f"no fetch_* connector functions found in {fetchers_path}; refusing to classify connectors")
    return out


def find_connectors(connectors: dict[str, dict], vendor: str) -> list[dict]:
    """Whole-word vendor match: fetch_workday_cxs serves "workday", never "workable" or "work".
    shortcut: relies on fetch_<vendor>[_suffix] naming in fetchers.py; upgrade if a fetcher is renamed."""
    return [c for name, c in sorted(connectors.items()) if name == f"fetch_{vendor}" or name.startswith(f"fetch_{vendor}_")]


# ---- report loading -----------------------------------------------------------------------------

def load_records(report: object) -> tuple[list[dict], int | None]:
    if not isinstance(report, dict) or not isinstance(report.get("records"), list):
        raise TriageError("report must be an object with a 'records' list")
    seen = set()
    for i, r in enumerate(report["records"]):
        row = r.get("source_row") if isinstance(r, dict) else None
        if not isinstance(row, int) or isinstance(row, bool):
            raise TriageError(f"records[{i}] has no integer source_row; rows cannot be reconciled")
        if row in seen:
            raise TriageError(f"source_row {row} appears twice")
        seen.add(row)
    declared = (report.get("reconciliation") or {}).get("input_rows") if isinstance(report.get("reconciliation"), dict) else None
    if isinstance(declared, int) and declared != len(report["records"]):
        raise TriageError(f"report declares {declared} input rows but holds {len(report['records'])} records")
    return sorted(report["records"], key=lambda r: r["source_row"]), declared if isinstance(declared, int) else None


def _lines(r: dict):
    v = r.get("source_lines")
    return v if isinstance(v, list) and len(v) == 2 and all(isinstance(x, int) for x in v) else None


def _url(r: dict):
    return r.get("normalized_url") or r.get("original_url")


def _str(v) -> str:
    return v if isinstance(v, str) else ""


def primary_bucket(r: dict, rows: dict[int, dict]) -> tuple[str, str]:
    target = r.get("merged_into_row")
    if target is not None:
        if isinstance(target, int) and target in rows and target != r["source_row"] and rows[target].get("merged_into_row") is None:
            return "merged_duplicate", "merged into a retained row (see references.proven_merges)"
        return "broken_merge_reference", f"merged_into_row {target!r} is not a retained row in this report"
    status = r.get("status")
    if status in STATUS_BUCKETS:
        return STATUS_BUCKETS[status], redact_text(r.get("reason")) or status
    return "unrecognized_status", f"status {status!r} not known to triage"


def check_partition(row_ids: list[int], buckets: dict[str, list[int]]) -> None:
    """Every source row in exactly one bucket: raises on a dropped, double-counted or unknown row."""
    counted = Counter(n for rows in buckets.values() for n in rows)
    missing = sorted(set(row_ids) - set(counted))
    doubled = sorted(n for n, c in counted.items() if c > 1)
    unknown = sorted(set(counted) - set(row_ids))
    if missing or doubled or unknown:
        raise TriageError(f"row reconciliation failed: dropped={missing[:10]} double={doubled[:10]} unknown={unknown[:10]}")


# ---- triage -------------------------------------------------------------------------------------

def _sample(r: dict) -> dict:
    return {"source_row": r["source_row"], "source_lines": _lines(r), "company": _str(r.get("company")), "url": redact_url(_url(r))}


def triage(report: dict, connectors: dict[str, dict]) -> dict:
    records, declared = load_records(report)
    rows = {r["source_row"]: r for r in records}
    assigned: dict[str, list[dict]] = defaultdict(list)
    row_index = []
    for r in records:
        bucket, reason = primary_bucket(r, rows)
        assigned[bucket].append({**r, "_reason": reason})
        row_index.append({"source_row": r["source_row"], "source_lines": _lines(r), "bucket": bucket,
                          "merged_into_row": r.get("merged_into_row") if bucket == "merged_duplicate" else None})
    check_partition([r["source_row"] for r in records], {b: [r["source_row"] for r in rs] for b, rs in assigned.items()})

    buckets = {}
    for b in BUCKETS:
        rs = assigned.get(b, [])
        buckets[b] = {"count": len(rs), "source_rows": [r["source_row"] for r in rs],
                      "reasons": dict(sorted(Counter(r["_reason"] for r in rs).items(), key=lambda kv: (-kv[1], kv[0]))),
                      "samples": [_sample(r) for r in rs[:SAMPLES]]}

    def vendor_groups(rs: list[dict], clean: bool) -> list[dict]:
        by_vendor: dict[str, list[dict]] = defaultdict(list)
        for r in rs:
            by_vendor[_str(r.get("ats_candidate")) or "<unidentified>"].append(r)
        out = []
        for vendor, vrs in sorted(by_vendor.items()):
            hosts = Counter((split_url(_url(r)) or ("<unparseable>",))[0] for r in vrs)
            found = [] if vendor == "<unidentified>" else find_connectors(connectors, vendor)
            where = ", ".join(f"{c['function']} (fetchers.py:{c['line']})" for c in found)
            if vendor == "<unidentified>":
                verdict, why = "unresolved", "report gives no vendor for these rows"
            elif not found:
                verdict, why = "unsupported", f"no fetch_{vendor} connector in fetchers.py"
            elif clean:
                verdict, why = "supported", f"{where} exists; URL candidates are unverified"
            else:  # intake already judged these rows unusable by the connector (e.g. EU Greenhouse); never upgraded here
                called = ", ".join(sorted({h for c in found for h in c["api_hosts"]}))
                verdict, why = "unresolved", f"{where} calls {called}; observed hosts are not shown to be served by it"
            out.append({"vendor": vendor, "connector": verdict, "reason": why, "count": len(vrs),
                        "hosts": dict(sorted(hosts.items(), key=lambda kv: (-kv[1], kv[0]))),
                        "source_rows": [r["source_row"] for r in vrs], "samples": [_sample(r) for r in vrs[:SAMPLES]]})
        return out

    web: dict[str, list[dict]] = defaultdict(list)
    for r in assigned.get("website_only", []):
        cls, why = website_evidence(_url(r))
        web[cls].append({**r, "_why": why})
    website = {cls: {"count": len(web.get(cls, [])), "source_rows": [r["source_row"] for r in web.get(cls, [])],
                     "reasons": dict(sorted(Counter(r["_why"] for r in web.get(cls, [])).items(), key=lambda kv: (-kv[1], kv[0]))),
                     "samples": [_sample(r) for r in web.get(cls, [])[:SAMPLES]]}
               for cls in ("explicit_careers_path", "homepage_like", "job_board_or_social", "file", "unknown")}

    groups = report.get("review_groups") if isinstance(report.get("review_groups"), list) else []
    groups_by_row: dict[int, list[str]] = defaultdict(list)
    possible = []
    for g in sorted((g for g in groups if isinstance(g, dict)), key=lambda g: _str(g.get("group"))):
        refs = [n for n in g.get("source_rows") or [] if isinstance(n, int)]
        for n in refs:
            groups_by_row[n].append(_str(g.get("group")))
        possible.append({"group": _str(g.get("group")), "kind": _str(g.get("kind")) or None, "source_rows": sorted(refs),
                         "unknown_rows": sorted(n for n in refs if n not in rows),
                         "url_samples": sorted({redact_url(u) for u in g.get("urls") or [] if redact_url(u)})[:SAMPLES]})

    missing = []
    for r in assigned.get("missing_url", []):
        name = _str(r.get("company"))
        siblings = sorted({n for g in groups if isinstance(g, dict) and r["source_row"] in (g.get("source_rows") or [])
                           for n in g.get("source_rows") or [] if n != r["source_row"] and n in rows and _url(rows[n])})
        hints = [{"kind": "name_contains_dot_token", "value": t, "note": "text in the name; not a verified domain"}
                 for t in _NAME_DOT_TOKEN.findall(name)]
        if siblings:
            hints.append({"kind": "review_group_rows_with_urls", "value": siblings, "note": "possible duplicates; not proof"})
        missing.append({"source_row": r["source_row"], "source_lines": _lines(r), "company": name,
                        "review_groups": sorted(groups_by_row.get(r["source_row"], [])), "hints": hints})

    merges: dict[int, list[int]] = defaultdict(list)
    for r in assigned.get("merged_duplicate", []):
        merges[r["merged_into_row"]].append(r["source_row"])
    ambiguous = [{"source_row": r["source_row"], "source_lines": _lines(r), "bucket": i["bucket"],
                  "reason": redact_text(r.get("reason")), "candidate_boards": sorted(r.get("candidate_boards") or [])}
                 for r, i in zip(records, row_index)
                 if r.get("status") == "ambiguous" or len(r.get("candidate_boards") or []) > 1]

    return {
        "note": "Triage of URL shape and report statuses only. No board, careers page, domain or ownership was verified.",
        "reconciliation": {"input_rows": len(records), "declared_input_rows": declared,
                           "bucketed_rows": sum(b["count"] for b in buckets.values()),
                           "by_bucket": {b: buckets[b]["count"] for b in BUCKETS}},
        "buckets": buckets,
        "connectors": {"evidence": {name: connectors[name] for name in sorted(connectors)},
                       "unsupported_ats_groups": vendor_groups(assigned.get("unsupported_ats", []), clean=False),
                       "ats_incomplete_groups": vendor_groups(assigned.get("ats_incomplete", []), clean=False),
                       "candidate_groups": vendor_groups(assigned.get("connector_candidate", []), clean=True)},
        "website_evidence": website,
        "missing_urls": missing,
        "references": {  # cross-references to rows already bucketed above; never counted again
            "proven_merges": [{"retained_row": k, "merged_rows": sorted(v)} for k, v in sorted(merges.items())],
            "possible_duplicates": possible,
            "ambiguous": ambiguous,
        },
        "rows": row_index,
    }


def render_markdown(t: dict, sha: str) -> str:
    rec = t["reconciliation"]
    out = ["# Company intake triage", "", f"Input sha256 `{sha}`. {t['note']}", "",
           f"**Reconciliation:** {rec['input_rows']} input rows -> {rec['bucketed_rows']} bucketed rows "
           f"(declared by report: {rec['declared_input_rows']}). Each row is in exactly one bucket.", "",
           "| Bucket | Rows | Top reason | Sample rows |", "|---|---|---|---|"]
    for b, v in t["buckets"].items():
        if v["count"]:
            top = next(iter(v["reasons"]), "")
            out.append(f"| {b} | {v['count']} | {top} | {', '.join(str(s['source_row']) for s in v['samples'])} |")
    out += ["", "## Connector groups (evidence, not working boards)", "", "| Bucket | Vendor | Rows | Connector | Reason |", "|---|---|---|---|---|"]
    for key in ("candidate_groups", "unsupported_ats_groups", "ats_incomplete_groups"):
        for g in t["connectors"][key]:
            out.append(f"| {key.replace('_groups', '')} | {g['vendor']} | {g['count']} | {g['connector']} | {g['reason']} |")
    out += ["", "## Website-only URL evidence (discovery hints only)", "", "| Class | Rows | Sample URLs (redacted) |", "|---|---|---|"]
    for cls, v in t["website_evidence"].items():
        out.append(f"| {cls} | {v['count']} | {', '.join(s['url'] or '' for s in v['samples'][:3])} |")
    refs = t["references"]
    with_hints = sum(1 for m in t["missing_urls"] if m["hints"])
    out += ["", "## References (rows already counted above)", "",
            f"- Missing URL rows: {len(t['missing_urls'])} ({with_hints} with a hint present in the report; no domains invented)",
            f"- Proven merges: {len(refs['proven_merges'])} retained rows absorbing "
            f"{sum(len(m['merged_rows']) for m in refs['proven_merges'])} rows",
            f"- Possible duplicates needing review: {len(refs['possible_duplicates'])} groups",
            f"- Ambiguous / conflicting rows: {len(refs['ambiguous'])}", ""]
    return "\n".join(out)


def run(report_path: Path, out_dir: Path, fetchers_path: Path = DEFAULT_FETCHERS) -> dict:
    raw = report_path.read_bytes()
    try:
        report = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TriageError(f"{report_path} is not valid JSON: {exc}") from exc
    t = triage(report, connector_evidence(fetchers_path))
    sha = hashlib.sha256(raw).hexdigest()
    t = scrub({"input_sha256": sha, **t})
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "intake_triage.json").write_text(json.dumps(t, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    (out_dir / "intake_triage.md").write_text(redact_text(render_markdown(t, sha)), encoding="utf-8", newline="\n")
    return t


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--report", required=True, type=Path)
    p.add_argument("--out-dir", required=True, type=Path)
    p.add_argument("--fetchers", type=Path, default=DEFAULT_FETCHERS, help="connector source to compare against")
    a = p.parse_args(argv)
    try:
        t = run(a.report, a.out_dir, a.fetchers)
    except (TriageError, OSError) as exc:
        print(f"error: {redact_text(exc)}", file=sys.stderr)
        return 2
    print(json.dumps(t["reconciliation"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
