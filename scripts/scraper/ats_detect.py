"""Offline ATS detection from a URL. No network: a match is a *candidate* board, never a verified one.

Identifier keys match company_seeds.json: Greenhouse/Lever/Ashby/SmartRecruiters -> {"token"},
Workday -> {"tenant", "wd_cluster", "site"} (see fetchers.fetch_workday_cxs).
"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# Statuses, one per outcome kind, so reports can keep them separate.
BLANK = "blank"
INVALID = "invalid_url"
AMBIGUOUS = "ambiguous"
CANDIDATE = "ats_candidate"
INCOMPLETE = "ats_incomplete"
UNSUPPORTED = "unsupported_ats"
LOOKALIKE = "rejected_lookalike"
WEBSITE = "website_only"

_TRACKING_PARAMS = {"gclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "gh_src", "lever-source", "lever-origin", "ref", "source", "src"}
_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._%~-]*$")
_LABEL_RE = re.compile(r"^(?!-)[a-z0-9-]{1,63}(?<!-)$")
_LOCALE_RE = re.compile(r"^[a-z]{2}(-[a-z]{2})?$", re.IGNORECASE)
_WORKDAY_JOBS_RE = re.compile(r"^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$")
_WORKDAY_SITE_RE = re.compile(r"^(wd\d+)\.myworkdaysite\.com$")
_MULTI_URL_RE = re.compile(r"\s|,|\|")

SUPPORTED_BASES = ("greenhouse.io", "lever.co", "ashbyhq.com", "smartrecruiters.com", "myworkdayjobs.com", "myworkdaysite.com")
# Distinctive brand labels: the same label under another TLD is a lookalike (ashbyhq.net, myworkdayjobs.co).
_BRAND_LABELS = {"ashbyhq", "smartrecruiters", "myworkdayjobs", "myworkdaysite"}
# Real ATS hosts with no connector here: kept apart from plain websites.
UNSUPPORTED_ATS = {
    "workable.com": "workable", "recruitee.com": "recruitee", "bamboohr.com": "bamboohr",
    "teamtailor.com": "teamtailor", "personio.de": "personio", "personio.com": "personio",
    "breezy.hr": "breezy", "applytojob.com": "jazzhr", "icims.com": "icims", "taleo.net": "taleo",
    "successfactors.com": "successfactors", "successfactors.eu": "successfactors", "jobvite.com": "jobvite",
    "pinpointhq.com": "pinpoint", "comeet.com": "comeet", "comeet.co": "comeet", "homerun.co": "homerun",
    "eightfold.ai": "eightfold", "oraclecloud.com": "oracle", "ats.rippling.com": "rippling",
    "jobs.gem.com": "gem", "zohorecruit.com": "zoho_recruit", "zohorecruit.in": "zoho_recruit",
    "zohorecruit.eu": "zoho_recruit", "keka.com": "keka", "freshteam.com": "freshteam", "careers-page.com": "careers_page",
    "join.com": "join",
}


def _on(host: str, base: str) -> bool:
    return host == base or host.endswith("." + base)


def normalize_url(raw: str | None) -> tuple[str | None, str | None, str | None]:
    """Returns (normalized_url, host, error). Adds https:// to bare domains, lowercases the host,
    drops www./default port/fragment/tracking params/trailing slash."""
    value = (raw or "").strip()
    if not value:
        return None, None, "blank"
    if _MULTI_URL_RE.search(value):
        return None, None, "multiple values or whitespace in one cell"
    if "://" not in value:
        if value.startswith("//") or ":" in value.split("/")[0]:
            return None, None, "unsupported scheme"
        value = "https://" + value
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError as exc:
        return None, None, f"unparseable url: {exc}"
    if parts.scheme.lower() not in ("http", "https"):
        return None, None, f"unsupported scheme: {parts.scheme}"
    if parts.username or parts.password:
        return None, None, "credentials in url"
    host = (parts.hostname or "").rstrip(".")
    try:
        host = host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None, None, "invalid hostname"
    labels = host.split(".")
    if len(labels) < 2 or not all(_LABEL_RE.match(label) for label in labels) or labels[-1].isdigit():
        return None, None, "invalid hostname"
    if host.startswith("www."):
        host = host[4:]
    netloc = host if port in (None, 80, 443) else f"{host}:{port}"
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in _TRACKING_PARAMS]
    path = parts.path.rstrip("/")
    return urlunsplit(("https", netloc, path, urlencode(query), "")), host, None


def _token(value: str | None) -> str | None:
    return value if value and _TOKEN_RE.match(value) else None


def _result(ats, status, reason, identifiers=None):
    return {"ats": ats, "identifiers": identifiers or {}, "status": status, "reason": reason}


def detect_ats(raw_url: str | None) -> dict:
    """Detects one URL. Returns normalized_url, normalized_domain, ats, identifiers, status, reason."""
    url, host, error = normalize_url(raw_url)
    base = {"normalized_url": url, "normalized_domain": host}
    if error:
        status = BLANK if error == "blank" else (AMBIGUOUS if error.startswith("multiple") else INVALID)
        return {**base, **_result(None, status, error)}
    parts = urlsplit(url)
    segs = [s for s in parts.path.split("/") if s]
    query = dict(parse_qsl(parts.query))
    first = segs[0] if segs else None
    return {**base, **_classify(host, segs, first, query)}


def _token_result(ats, token, where):
    tok = _token(token)
    if tok:
        return _result(ats, CANDIDATE, f"{ats} board token from {where}; not verified", {"token": tok})
    return _result(ats, INCOMPLETE, f"{ats} host but no board token in {where}")


def _classify(host, segs, first, query):
    # Greenhouse
    if host in ("boards.greenhouse.io", "job-boards.greenhouse.io"):
        if first == "embed":
            return _token_result("greenhouse", query.get("for"), "embed ?for= param")
        return _token_result("greenhouse", first, "path")
    if host == "boards-api.greenhouse.io":
        return _token_result("greenhouse", segs[2] if segs[:2] == ["v1", "boards"] and len(segs) > 2 else None, "API path")
    if host in ("boards.eu.greenhouse.io", "job-boards.eu.greenhouse.io"):
        return _result("greenhouse", UNSUPPORTED, "EU Greenhouse board; fetch_greenhouse only calls the US API",
                       {"token": _token(first)} if _token(first) else None)
    # Lever
    if host == "jobs.lever.co":
        return _token_result("lever", first, "path")
    if host == "api.lever.co":
        return _token_result("lever", segs[2] if segs[:2] == ["v0", "postings"] and len(segs) > 2 else None, "API path")
    if host in ("jobs.eu.lever.co", "api.eu.lever.co"):
        return _result("lever", UNSUPPORTED, "EU Lever board; fetch_lever only calls the US API")
    # Ashby
    if host == "jobs.ashbyhq.com":
        return _token_result("ashby", first, "path")
    if host == "api.ashbyhq.com":
        ok = segs[:2] == ["posting-api", "job-board"] and len(segs) > 2
        return _token_result("ashby", segs[2] if ok else None, "API path")
    # SmartRecruiters
    if host in ("jobs.smartrecruiters.com", "careers.smartrecruiters.com"):
        return _token_result("smartrecruiters", first, "path")
    if host == "api.smartrecruiters.com":
        ok = segs[:2] == ["v1", "companies"] and len(segs) > 2
        return _token_result("smartrecruiters", segs[2] if ok else None, "API path")
    # Workday
    m = _WORKDAY_JOBS_RE.match(host)
    if m:
        tenant, cluster = m.groups()
        if segs[:2] == ["wday", "cxs"]:
            site = segs[3] if len(segs) > 3 else None
        else:
            rest = segs[1:] if segs and _LOCALE_RE.match(segs[0]) else segs
            site = rest[0] if rest and rest[0] not in ("job", "details", "login") else None
        return _workday(tenant, cluster, site, "myworkdayjobs host/path")
    m = _WORKDAY_SITE_RE.match(host)
    if m:
        rest = segs[1:] if segs and _LOCALE_RE.match(segs[0]) else segs
        if rest[:1] == ["recruiting"] and len(rest) > 2:
            return _workday(rest[1].lower(), m.group(1), rest[2], "myworkdaysite /recruiting/ path; CXS host not checked")
        return _result("workday", INCOMPLETE, "myworkdaysite host without /recruiting/{tenant}/{site}")
    if _on(host, "myworkdayjobs.com"):
        return _result("workday", INCOMPLETE, "myworkdayjobs host without {tenant}.{wdN} cluster")
    # Official domain, but not a board host: the vendor's own site (lever.co, ashbyhq.com/careers).
    for supported in SUPPORTED_BASES:
        if _on(host, supported):
            return _result(None, WEBSITE, f"{host} is the ATS vendor's own site, not a board host")
        if re.search(r"(^|[.-])" + re.escape(supported), host):  # label boundary: clever.co is not lever.co
            return _result(None, LOOKALIKE, f"host {host} imitates {supported}")
    if any(label in _BRAND_LABELS for label in host.split(".")):
        return _result(None, LOOKALIKE, f"host {host} reuses an ATS brand under another domain")
    for unsupported, name in UNSUPPORTED_ATS.items():
        if _on(host, unsupported):
            return _result(name, UNSUPPORTED, f"{name} ATS has no connector")
    return _result(None, WEBSITE, "no supported ATS host; website or custom careers page")


def _workday(tenant, cluster, site, where):
    ids = {"tenant": tenant, "wd_cluster": cluster}
    if _token(site):
        return _result("workday", CANDIDATE, f"workday tenant/cluster/site from {where}; not verified", {**ids, "site": site})
    return _result("workday", INCOMPLETE, f"workday tenant/cluster found but no site in {where}", ids)
