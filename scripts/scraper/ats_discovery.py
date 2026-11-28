"""Offline ATS discovery from supplied careers-page captures, plus a dry-run fetch planner.

Depends on PR #882: every link is classified by scripts.scraper.ats_detect.detect_ats; no URL rules are copied here.
Nothing in this module opens a connection: pages are supplied (HTML, final URL, HTTP status, redirect chain), and
the planner only emits a fetch plan as data. A discovered link is a candidate, never a verified working board.

  python -m scripts.scraper.ats_discovery discover --pages pages.json --out discovery.json
  python -m scripts.scraper.ats_discovery plan --report intake_report.json --policy policy.json [--robots robots.json] --out plan.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from scripts.scraper import ats_detect as ad
from scripts.scraper.enrichment import build_source_id

# Vendors whose persisted board identity is already case-insensitive (see board_identity).
CASE_INSENSITIVE_TOKEN_ATS = ("greenhouse", "lever", "ashby", "smartrecruiters")

MAX_PAGE_BYTES = 2_000_000
MAX_LINKS = 2_000
MAX_EVIDENCE = 5
BLOCK_STATUSES = (403, 429)

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


def board_identity(ats: str, identifiers: dict) -> str:
    """Dedup key for a supported board, following the identity the existing code already persists:
    - token vendors: fetchers.build_normalized_job stores source_id "<ats>:<token lowercased>" and
      enrichment.build_source_id lowercases the same way, so acme/ACME are one board there; reuse that helper.
    - Workday: fetch_workday_cxs stores "workday:{tenant}:{site}" with the site's case kept, so site case stays
      significant (tenant and cluster come from the host, already lowercased by detect_ats).
    Anything without such a rule keeps its exact identifiers."""
    if ats in CASE_INSENSITIVE_TOKEN_ATS and set(identifiers) == {"token"}:
        return build_source_id(ats, identifiers["token"])
    return f"{ats}:{json.dumps(identifiers, sort_keys=True)}"


def evidence_kind(source: str) -> str:
    tag = source.split("[", 1)[0]
    if tag in ("iframe", "frame", "script", "embed", "object"):
        return "embed"
    if tag in ("a", "area"):
        return "anchor"
    return {"meta": "meta_refresh", "form": "form", "link": "link_tag"}.get(tag, source)  # final_url, redirect


def classify_link(url: str) -> dict:
    """One link through detect_ats. kind: board | unsupported_board | lookalike | vendor_site | incomplete | other."""
    det = ad.detect_ats(url)
    host = det["normalized_domain"] or ""
    path = urlsplit(det["normalized_url"] or "").path.strip("/")
    if det["status"] == ad.CANDIDATE:
        return {"kind": "board", "ats": det["ats"], "identifiers": det["identifiers"],
                "key": board_identity(det["ats"], det["identifiers"]), "reason": det["reason"]}
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
              "company_match": "unconfirmed", "boards": [], "rejected": [], "links_considered": 0, "non_web_links_ignored": 0}

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
        ev = {"source": source, "kind": evidence_kind(source), "url": redact_url(url)}
        if c["kind"] in ("board", "unsupported_board"):
            b = boards.setdefault(c["key"], {"ats": c["ats"], "board_key": c["key"],
                                             "support": "supported" if c["kind"] == "board" else "unsupported",
                                             "reason": c["reason"], "evidence": [], "_variants": []})
            if c["identifiers"] not in b["_variants"]:
                b["_variants"].append(c["identifiers"])
            if ev not in b["evidence"]:
                b["evidence"].append(ev)
        elif c["kind"] in ("lookalike", "vendor_site", "incomplete"):
            r = rejected.setdefault((c["kind"], ev["url"]), {"kind": c["kind"], "url": ev["url"], "reason": c["reason"], "sources": []})
            if source not in r["sources"]:
                r["sources"].append(source)
    out_boards = []
    for _, b in sorted(boards.items()):
        variants = sorted(b.pop("_variants"), key=lambda v: json.dumps(v, sort_keys=True))
        kinds = sorted({e["kind"] for e in b["evidence"]})
        out_boards.append({**b, "identifiers": variants[0], "identifier_variants": variants, "evidence_kinds": kinds,
                           # Evidence strength only; never a verification or an approved company match.
                           "linked_only": set(kinds) <= {"anchor", "form", "link_tag"},
                           "evidence_count": len(b["evidence"]),
                           "evidence": sorted(b["evidence"], key=lambda e: (e["url"], e["source"]))[:MAX_EVIDENCE]})
    result.update(links_considered=len(links), non_web_links_ignored=ignored, boards=out_boards,
                  rejected=[{**r, "sources": sorted(r["sources"])} for _, r in sorted(rejected.items())])
    if len(boards) > 1:
        return done("ambiguous", f"{len(boards)} distinct boards linked; needs review, none chosen")
    if boards:
        b = result["boards"][0]
        tail = ("; only linked from the page, may belong to a partner or customer" if b["linked_only"]
                else "; embedded or reached by navigation")
        if b["support"] == "unsupported":
            return done("found", "one board on an ATS without a connector; connector backlog, not ready to ingest" + tail)
        return done("found", "one supported-ATS board candidate; unverified, company match unconfirmed" + tail)
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


# ---- robots.txt (supplied responses, parsed locally) ----------------------------------------------

ROBOTS_MAX_BYTES = 500 * 1024          # RFC 9309 parsing limit
_ROBOTS_DIRECTIVE = re.compile(r"^\s*(user-agent|allow|disallow|sitemap|crawl-delay)\s*:", re.IGNORECASE)
_CRAWL_DELAY = re.compile(r"^\s*crawl-delay\s*:(.*)$", re.IGNORECASE)


def origin_of(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}"


def _robots_text(body: object) -> tuple[str | None, str | None]:
    """Body as text with a leading UTF-8 BOM removed, so directive validation and parsing see the same lines.
    (A BOM glued to the first "User-agent" hides that group from robotparser and turns "Disallow: /" into allow-all.)"""
    if isinstance(body, bytes):
        try:
            body = body.decode("utf-8-sig")
        except UnicodeDecodeError:
            return None, "robots.txt body is not UTF-8"
    if not isinstance(body, str):
        return None, "robots.txt body missing"
    body = body[1:] if body.startswith("﻿") else body
    if len(body.encode("utf-8")) > ROBOTS_MAX_BYTES:
        return None, "robots.txt over 500 KiB"
    return body, None


def _parse_robots(response: dict, user_agent: str):
    """(RobotFileParser, group applying to user_agent or None, problem). Problem set means: treat as unknown."""
    body, problem = _robots_text(response.get("body"))
    if problem:
        return None, None, problem
    lines = [ln.split("#", 1)[0] for ln in body.splitlines()]
    if any(ln.strip() for ln in lines) and not any(_ROBOTS_DIRECTIVE.match(ln) for ln in lines):
        return None, None, "robots.txt has no robots directives (garbage or HTML)"  # robotparser would allow everything
    rp = RobotFileParser()
    rp.parse(body.splitlines())
    agent = user_agent.split("/", 1)[0].lower()
    matching = [e for e in rp.entries if e.applies_to(user_agent)]
    if len(matching) > 1 or (matching and agent not in {a.lower() for a in matching[0].useragents}):
        # robotparser takes the first substring match ("bot" applies to "cmbot"); RFC 9309 wants exact, merged groups.
        return None, None, f"robots user-agent groups for {agent!r} are ambiguous (partial or repeated match)"
    bad_delay = [ln for ln in lines if _CRAWL_DELAY.match(ln) and not _CRAWL_DELAY.match(ln).group(1).strip().isdigit()]
    if bad_delay:  # robotparser silently drops a non-integer Crawl-delay, which would understate the site's request
        return None, None, "robots.txt has a Crawl-delay urllib.robotparser cannot read"
    return rp, (matching[0] if matching else rp.default_entry), None


def robots_crawl_delay(response: object, user_agent: str) -> int | None:
    """Crawl-delay (seconds) that applies to user_agent in a usable 2xx robots.txt, else None."""
    if not isinstance(response, dict) or type(response.get("status")) is not int or not 200 <= response["status"] < 300:
        return None
    _, group, problem = _parse_robots(response, user_agent)
    return None if problem or group is None else group.delay


def evaluate_robots(response: object, url: str, user_agent: str, on_4xx: str) -> tuple[str, str]:
    """('allow' | 'deny' | 'unknown', reason) for one page URL. Only a parsed, usable robots.txt or an explicit 4xx
    policy can allow; anything missing, failed or unusable is unknown."""
    if not isinstance(response, dict) or type(response.get("status")) is not int:
        return "unknown", "robots response missing or has no integer status"
    status = response["status"]
    if 400 <= status < 500:
        return on_4xx, f"robots.txt HTTP {status}; policy robots_4xx={on_4xx}"
    if not 200 <= status < 300:
        return "unknown", f"robots.txt HTTP {status}; unusable"
    rp, group, problem = _parse_robots(response, user_agent)
    if problem:
        return "unknown", problem
    agent = user_agent.split("/", 1)[0].lower()
    if group and any("%2A" in r.path or "%24" in r.path for r in group.rulelines):
        # urllib.robotparser matches * and $ literally, which could silently allow a disallowed path.
        return "unknown", f"robots group for {agent!r} uses path wildcards urllib.robotparser cannot evaluate"
    path = urlsplit(url).path or "/"
    allowed = rp.can_fetch(user_agent, url)
    if group and allowed != _longest_match_allows(group, url):
        # robotparser applies the first matching rule; RFC 9309 applies the longest. Disagreement is never allowed.
        return "unknown", f"robots rule order for {path} differs between urllib.robotparser and RFC 9309 longest match"
    if allowed:
        return "allow", f"robots.txt allows {path} for {agent!r}"
    return "deny", f"robots.txt disallows {path} for {agent!r}"


def _longest_match_allows(group, url: str) -> bool:
    """RFC 9309 decision over robotparser's own parsed rule lines: longest matching path wins, a tie allows."""
    parts = urlsplit(unquote(url))
    target = quote(urlunsplit(("", "", parts.path, parts.query, parts.fragment))) or "/"  # same form robotparser matches
    hits = [r for r in group.rulelines if r.applies_to(target)]
    if not hits:
        return True
    longest = max(len(r.path) for r in hits)
    return any(r.allowance for r in hits if len(r.path) == longest)


# ---- dry-run fetch planner ----------------------------------------------------------------------

_POLICY_KEYS = {"user_agent", "robots_4xx", "per_host_spacing_seconds", "global_request_cap", "max_response_bytes",
                "requests_per_url", "retries", "stop_on_status"}


def validate_policy(policy: object) -> dict:
    if not isinstance(policy, dict):
        raise DiscoveryError("policy must be an object")
    extra = sorted(set(policy) - _POLICY_KEYS)
    if extra:  # e.g. the old manual robots/default_robots map: robots now come only from supplied robots.txt
        raise DiscoveryError(f"unknown policy keys {extra}")
    p = {"user_agent": policy.get("user_agent"), "robots_4xx": policy.get("robots_4xx", "unknown"),
         "per_host_spacing_seconds": policy.get("per_host_spacing_seconds"), "global_request_cap": policy.get("global_request_cap"),
         "max_response_bytes": policy.get("max_response_bytes", MAX_PAGE_BYTES), "requests_per_url": policy.get("requests_per_url", 1),
         "retries": policy.get("retries", 0), "stop_on_status": policy.get("stop_on_status", list(BLOCK_STATUSES))}
    ua = p["user_agent"]
    if not isinstance(ua, str) or not ua.strip() or any(c in ua for c in "\r\n"):
        raise DiscoveryError("user_agent is required: a non-empty single-line string")
    if p["robots_4xx"] not in ("unknown", "allow", "deny"):
        raise DiscoveryError("robots_4xx must be 'unknown' (default), 'allow' or 'deny'")
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
    p["user_agent"] = ua.strip()
    p["stop_on_status"] = sorted(set(p["stop_on_status"]))
    return p


def _skip_reason(host: str, path: str) -> str | None:
    if any(host == h or host.endswith("." + h) for h in _SKIP_HOSTS):
        return "skipped_job_board_or_social"
    if path.lower().rstrip("/").endswith(_FILE_EXTS):
        return "skipped_file"
    return None


PLAN_CATEGORIES = ("planned", "awaiting_robots", "deferred_request_cap", "deferred_crawl_delay", "robots_unknown", "robots_deny",
                   "skipped_job_board_or_social", "skipped_file", "invalid_url", "merged_duplicate",
                   "invalid_merge_reference", "not_website_only")


def plan_fetches(report: object, policy: object, robots: object = None) -> dict:
    """Pure dry-run plan for website-only rows of an intake_report.json.

    robots: {origin: {"status": int, "body": str}} for robots.txt responses already in hand (none are fetched here).
    An origin without one gets a single robots.txt request and its pages wait; only pages robots.txt allows are
    planned. Robots and page requests share the global cap and per-host spacing. A Crawl-delay above the plan's
    per-host spacing defers that origin's pages. Robots redirects and HTTP vs HTTPS origins are the future fetcher's
    job (this plan only uses the https origins 882's normalize_url produces). Every record gets one category."""
    pol = validate_policy(policy)
    robots = {} if robots is None else robots
    if not isinstance(robots, dict):
        raise DiscoveryError("robots responses must be an object keyed by origin")
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
    reasons: dict[int, str] = {}
    pages: dict[str, list[int]] = defaultdict(list)        # robots-allowed page URL -> rows
    waiting: dict[str, list[int]] = defaultdict(list)      # origin with no robots.txt in hand -> rows
    evaluated: dict[str, dict] = {}
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
        origin = origin_of(url)
        if origin not in robots:
            waiting[origin].append(n)
            continue
        state, why = evaluate_robots(robots[origin], url, pol["user_agent"], pol["robots_4xx"])
        resp = robots[origin] if isinstance(robots[origin], dict) else {}
        if origin not in evaluated:
            delay = robots_crawl_delay(resp, pol["user_agent"])
            evaluated[origin] = {"status": resp.get("status"), "crawl_delay": delay, "pages": {},
                                 "crawl_delay_exceeds_spacing": delay is not None and delay > pol["per_host_spacing_seconds"]}
        evaluated[origin]["pages"][redact_url(url)] = state
        reasons[n] = why
        if state == "allow" and evaluated[origin]["crawl_delay_exceeds_spacing"]:
            # The site asks for more time between requests than this plan spaces them: never planned faster.
            category[n] = "deferred_crawl_delay"
            reasons[n] = (f"Crawl-delay {evaluated[origin]['crawl_delay']}s exceeds per_host_spacing_seconds "
                          f"{pol['per_host_spacing_seconds']}; deferred until spacing is at least that long")
        elif state == "allow":
            pages[url].append(n)
        else:
            category[n] = "robots_deny" if state == "deny" else "robots_unknown"

    planned = [("robots", origin + "/robots.txt", sorted(rs)) for origin, rs in sorted(waiting.items())]
    planned += [("page", u, sorted(rs)) for u, rs in sorted(pages.items(), key=lambda kv: (origin_of(kv[0]), kv[0]))]
    requests, per_host = [], defaultdict(int)
    for kind, url, refs in planned:                         # robots first: pages never outrun their rules
        fits = len(requests) < pol["global_request_cap"]
        for n in refs:
            category[n] = ("awaiting_robots" if kind == "robots" else "planned") if fits else "deferred_request_cap"
            if not fits:
                reasons[n] = f"global request cap {pol['global_request_cap']} reached before this {kind} request"
        if not fits:
            continue
        host = urlsplit(url).hostname
        requests.append({"seq": len(requests) + 1, "kind": kind, "host": host, "url": redact_url(url),
                         "source_rows": refs, "not_before_seconds": per_host[host] * pol["per_host_spacing_seconds"]})
        per_host[host] += 1

    assert sorted(category) == sorted(rows)  # every row exactly once
    grouped = {c: [n for n, cat in sorted(category.items()) if cat == c] for c in PLAN_CATEGORIES}

    def samples(c):
        return [{"source_row": n, "company": redact_text(rows[n].get("company")), "reason": reasons.get(n),
                 "url": redact_url(rows[n].get("normalized_url") or rows[n].get("original_url"))} for n in grouped[c][:MAX_EVIDENCE]]

    kinds: dict[str, int] = defaultdict(int)
    for q in requests:
        kinds[q["kind"]] += 1
    return {"note": "Dry-run plan only. Nothing was fetched; pages wait until a robots.txt in hand allows them.",
            "policy": pol,
            "reconciliation": {"input_rows": len(rows), "categorized_rows": sum(len(v) for v in grouped.values()),
                               "by_category": {c: len(v) for c, v in grouped.items()}, "planned_requests": len(requests),
                               "robots_requests": kinds["robots"], "page_requests": kinds["page"]},
            "requests": requests,
            "robots_evaluated": [{"origin": redact_url(o), "status": e["status"], "crawl_delay": e["crawl_delay"],
                                  "crawl_delay_exceeds_spacing": e["crawl_delay_exceeds_spacing"],
                                  "pages": dict(sorted(e["pages"].items()))} for o, e in sorted(evaluated.items())],
            "fetcher_responsibilities": ["follow robots.txt redirects and supply the final response per origin",
                                         "treat http:// and https:// as separate origins (this plan uses https only)"],
            "rows": {c: v for c, v in grouped.items() if v},
            "samples": {c: samples(c) for c in PLAN_CATEGORIES[1:] if grouped[c]}}


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
    pl.add_argument("--robots", type=Path, help="robots.txt responses already in hand: {origin: {status, body}}")
    pl.add_argument("--out", required=True, type=Path)
    a = ap.parse_args(argv)
    try:
        if a.cmd == "discover":
            result = discover(load_pages(a.pages))
            summary = result["by_status"]
        else:
            result = plan_fetches(json.loads(a.report.read_text(encoding="utf-8-sig")),
                                  json.loads(a.policy.read_text(encoding="utf-8")),
                                  json.loads(a.robots.read_text(encoding="utf-8")) if a.robots else None)
            summary = result["reconciliation"]
        _write(result, a.out)
    except (DiscoveryError, OSError, json.JSONDecodeError) as exc:
        print(f"error: {redact_text(exc)}", file=sys.stderr)
        return 2
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
