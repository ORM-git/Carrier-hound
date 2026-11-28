"""Seed proposals from intake + board verification. Writes local files only; never edits company_seeds.json.

  python -m scripts.scraper.seed_proposal --intake out/intake/intake_report.json \
      --verification out/verify/verification_results.json [--metadata reviewed_metadata.json] --out-dir out/proposal

Outputs (in --out-dir):
  proposed_seeds.json                      {"layer1_public_ats": [...]} production proposals only, exact seed schema
  proposed_seeds.TEST_ONLY_SYNTHETIC.json  proposals backed only by synthetic fixture evidence, under a key no loader reads
  seed_review_report.json                  every intake record once: proposal status, provenance, unresolved fields,
                                           conflicts, verification evidence, or the reason it was skipped

A production proposal needs every seed field resolved, no conflict, and a live verification with usable jobs. This
build has no live verification, so only fixtures can be supplied and production stays empty.

--metadata (optional, reviewer supplied): [{"source_row": int, "canonical_domain": str|null, "category": str|null,
"provenance": str}]. Without it, category stays unresolved: the sheet has none and no documented seed default exists.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from scripts.scraper import board_verify as bv
from scripts.scraper.enrichment import COMPANY_CATEGORIES

SEED_FIELDS = ("slug", "name", "ats", "token", "canonical_domain", "category")  # company_seeds.json layer1 entry
TEST_ONLY_KEY = "TEST_ONLY_SYNTHETIC_FIXTURE_PROPOSALS_DO_NOT_SEED"
PRODUCTION = "production_proposal"
TEST_ONLY = "test_only_proposal"
UNRESOLVED = "unresolved"
NOT_QUALIFIED = "not_qualified"
_LABEL_RE = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_ATS_BASES = ("greenhouse.io", "lever.co", "ashbyhq.com", "smartrecruiters.com", "myworkdayjobs.com", "myworkdaysite.com")
# Hosts that are profiles or platforms, never a company's own domain.
_THIRD_PARTY = ("linkedin.com", "facebook.com", "twitter.com", "x.com", "instagram.com", "github.com", "google.com",
                "wellfound.com", "angel.co", "notion.site", "crunchbase.com", "glassdoor.com", "indeed.com")


def _on(host: str, base: str) -> bool:
    return host == base or host.endswith("." + base)


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKC", name).casefold()).strip("-")


def domain_from_url(raw: Any) -> tuple[str | None, str | None]:
    """(host, problem). Host is lowercased, www. stripped; problem explains why it cannot be a canonical domain."""
    value = (raw or "").strip() if isinstance(raw, str) else ""
    if not value:
        return None, "no website value"
    try:
        host = (urlsplit(value if "://" in value else "https://" + value).hostname or "").rstrip(".")
    except ValueError:
        return None, "website value is not a URL"
    host = host[4:] if host.startswith("www.") else host
    labels = host.split(".")
    if len(labels) < 2 or not all(_LABEL_RE.match(x) for x in labels) or labels[-1].isdigit():
        return None, f"website host {host!r} is not a valid domain"
    if any(_on(host, b) for b in _ATS_BASES):
        return None, f"website host {host} is an ATS host, not the company domain"
    if any(_on(host, b) for b in _THIRD_PARTY):
        return None, f"website host {host} is a third-party profile, not the company domain"
    if len(labels) > 2:
        return host, f"website host {host} is a subdomain; registrable domain not determined"
    return host, None


def load_metadata(raw: Any, eligible_rows: set[Any]) -> tuple[dict[Any, dict[str, Any]], list[dict[str, Any]]]:
    """source_row -> reviewed metadata; problems are kept for the report, never dropped."""
    if raw is None:
        return {}, []
    if not isinstance(raw, list):
        raise bv.IntakeError("metadata must be a JSON list")
    out: dict[Any, dict[str, Any]] = {}
    problems: list[dict[str, Any]] = []
    for m in raw:
        row = m.get("source_row") if isinstance(m, dict) else None
        if not isinstance(m, dict) or not isinstance(row, int) or isinstance(row, bool):
            problems.append({"metadata": m, "problem": "entry needs an integer source_row"})
        elif row not in eligible_rows:
            problems.append({"metadata": m, "problem": f"row {row} is not an eligible candidate"})
        elif row in out and out[row] != m:
            problems.append({"metadata": m, "problem": f"conflicting metadata for row {row}"})
            out[row]["_conflict"] = True
        else:
            out[row] = m
    return out, problems


def load_verification(raw: Any, eligible_ids: set[str]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    if raw is None:
        return {}, []
    results = raw.get("results") if isinstance(raw, dict) else None
    if not isinstance(results, list):
        raise bv.IntakeError("verification file has no results list (expected board_verify verification_results.json)")
    file_evidence = raw.get("evidence")
    out: dict[str, dict[str, Any]] = {}
    problems: list[dict[str, Any]] = []
    for r in results:
        bid = r.get("board_id") if isinstance(r, dict) else None
        # Anything not explicitly live at both file and result level is treated as synthetic.
        if isinstance(r, dict) and not (file_evidence == bv.LIVE and r.get("evidence") == bv.LIVE):
            r = {**r, "evidence": bv.SYNTHETIC}
        if bid not in eligible_ids:
            problems.append({"result": r, "problem": "board is not an eligible candidate in this intake"})
        elif bid in out and out[bid].get("outcome") != r.get("outcome"):
            problems.append({"result": r, "problem": f"conflicting verification results for {bid}"})
            out[bid] = {**out[bid], "_conflict": True}
        else:
            out[bid] = r
    return out, problems


def propose(intake: Any, seeds: dict[str, Any], verification: Any = None, metadata: Any = None) -> dict[str, Any]:
    eligible, skipped = bv.select_candidates(intake, seeds)
    verified, verify_problems = load_verification(verification, {e["board_id"] for e in eligible})
    meta, meta_problems = load_metadata(metadata, {e["source_row"] for e in eligible})
    website_col = (intake.get("mapping") or {}).get("website")

    proposals = []
    for e in eligible:
        rec, row = e["record"], e["source_row"]
        unresolved: dict[str, str] = {}
        conflicts: list[str] = []
        prov: dict[str, Any] = {"source_row": row, "original_url": rec.get("original_url"), "all_urls": rec.get("all_urls"),
                                "intake_status": rec.get("status"), "intake_reason": rec.get("reason"),
                                "name": "sheet company column", "ats/token": "intake ats_candidate/identifiers",
                                "slug": "derived from name (lowercase, non-alphanumerics to '-')"}
        slug = slugify(e["company"]) or None
        if not slug:
            unresolved["slug"] = "name has no ASCII letters or digits to derive a slug"

        sheet_domain, domain_problem = (domain_from_url((rec.get("all_urls") or {}).get(website_col)) if website_col
                                        else (None, "intake mapped no website column"))
        m = meta.get(row) or {}
        if m.get("_conflict"):
            conflicts.append("conflicting reviewer metadata entries for this row")
        meta_domain = m.get("canonical_domain")
        if meta_domain is not None:
            md, mp = domain_from_url(meta_domain)
            if mp and md is None:
                conflicts.append(f"metadata canonical_domain invalid: {mp}")
                meta_domain = None
            elif md != meta_domain:
                conflicts.append(f"metadata canonical_domain {meta_domain!r} is not a bare lowercase host")
                meta_domain = None
        if meta_domain and sheet_domain and meta_domain != sheet_domain:
            conflicts.append(f"canonical_domain: sheet website says {sheet_domain}, metadata says {meta_domain}")
        if meta_domain:
            domain, prov["canonical_domain"] = meta_domain, f"reviewer metadata: {m.get('provenance')}"
        elif sheet_domain and not domain_problem:
            domain, prov["canonical_domain"] = sheet_domain, f"sheet website column {website_col!r}"
        else:
            domain = None
            unresolved["canonical_domain"] = domain_problem or "no website value"

        category = m.get("category")
        if category is not None and category not in COMPANY_CATEGORIES:
            conflicts.append(f"metadata category {category!r} is not one of {list(COMPANY_CATEGORIES)}")
            category = None
        if category:
            prov["category"] = f"reviewer metadata: {m.get('provenance')}"
        else:
            unresolved["category"] = "not in the sheet; no documented seed default"

        v = verified.get(e["board_id"])
        if v and v.get("_conflict"):
            conflicts.append("conflicting verification results")
        proposals.append({"board_id": e["board_id"], "source_row": row,
                          "seed": {"slug": slug, "name": e["company"], "ats": e["ats"], "token": e["token"],
                                   "canonical_domain": domain, "category": category},
                          "provenance": prov, "verification": v, "unresolved": unresolved, "conflicts": conflicts, "notes": []})

    # Slug collisions: with another proposal's different board, or with an existing seed. Never auto-renamed.
    seed_slugs = {str(s.get("slug")).casefold(): s for s in seeds.get("layer1_public_ats") or [] if isinstance(s, dict)}
    by_slug: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_domain: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for p in proposals:
        if p["seed"]["slug"]:
            by_slug[p["seed"]["slug"]].append(p)
        if p["seed"]["canonical_domain"]:
            by_domain[p["seed"]["canonical_domain"]].append(p)
    for slug, ps in by_slug.items():
        if len(ps) > 1:
            for p in ps:
                p["conflicts"].append(f"slug collision: {slug!r} also derived for rows {[q['source_row'] for q in ps if q is not p]}")
        if slug in seed_slugs:
            for p in ps:
                p["conflicts"].append(f"slug collision: {slug!r} already used by seed board "
                                      f"{seed_slugs[slug].get('ats')}:{seed_slugs[slug].get('token')}")
    for domain, ps in by_domain.items():
        names = {p["seed"]["name"].casefold() for p in ps}
        if len(names) > 1:  # shared domain, different companies: kept separate, flagged for review
            for p in ps:
                p["notes"].append(f"shared canonical_domain {domain} with rows {[q['source_row'] for q in ps if q is not p]}; not merged")
                p["conflicts"].append(f"shared domain {domain} across different company names; confirm identity")

    for p in proposals:
        v = p["verification"] or {}
        if p["unresolved"] or p["conflicts"]:
            p["status"], p["status_reason"] = UNRESOLVED, "unresolved fields or conflicts"
        elif v.get("outcome") != bv.VALID_WITH_JOBS:
            p["status"] = NOT_QUALIFIED
            p["status_reason"] = (f"verification outcome {v['outcome']}: {v.get('detail')}" if v
                                  else "no verification result")
        elif v.get("evidence") == bv.LIVE:
            p["status"], p["status_reason"] = PRODUCTION, "live verification found usable jobs"
        else:
            p["status"], p["status_reason"] = TEST_ONLY, "only synthetic fixture evidence; never seed this"

    counts = defaultdict(int)
    for p in proposals:
        counts[p["status"]] += 1
    assert len(proposals) + len(skipped) == len(intake["records"])
    return {
        "kind": "seed_proposal_review",
        "note": "Local proposal only. company_seeds.json was not changed. Review every entry before any seed change.",
        "counts": {"intake_records": len(intake["records"]), "candidates": len(proposals), "skipped": len(skipped), **counts},
        "verification_evidence": sorted({(p["verification"] or {}).get("evidence") for p in proposals} - {None}),
        "proposals": proposals,
        "skipped": skipped,
        "input_problems": {"verification": verify_problems, "metadata": meta_problems},
    }


def seed_entry(p: dict[str, Any]) -> dict[str, Any]:
    return {k: p["seed"][k] for k in SEED_FIELDS}


def _sha256(path: Path | None) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path else None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--intake", required=True, type=Path)
    p.add_argument("--out-dir", required=True, type=Path)
    p.add_argument("--verification", type=Path)
    p.add_argument("--metadata", type=Path)
    p.add_argument("--seeds", type=Path, default=bv.DEFAULT_SEEDS_PATH, help="read only")
    a = p.parse_args(argv)
    try:
        report = propose(bv.load_json(a.intake), bv.load_json(a.seeds),
                         bv.load_json(a.verification) if a.verification else None,
                         bv.load_json(a.metadata) if a.metadata else None)
    except (bv.IntakeError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    report["inputs"] = {name: {"path": str(path), "sha256": _sha256(path)} if path else None
                        for name, path in (("intake", a.intake), ("verification", a.verification),
                                           ("metadata", a.metadata), ("seeds_read_only", a.seeds))}
    a.out_dir.mkdir(parents=True, exist_ok=True)
    prod = [seed_entry(x) for x in report["proposals"] if x["status"] == PRODUCTION]
    test = [seed_entry(x) for x in report["proposals"] if x["status"] == TEST_ONLY]
    (a.out_dir / "proposed_seeds.json").write_text(json.dumps({"layer1_public_ats": prod}, indent=2, ensure_ascii=False), encoding="utf-8")
    (a.out_dir / "proposed_seeds.TEST_ONLY_SYNTHETIC.json").write_text(
        json.dumps({TEST_ONLY_KEY: test}, indent=2, ensure_ascii=False), encoding="utf-8")
    (a.out_dir / "seed_review_report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report["counts"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
