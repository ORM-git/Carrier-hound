"""Offline ATS discovery from supplied careers-page captures, plus a dry-run fetch planner.

Depends on PR #882: every link is classified by scripts.scraper.ats_detect.detect_ats; no URL rules are copied here.
Nothing in this module opens a connection: pages are supplied (HTML, final URL, HTTP status, redirect chain), and
the planner only emits a fetch plan as data. A discovered link is a candidate, never a verified working board.

  python -m scripts.scraper.ats_discovery discover --pages pages.json --out discovery.json
  python -m scripts.scraper.ats_discovery plan --report intake_report.json --policy policy.json --out plan.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from scripts.scraper import ats_detect as ad

MAX_PAGE_BYTES = 2_000_000
MAX_LINKS = 2_000
MAX_EVIDENCE = 5
BLOCK_STATUSES = (403, 429)
ROBOTS_STATES = ("allow", "deny", "unknown")

# (tag, attribute) pairs whose value is a URL. Inline <script> bodies are never read or run.
_LINK_ATTRS = {("a", "href"), ("area", "href"), ("iframe", "src"), ("frame", "src"), ("script", "src"),
               ("link", "href"), ("form", "action"), ("embed", "src"), ("object", "data")}
_META_REFRESH_URL = re.compile(r"url\s*=\s*['\"]?([^'\";]+)", re.IGNORECASE)
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)
_SKIP_HOSTS = ("linkedin.com", "indeed.com", "glassdoor.com", "naukri.com", "wellfound.com", "angel.co", "ycombinator.com",
               "twitter.com", "x.com", "facebook.com", "instagram.com", "youtube.com", "github.com", "medium.com",
               "notion.site", "docs.google.com", "sites.google.com", "forms.gle", "crunchbase.com", "t.me", "wa.me",
               "whatsapp.com")
_FILE_EXTS = (".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".txt", ".zip", ".png", ".jpg", ".jpeg", ".gif")
_URL_IN_TEXT = re.compile(r"[a-z][a-z0-9+.-]*://[^\s\"'|,]+", re.IGNORECASE)
_AT_TOKEN = re.compile(r"[^\s\"'|,]*@[^\s\"'|,]*\.[^\s\"'|,]*")
_TOKEN = re.compile(r"[^\s\"'|,]+")
_GENERIC_SUBDOMAINS = {"apply", "jobs", "careers", "ats", "app", "api"}           # tenant sits in the path
_VENDOR_SUBDOMAINS = {"www", "help", "support", "blog", "docs", "status", "community"}  # vendor's own pages


class DiscoveryError(ValueError):
    pass


# ---- redaction ----------------------------------------------------------------------------------

def redact_url(url: object) -> str | None:
    """Display form: scheme, lowercased host, non-default port, path without ;session params. No credentials,
    query or fragment."""
    if not isinstance(url, str) or not url.strip():
        return None
    try:
        parts = urlsplit(url.strip() if "://" in url else "https://" + url.strip())
        port = parts.port
    except ValueError:
        return "<unparseable>"
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        return "<unparseable>"
    path = "/".join(seg.split(";", 1)[0] for seg in parts.path.split("/"))  # /careers;jsessionid=X -> /careers
    netloc = host if port in (None, 80, 443) else f"{host}:{port}"
    return f"{parts.scheme.lower() or 'https'}://{netloc}{path}"


def _strip_tail(m: re.Match) -> str:
    tok = m.group(0)
    cut = min([i for i in (tok.find("?"), tok.find("#"), tok.find(";")) if i >= 0], default=-1)
    if cut < 0:
        return tok
    head, tail = tok[:cut], tok[cut:]
    # Only URL-like (dot/slash before) or parameter-like (= after) tails: "C# Labs", "What? Inc" stay intact.
    return head if ("." in head or "/" in head or "=" in tail) else tok


def redact_text(text: object) -> str:
    text = _URL_IN_TEXT.sub(lambda m: redact_url(m.group(0)) or "", str(text or ""))
    return _TOKEN.sub(_strip_tail, _AT_TOKEN.sub("<redacted>", text))


# ---- link extraction ----------------------------------------------------------------------------

class _LinkParser(HTMLParser):
    """Collects (source, raw_url) from URL attributes and meta refresh. Parses markup only; executes nothing."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self.base: str | None = None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs if k}
        if tag == "base" and self.base is None and a.get("href"):
            self.base = a["href"]
        if tag == "meta" and a.get("http-equiv", "").lower() == "refresh":
            m = _META_REFRESH_URL.search(a.get("content", ""))
            if m:
                self.links.append(("meta[refresh]", m.group(1).strip()))
        for attr, value in a.items():
            if (tag, attr) in _LINK_ATTRS and value.strip():
                self.links.append((f"{tag}[{attr}]", value.strip()))

    handle_startendtag = handle_starttag


def extract_links(html: str, page_url: str, max_links: int = MAX_LINKS) -> tuple[list[tuple[str, str]], int]:
    """Resolved http(s) links as sorted unique (source, url), plus the count of non-web links ignored.
    Raises DiscoveryError when the unique link count exceeds max_links (a truncated page could hide a second board)."""
    parser = _LinkParser()
    parser.feed(html)
    parser.close()
    base = urljoin(page_url, parser.base) if parser.base else page_url
    out, ignored = set(), 0
    for source, raw in parser.links:
        if _SCHEME.match(raw) and not raw.lower().startswith(("http:", "https:")):
            ignored += 1  # mailto:, javascript:, tel:, data: ...
            continue
        url = urljoin(base, raw)
        if not url.lower().startswith(("http://", "https://")):
            ignored += 1
            continue
        out.add((source, url))
        if len(out) > max_links:
            raise DiscoveryError(f"more than {max_links} links; result would be incomplete")
    return sorted(out), ignored


# ---- classification -----------------------------------------------------------------------------

def _vendor_base(host: str) -> str | None:
    for base in (*ad.SUPPORTED_BASES, *ad.UNSUPPORTED_ATS):
        if host == base or host.endswith("." + base):
            return base
    return None


def classify_link(url: str) -> dict:
    """One link through detect_ats. kind: board | unsupported_board | lookalike | vendor_site | incomplete | other."""
    det = ad.detect_ats(url)
    host = det["normalized_domain"] or ""
    path = urlsplit(det["normalized_url"] or "").path.strip("/")
    if det["status"] == ad.CANDIDATE:
        return {"kind": "board", "ats": det["ats"], "identifiers": det["identifiers"],
                "key": f"{det['ats']}:{json.dumps(det['identifiers'], sort_keys=True)}", "reason": det["reason"]}
    if det["status"] == ad.UNSUPPORTED:
        base = _vendor_base(host) or host
        if host == base and base.count(".") == 1:  # bare vendor domain (workable.com/...): marketing, not a tenant board
            return {"kind": "vendor_site", "reason": f"{host} is the {det['ats']} vendor site"}
        sub = host[: -len(base)].rstrip(".").split(".")[0] if host != base else ""
        if sub in _VENDOR_SUBDOMAINS:                                     # help.workable.com, www.breezy.hr
            return {"kind": "vendor_site", "reason": f"{host} is a {det['ats']} vendor page"}
        tenant_in_host = bool(sub) and sub not in _GENERIC_SUBDOMAINS     # acme.breezy.hr
        first = path.split("/")[0] if path else ""
        if not det["identifiers"] and not tenant_in_host and not first:  # apply.workable.com, ats.rippling.com
            return {"kind": "incomplete", "ats": det["ats"], "reason": f"{det['ats']} host without a tenant"}
        # shortcut: unsupported-board identity = detect_ats identifiers, else tenant host, else host + first path
        # segment; upgrade when the vendor gets a connector.
        ident = (f"{host}:{json.dumps(det['identifiers'], sort_keys=True)}" if det["identifiers"]
                 else host if tenant_in_host else f"{host}/{first}")
        return {"kind": "unsupported_board", "ats": det["ats"], "identifiers": det["identifiers"] or {"board": ident},
                "key": f"unsupported:{det['ats']}:{ident}", "reason": det["reason"]}
    if det["status"] == ad.LOOKALIKE:
        return {"kind": "lookalike", "reason": det["reason"]}
    if det["status"] == ad.INCOMPLETE:
        return {"kind": "incomplete", "ats": det["ats"], "reason": det["reason"]}
    if det["status"] == ad.WEBSITE and _vendor_base(host):
        return {"kind": "vendor_site", "reason": det["reason"]}
    return {"kind": "other", "reason": det["reason"]}


def _row(n: object) -> bool:
    return type(n) is int  # JSON true is not row 1


def discover_page(page: dict, max_bytes: int = MAX_PAGE_BYTES, max_links: int = MAX_LINKS) -> dict:
    """page: {source_row, final_url, http_status, redirect_chain, html}. Returns one deterministic result row."""
    row = page.get("source_row")
    result = {"source_row": row, "final_url": redact_url(page.get("final_url")), "verified": False,
              "boards": [], "rejected": [], "links_considered": 0, "non_web_links_ignored": 0}

    def done(status, reason):
        return {**result, "status": status, "reason": reason}

    status = page.get("http_status")
    if type(status) is not int:
        return done("error", "http_status missing or not an integer")
    if status in BLOCK_STATUSES:
        return done("blocked", f"HTTP {status}; stop, no retry")
    if not 200 <= status < 300:
        return done("error", f"HTTP {status}")
    final_url = page.get("final_url")
    if not isinstance(final_url, str) or not ad.normalize_url(final_url)[0]:
        return done("error", "final_url missing or invalid")
    html = page.get("html")
    if isinstance(html, bytes):
        size = len(html)
        html = html.decode("utf-8", errors="replace")  # shortcut: no charset sniffing; upgrade if non-UTF-8 pages matter
    elif isinstance(html, str):
        size = len(html.encode("utf-8"))
    else:
        return done("error", "html missing")
    if size > max_bytes:
        return done("error", f"page is {size} bytes, over the {max_bytes}-byte cap; not parsed")
    chain = page.get("redirect_chain") or []
    if not isinstance(chain, list) or not all(isinstance(u, str) for u in chain):
        return done("error", "redirect_chain must be a list of URLs")
    try:
        links, ignored = extract_links(html, final_url, max_links)
    except DiscoveryError as exc:
        return done("error", str(exc))
    # The page's own URLs count too: a site can redirect straight onto its board.
    links = sorted({*links, ("final_url", final_url), *(("redirect", u) for u in chain)})

    boards: dict[str, dict] = {}
    rejected: dict[tuple[str, str], dict] = {}
    for source, url in links:
        c = classify_link(url)
        ev = {"source": source, "url": redact_url(url)}
        if c["kind"] in ("board", "unsupported_board"):
            b = boards.setdefault(c["key"], {"ats": c["ats"], "identifiers": c["identifiers"], "board_key": c["key"],
                                             "support": "supported" if c["kind"] == "board" else "unsupported",
                                             "reason": c["reason"], "evidence": []})
            if ev not in b["evidence"]:
                b["evidence"].append(ev)
        elif c["kind"] in ("lookalike", "vendor_site", "incomplete"):
            r = rejected.setdefault((c["kind"], ev["url"]), {"kind": c["kind"], "url": ev["url"], "reason": c["reason"], "sources": []})
            if source not in r["sources"]:
                r["sources"].append(source)
    result.update(links_considered=len(links), non_web_links_ignored=ignored,
                  boards=[{**b, "evidence_count": len(b["evidence"]), "evidence": sorted(b["evidence"], key=lambda e: (e["url"], e["source"]))[:MAX_EVIDENCE]}
                          for _, b in sorted(boards.items())],
                  rejected=[{**r, "sources": sorted(r["sources"])} for _, r in sorted(rejected.items())])
    if len(boards) > 1:
        return done("ambiguous", f"{len(boards)} distinct boards linked; needs review, none chosen")
    if boards:
        b = result["boards"][0]
        if b["support"] == "unsupported":
            return done("found", "one board on an ATS without a connector; connector backlog, not ready to ingest")
        return done("found", "one supported-ATS board candidate; unverified until a live check")
    return done("none", "no ATS board link found in supplied page")


def discover(pages: list[dict], **caps) -> dict:
    if not isinstance(pages, list):
        raise DiscoveryError("pages must be a list")
    seen = set()
    for i, p in enumerate(pages):
        if not isinstance(p, dict) or not _row(p.get("source_row")):
            raise DiscoveryError(f"pages[{i}] needs an integer source_row")
        if p["source_row"] in seen:
            raise DiscoveryError(f"source_row {p['source_row']} supplied twice")
        seen.add(p["source_row"])
    results = [discover_page(p, **caps) for p in sorted(pages, key=lambda p: p["source_row"])]
    counts: dict[str, int] = defaultdict(int)
    for r in results:
        counts[r["status"]] += 1
    return {"note": "Offline discovery from supplied pages. No board is verified; found means one candidate to check live.",
            "input_pages": len(pages), "by_status": {s: counts[s] for s in ("found", "none", "ambiguous", "blocked", "error")},
            "results": results}


# ---- dry-run fetch planner ----------------------------------------------------------------------

def validate_policy(policy: object) -> dict:
    if not isinstance(policy, dict):
        raise DiscoveryError("policy must be an object")
    p = {"robots": policy.get("robots", {}), "default_robots": policy.get("default_robots", "unknown"),
         "per_host_spacing_seconds": policy.get("per_host_spacing_seconds"), "global_request_cap": policy.get("global_request_cap"),
         "max_response_bytes": policy.get("max_response_bytes", MAX_PAGE_BYTES), "requests_per_url": policy.get("requests_per_url", 1),
         "retries": policy.get("retries", 0), "stop_on_status": policy.get("stop_on_status", list(BLOCK_STATUSES))}
    if not isinstance(p["robots"], dict) or any(v not in ROBOTS_STATES for v in p["robots"].values()):
        raise DiscoveryError(f"robots values must be one of {ROBOTS_STATES}")
    if p["default_robots"] not in ROBOTS_STATES:
        raise DiscoveryError(f"default_robots must be one of {ROBOTS_STATES}")
    sp = p["per_host_spacing_seconds"]
    if type(sp) not in (int, float) or sp <= 0:
        raise DiscoveryError("per_host_spacing_seconds must be a positive number")
    for key in ("global_request_cap", "max_response_bytes"):
        if type(p[key]) is not int or p[key] <= 0:
            raise DiscoveryError(f"{key} must be a positive integer")
    if p["requests_per_url"] != 1 or p["retries"] != 0:
        raise DiscoveryError("policy allows exactly one request per URL and no retries")
    if not isinstance(p["stop_on_status"], list) or not set(BLOCK_STATUSES) <= set(p["stop_on_status"]):
        raise DiscoveryError("stop_on_status must include 403 and 429")
    p["robots"] = {str(h).lower().rstrip("."): v for h, v in sorted(p["robots"].items())}
    p["stop_on_status"] = sorted(set(p["stop_on_status"]))
    return p


def _skip_reason(host: str, path: str) -> str | None:
    if any(host == h or host.endswith("." + h) for h in _SKIP_HOSTS):
        return "skipped_job_board_or_social"
    if path.lower().rstrip("/").endswith(_FILE_EXTS):
        return "skipped_file"
    return None


def plan_fetches(report: object, policy: object) -> dict:
    """Pure dry-run plan for website-only rows of an intake_report.json. Every record gets exactly one category."""
    pol = validate_policy(policy)
    if not isinstance(report, dict) or not isinstance(report.get("records"), list):
        raise DiscoveryError("report must be an object with a 'records' list")
    rows: dict[int, dict] = {}
    for i, r in enumerate(report["records"]):
        if not isinstance(r, dict) or not _row(r.get("source_row")):
            raise DiscoveryError(f"records[{i}] needs an integer source_row")
        if r["source_row"] in rows:
            raise DiscoveryError(f"source_row {r['source_row']} appears twice")
        rows[r["source_row"]] = r

    category: dict[int, str] = {}
    by_url: dict[str, list[int]] = defaultdict(list)
    url_host: dict[str, str] = {}
    for n, r in sorted(rows.items()):
        if r.get("status") != "website_only":
            category[n] = "not_website_only"
            continue
        target = r.get("merged_into_row")
        if target is not None:
            category[n] = "merged_duplicate" if _row(target) and target in rows and target != n else "invalid_merge_reference"
            continue
        url, host, err = ad.normalize_url(r.get("normalized_url") or r.get("original_url"))
        if err:
            category[n] = "invalid_url"
            continue
        skip = _skip_reason(host, urlsplit(url).path)
        if skip:
            category[n] = skip
            continue
        robots = pol["robots"].get(host, pol["default_robots"])
        if robots == "deny":
            category[n] = "robots_deny"
        elif robots == "unknown":
            category[n] = "robots_unknown"  # never treated as allowed
        else:
            by_url[url].append(n)
            url_host[url] = host

    requests, per_host = [], defaultdict(int)
    for url in sorted(by_url, key=lambda u: (url_host[u], u)):   # one request per URL, shared by every row using it
        refs = sorted(by_url[url])
        if len(requests) >= pol["global_request_cap"]:
            for n in refs:
                category[n] = "deferred_request_cap"
            continue
        host = url_host[url]
        requests.append({"seq": len(requests) + 1, "host": host, "url": redact_url(url), "source_rows": refs,
                         "not_before_seconds": per_host[host] * pol["per_host_spacing_seconds"]})
        per_host[host] += 1
        for n in refs:
            category[n] = "planned"

    assert sorted(category) == sorted(rows)  # every row exactly once
    cats = ("planned", "deferred_request_cap", "robots_unknown", "robots_deny", "skipped_job_board_or_social",
            "skipped_file", "invalid_url", "merged_duplicate", "invalid_merge_reference", "not_website_only")
    grouped = {c: [n for n, cat in sorted(category.items()) if cat == c] for c in cats}

    def samples(c):
        return [{"source_row": n, "company": redact_text(rows[n].get("company")),
                 "url": redact_url(rows[n].get("normalized_url") or rows[n].get("original_url"))} for n in grouped[c][:MAX_EVIDENCE]]

    pending_hosts = sorted({ad.normalize_url(rows[n].get("normalized_url") or rows[n].get("original_url"))[1]
                            for n in grouped["robots_unknown"]})
    return {"note": "Dry-run plan only. Nothing was fetched; robots 'unknown' rows wait for an explicit robots decision.",
            "policy": pol,
            "reconciliation": {"input_rows": len(rows), "categorized_rows": sum(len(v) for v in grouped.values()),
                               "by_category": {c: len(v) for c, v in grouped.items()}, "planned_requests": len(requests)},
            "requests": requests,
            "robots_pending_hosts": pending_hosts,
            "rows": {c: v for c, v in grouped.items() if v},
            "skipped_samples": {c: samples(c) for c in ("skipped_job_board_or_social", "skipped_file", "robots_deny",
                                                        "robots_unknown", "invalid_url") if grouped[c]}}


# ---- CLI ----------------------------------------------------------------------------------------

def load_pages(manifest: Path) -> list[dict]:
    """Manifest: list of page objects; each has inline "html" or "html_file" relative to the manifest's folder."""
    pages = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(pages, list):
        raise DiscoveryError("pages manifest must be a list")
    root = manifest.resolve().parent
    out = []
    for p in pages:
        if isinstance(p, dict) and "html_file" in p:
            path = (root / str(p["html_file"])).resolve()
            if root not in path.parents:
                raise DiscoveryError(f"html_file {p['html_file']!r} escapes the manifest folder")
            p = {**{k: v for k, v in p.items() if k != "html_file"}, "html": path.read_bytes()}
        out.append(p)
    return out


def _write(obj: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover")
    d.add_argument("--pages", required=True, type=Path)
    d.add_argument("--out", required=True, type=Path)
    pl = sub.add_parser("plan")
    pl.add_argument("--report", required=True, type=Path)
    pl.add_argument("--policy", required=True, type=Path)
    pl.add_argument("--out", required=True, type=Path)
    a = ap.parse_args(argv)
    try:
        if a.cmd == "discover":
            result = discover(load_pages(a.pages))
            summary = result["by_status"]
        else:
            result = plan_fetches(json.loads(a.report.read_text(encoding="utf-8-sig")),
                                  json.loads(a.policy.read_text(encoding="utf-8")))
            summary = result["reconciliation"]
        _write(result, a.out)
    except (DiscoveryError, OSError, json.JSONDecodeError) as exc:
        print(f"error: {redact_text(exc)}", file=sys.stderr)
        return 2
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
