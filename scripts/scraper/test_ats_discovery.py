import ast
import hashlib
import json
import random
import socket
import types
from pathlib import Path

import pytest

from scripts.scraper import ats_discovery as disc

FIX = Path(__file__).resolve().parent.parent / "fixtures" / "ats_discovery"
SOURCE = Path(disc.__file__)
ATTEMPTS = []


def _blocked(*a, **k):
    ATTEMPTS.append("attempt")
    raise AssertionError("network access attempted")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    ATTEMPTS.clear()
    for name in ("connect", "connect_ex", "sendto", "sendall"):
        monkeypatch.setattr(socket.socket, name, _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)
    monkeypatch.setattr(socket, "getaddrinfo", _blocked)
    yield
    assert ATTEMPTS in ([], ["attempt", "attempt"]), f"unexpected outbound attempts: {ATTEMPTS}"


def pages():
    return disc.load_pages(FIX / "pages.json")


def results():
    return {r["source_row"]: r for r in disc.discover(pages())["results"]}


def report():
    return json.loads((FIX / "intake_report.json").read_text(encoding="utf-8"))


def policy(**over):
    return {**json.loads((FIX / "policy.json").read_text(encoding="utf-8")), **over}


# ---- network guard -------------------------------------------------------------------------------

def test_network_guard_negative_control():
    assert socket.socket.connect is _blocked and socket.create_connection is _blocked
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s, pytest.raises(AssertionError, match="network"):
        s.connect(("guard.example", 443))           # refused by the guard before any I/O or DNS
    with pytest.raises(AssertionError, match="network"):
        socket.create_connection(("guard.example", 443))
    assert ATTEMPTS == ["attempt", "attempt"]


def test_module_uses_no_network_client():
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    mods = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    mods |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    banned = {"socket", "ssl", "http.client", "urllib.request", "httpx", "requests", "aiohttp", "urllib3", "ftplib", "smtplib"}
    assert not {m for m in mods if m in banned or m.split(".")[0] in {"httpx", "requests", "aiohttp", "urllib3"}}
    assert "urllib.parse" in mods                    # harmless urllib namespace is allowed
    calls = {(n.func.attr if isinstance(n.func, ast.Attribute) else getattr(n.func, "id", None))
             for n in ast.walk(tree) if isinstance(n, ast.Call)}
    assert not calls & {"urlopen", "urlretrieve", "create_connection", "getaddrinfo", "connect", "set_url", "read", "fetch"}


def test_end_to_end_cli_makes_no_network_attempt(tmp_path):
    assert disc.main(["discover", "--pages", str(FIX / "pages.json"), "--out", str(tmp_path / "d.json")]) == 0
    assert disc.main(["plan", "--report", str(FIX / "intake_report.json"), "--policy", str(FIX / "policy.json"),
                      "--robots", str(FIX / "robots.json"), "--out", str(tmp_path / "p.json")]) == 0
    assert ATTEMPTS == []


# ---- discovery statuses ----------------------------------------------------------------------------

def test_every_status_from_fixtures():
    out = disc.discover(pages())
    assert out["input_pages"] == 13
    assert out["by_status"] == {"found": 6, "none": 2, "ambiguous": 2, "blocked": 2, "error": 1}
    r = {x["source_row"]: x for x in out["results"]}
    assert {n: x["status"] for n, x in r.items()} == {
        2: "none", 3: "ambiguous", 4: "none", 5: "found", 6: "found", 7: "found", 8: "blocked", 9: "blocked", 10: "error",
        11: "found", 12: "found", 13: "ambiguous", 14: "found"}
    assert [x["source_row"] for x in out["results"]] == sorted(r)
    assert all(x["verified"] is False and x["company_match"] == "unconfirmed" for x in out["results"])
    assert "no retry" in r[8]["reason"] and "429" in r[8]["reason"] and "403" in r[9]["reason"]
    assert r[10]["reason"] == "HTTP 404"


def test_embed_relative_and_repeated_links_collapse_to_one_board():
    r = results()[7]
    assert [b["board_key"] for b in r["boards"]] == ["greenhouse:acme"]
    b = r["boards"][0]
    assert b["support"] == "supported" and b["evidence_count"] == 4
    assert {e["source"] for e in b["evidence"]} == {"a[href]", "iframe[src]", "script[src]"}
    assert b["evidence_kinds"] == ["anchor", "embed"] and b["linked_only"] is False
    assert "https://boards.greenhouse.io/acme/jobs/123" in {e["url"] for e in b["evidence"]}   # protocol-relative
    assert r["non_web_links_ignored"] == 3                                                     # mailto, javascript, tel
    assert [x["kind"] for x in r["rejected"]] == ["vendor_site"]                               # "Powered by" link


def test_extract_links_tags_base_meta_and_no_script_execution():
    html = (FIX / "embed_found.html").read_text(encoding="utf-8")
    links, ignored = disc.extract_links(html, "https://acme.example/careers")
    urls = {u for _, u in links}
    assert "https://acme.example/en/careers;jsessionid=ABC123SECRET" in urls     # <base href="/en/"> applied
    assert "https://acme.example/en/styles/site.css" in urls                     # link[href]
    assert not any("hidden-board" in u for u in urls)                            # inline script body never read
    assert ignored == 3
    meta, _ = disc.extract_links((FIX / "meta_refresh.html").read_text(encoding="utf-8"), "https://refresh.example/")
    assert meta == [("meta[refresh]", "https://acme.wd5.myworkdayjobs.com/en-US/Acme_External")]
    form, _ = disc.extract_links('<form action="/apply"></form><area href="x"><embed src="//e.example/a">', "https://s.example/j/")
    assert form == [("area[href]", "https://s.example/j/x"), ("embed[src]", "https://e.example/a"), ("form[action]", "https://s.example/apply")]


def test_redirect_onto_board_is_found():
    r = results()[11]
    assert r["status"] == "found" and r["boards"][0]["board_key"] == "lever:redirected"
    assert r["boards"][0]["evidence"] == [{"source": "final_url", "kind": "final_url", "url": "https://jobs.lever.co/redirected"}]


def test_workday_meta_refresh_found():
    b = results()[6]["boards"][0]
    assert b["identifiers"] == {"site": "Acme_External", "tenant": "acme", "wd_cluster": "wd5"}


def test_unsupported_vendor_stays_unsupported_not_ready():
    r = results()[5]
    assert r["status"] == "found" and len(r["boards"]) == 1
    b = r["boards"][0]
    assert (b["support"], b["ats"], b["evidence_count"]) == ("unsupported", "workable", 3)
    assert "not ready to ingest" in r["reason"]
    assert [x["kind"] for x in r["rejected"]] == ["vendor_site"]


def test_multiple_boards_ambiguous_never_first_wins():
    r = results()[3]
    assert r["status"] == "ambiguous"
    assert [b["board_key"] for b in r["boards"]] == ["ashby:acme-labs", "lever:acme"]
    mixed = disc.discover_page({"source_row": 1, "final_url": "https://m.example/", "http_status": 200, "redirect_chain": [],
                                "html": '<a href="https://jobs.lever.co/acme"></a><a href="https://acme.breezy.hr/"></a>'})
    assert mixed["status"] == "ambiguous"                                   # supported + unsupported board
    for order in ([0, 1], [1, 0]):
        links = ['<a href="https://jobs.lever.co/a"></a>', '<a href="https://jobs.ashbyhq.com/b"></a>']
        page = {"source_row": 1, "final_url": "https://o.example/", "http_status": 200, "redirect_chain": [],
                "html": "".join(links[i] for i in order)}
        assert disc.discover_page(page)["status"] == "ambiguous"            # link order never picks a winner


def test_lookalikes_and_vendor_links_rejected():
    r = results()[4]
    assert r["status"] == "none" and r["boards"] == []
    assert sorted((x["kind"], x["url"]) for x in r["rejected"]) == [
        ("incomplete", "https://jobs.lever.co/"),
        ("lookalike", "https://boards-greenhouse.io/acme"),
        ("lookalike", "https://jobs.ashbyhq.net/acme"),
        ("lookalike", "https://jobs.lever.co.evil.example/acme"),
        ("vendor_site", "https://www.lever.co/")]


@pytest.mark.parametrize("url,kind", [
    ("https://www.workable.com/customers", "vendor_site"), ("https://help.workable.com/x", "vendor_site"),
    ("https://apply.workable.com/", "incomplete"), ("https://ats.rippling.com/", "incomplete"),
    ("https://ats.rippling.com/acme/jobs", "unsupported_board"), ("https://acme.breezy.hr/", "unsupported_board"),
    ("https://job-boards.eu.greenhouse.io/acme", "unsupported_board"), ("https://www.greenhouse.io/", "vendor_site"),
    ("https://jobs.lever.co/acme", "board"), ("https://acme.example/careers", "other"),
])
def test_classify_link(url, kind):
    assert disc.classify_link(url)["kind"] == kind


def test_eu_greenhouse_boards_keep_distinct_identity():
    a, b = (disc.classify_link(f"https://job-boards.eu.greenhouse.io/{t}")["key"] for t in ("one", "two"))
    assert a != b


# ---- caps and malformed input ----------------------------------------------------------------------

def test_page_size_and_link_caps():
    page = {"source_row": 1, "final_url": "https://c.example/", "http_status": 200, "redirect_chain": [],
            "html": "<a href='https://jobs.lever.co/a'></a>" + "x" * 200}
    assert disc.discover_page(page, max_bytes=100)["status"] == "error"
    assert "cap" in disc.discover_page(page, max_bytes=100)["reason"]
    assert disc.discover_page({**page, "html": page["html"].encode()}, max_bytes=100)["status"] == "error"   # bytes too
    many = "".join(f"<a href='/p{i}'></a>" for i in range(6)) + "<a href='https://jobs.lever.co/a'></a>"
    capped = disc.discover_page({**page, "html": many}, max_links=5)
    assert capped["status"] == "error" and "more than 5 links" in capped["reason"]
    assert disc.discover_page({**page, "html": many}, max_links=50)["status"] == "found"


@pytest.mark.parametrize("change,reason", [
    ({"http_status": "200"}, "not an integer"), ({"http_status": None}, "not an integer"),
    ({"http_status": 301}, "HTTP 301"), ({"html": None}, "html missing"), ({"final_url": "ftp://x.example"}, "final_url"),
    ({"redirect_chain": "https://x.example"}, "redirect_chain"),
])
def test_malformed_page_is_error(change, reason):
    page = {"source_row": 1, "final_url": "https://c.example/", "http_status": 200, "redirect_chain": [], "html": "<p>"}
    r = disc.discover_page({**page, **change})
    assert r["status"] == "error" and reason in r["reason"]


@pytest.mark.parametrize("bad,msg", [
    ([{"source_row": True, "http_status": 200}], "integer source_row"),
    ([{"source_row": 2}, {"source_row": 2}], "twice"), ({"source_row": 2}, "must be a list"),
])
def test_discover_rejects_bad_row_refs(bad, msg):
    with pytest.raises(disc.DiscoveryError, match=msg):
        disc.discover(bad)


def test_manifest_html_file_cannot_escape(tmp_path):
    (tmp_path / "m.json").write_text(json.dumps([{"source_row": 2, "html_file": "../outside.html"}]), encoding="utf-8")
    with pytest.raises(disc.DiscoveryError, match="escapes"):
        disc.load_pages(tmp_path / "m.json")


# ---- robots.txt evaluation ---------------------------------------------------------------------------

UA = "CMBot/1.0"


def robots_json():
    return json.loads((FIX / "robots.json").read_text(encoding="utf-8"))


def plan(rep=None, pol=None, rob="fixture"):
    return disc.plan_fetches(rep or report(), pol or policy(), robots_json() if rob == "fixture" else rob)


def ev(body, url="https://a.example/careers", status=200, ua=UA, on_4xx="unknown"):
    return disc.evaluate_robots({"status": status, "body": body}, url, ua, on_4xx)[0]


@pytest.mark.parametrize("body,url,state", [
    ("User-agent: *\nDisallow: /private\n", "https://a.example/private/x", "deny"),
    ("User-agent: *\nDisallow: /private\n", "https://a.example/careers", "allow"),
    ("User-agent: *\nAllow: /careers\nDisallow: /\n", "https://a.example/careers", "allow"),   # both readings agree
    ("User-agent: *\nAllow: /careers\nDisallow: /\n", "https://a.example/about", "deny"),
    ("User-agent: *\nDisallow: /\n", "https://a.example/", "deny"),
    ("", "https://a.example/anything", "allow"),                                                 # empty robots.txt: no rules
    ("# only a comment\n", "https://a.example/anything", "allow"),
])
def test_path_allow_and_deny(body, url, state):
    assert ev(body, url) == state


@pytest.mark.parametrize("body,path", [
    ("User-agent: *\nAllow: /\nDisallow: /careers\n", "/careers"),      # robotparser: allow (first); RFC 9309: deny (longest)
    ("User-agent: *\nDisallow: /\nAllow: /careers\n", "/careers"),      # robotparser: deny; RFC 9309: allow
])
def test_rule_order_disagreement_is_unknown_never_allowed(body, path):
    state, why = disc.evaluate_robots({"status": 200, "body": body}, "https://a.example" + path, UA, "unknown")
    assert state == "unknown" and "RFC 9309" in why


def test_partial_or_repeated_user_agent_groups_are_unknown():
    assert ev("User-agent: bot\nAllow: /\n") == "unknown"                    # "bot" is only a substring of "cmbot"
    assert ev("User-agent: CMBot\nAllow: /\n\nUser-agent: cmbot\nDisallow: /careers\n") == "unknown"


def test_specific_and_wildcard_user_agents():
    body = "User-agent: CMBot\nDisallow: /careers\n\nUser-agent: *\nAllow: /\n"
    assert ev(body, ua="CMBot/1.0") == "deny"           # specific group applies to us
    assert ev(body, ua="OtherBot/2.0") == "allow"       # others fall back to *
    body2 = "User-agent: OtherBot\nDisallow: /\n\nUser-agent: *\nDisallow: /careers\n"
    assert ev(body2) == "deny"                          # wildcard group applies when ours is absent
    assert ev("User-agent: OtherBot\nDisallow: /\n") == "allow"   # no group for us and no *: nothing disallowed


@pytest.mark.parametrize("response,reason", [
    (None, "missing"), ({"body": "User-agent: *"}, "no integer status"), ({"status": "200", "body": ""}, "no integer status"),
    ({"status": 200}, "body missing"), ({"status": 200, "body": b"\xff\xfe"}, "not UTF-8"),
    ({"status": 200, "body": "<html><body>Hi</body></html>"}, "no robots directives"),
    ({"status": 200, "body": "random words\nmore words"}, "no robots directives"),
    ({"status": 200, "body": "User-agent: *\nDisallow: /*careers$\n"}, "path wildcards"),
    ({"status": 200, "body": "User-agent: *\n" + "Disallow: /x\n" * 60000}, "500 KiB"),
    ({"status": 500, "body": ""}, "HTTP 500"), ({"status": 503, "body": "busy"}, "HTTP 503"),
    ({"status": 301, "body": ""}, "HTTP 301"),
])
def test_missing_garbage_and_failed_robots_stay_unknown(response, reason):
    state, why = disc.evaluate_robots(response, "https://a.example/careers", UA, "allow")
    assert state == "unknown" and reason in why        # even with robots_4xx=allow, these never allow


@pytest.mark.parametrize("on_4xx", ["unknown", "allow", "deny"])
@pytest.mark.parametrize("status", [401, 403, 404, 410])
def test_robots_4xx_follows_explicit_policy(status, on_4xx):
    state, why = disc.evaluate_robots({"status": status, "body": ""}, "https://a.example/careers", UA, on_4xx)
    assert state == on_4xx and f"robots_4xx={on_4xx}" in why


def test_robots_4xx_default_is_unknown():
    assert disc.validate_policy({k: v for k, v in policy().items() if k != "robots_4xx"})["robots_4xx"] == "unknown"
    p = plan()
    assert 15 in p["rows"]["robots_unknown"]                       # epsilon.example robots.txt is 404
    p_allow = plan(pol=policy(robots_4xx="allow", global_request_cap=100))
    assert 15 in p_allow["rows"]["planned"]                        # only when policy says so


# ---- planner ----------------------------------------------------------------------------------------

def test_plan_reconciles_every_row_once():
    p = plan()
    rec = p["reconciliation"]
    assert rec["input_rows"] == rec["categorized_rows"] == 20
    assert p["rows"] == {"planned": [2, 4, 5, 20], "awaiting_robots": [7, 19], "deferred_request_cap": [21],
                         "robots_unknown": [14, 15, 17, 18], "robots_deny": [3, 6], "skipped_job_board_or_social": [8],
                         "skipped_file": [9], "invalid_url": [16], "merged_duplicate": [10],
                         "invalid_merge_reference": [11], "not_website_only": [12, 13]}
    assert sorted(n for v in p["rows"].values() for n in v) == list(range(2, 22))


def test_robots_requests_first_and_budget_counts_both():
    p = plan()
    assert [(q["seq"], q["kind"], q["url"], q["source_rows"], q["not_before_seconds"]) for q in p["requests"]] == [
        (1, "robots", "https://unknown.example/robots.txt", [7], 0),
        (2, "robots", "https://zeta.example/robots.txt", [19], 0),
        (3, "page", "https://alpha.example/careers", [2, 4], 0),
        (4, "page", "https://alpha.example/jobs", [20], 30),
        (5, "page", "https://beta.example", [5], 0)]
    rec = p["reconciliation"]
    assert (rec["robots_requests"], rec["page_requests"], rec["planned_requests"]) == (2, 3, 5) == (2, 3, policy()["global_request_cap"])
    assert p["samples"]["deferred_request_cap"][0]["reason"] == "global request cap 5 reached before this page request"


def test_budget_exhausted_by_robots_defers_pages_and_robots():
    p = plan(pol=policy(global_request_cap=1))
    assert [q["kind"] for q in p["requests"]] == ["robots"]
    assert p["rows"]["awaiting_robots"] == [7]
    assert p["rows"]["deferred_request_cap"] == [2, 4, 5, 19, 20, 21]   # zeta's robots and every page wait


def test_host_spacing_counts_robots_and_pages_together():
    rep = report()
    rep["records"].append({**rep["records"][0], "source_row": 22, "normalized_url": "https://unknown.example/other"})
    rep["reconciliation"]["input_rows"] += 1
    rob = robots_json()
    p = disc.plan_fetches(rep, policy(global_request_cap=100), rob)
    unknown = [q for q in p["requests"] if q["host"] == "unknown.example"]
    assert [(q["kind"], q["source_rows"]) for q in unknown] == [("robots", [7, 22])]   # one robots request per origin
    # Same host, robots + pages: once rules arrive, pages queue behind the robots request on that host.
    rob["https://unknown.example"] = {"status": 200, "body": "User-agent: *\nAllow: /\n"}
    rep["records"].append({**rep["records"][0], "source_row": 23, "normalized_url": "https://unknown2.example/a"})
    rep["reconciliation"]["input_rows"] += 1
    p2 = disc.plan_fetches(rep, policy(global_request_cap=100), rob)
    hosts = [(q["host"], q["kind"], q["not_before_seconds"]) for q in p2["requests"] if q["host"].startswith("unknown")]
    assert hosts == [("unknown2.example", "robots", 0), ("unknown.example", "page", 0), ("unknown.example", "page", 30)]


def test_without_robots_input_only_robots_requests_are_planned():
    p = plan(rob=None, pol=policy(global_request_cap=100))
    assert {q["kind"] for q in p["requests"]} == {"robots"}
    assert p["rows"].get("planned") is None
    assert len({q["url"] for q in p["requests"]}) == len(p["requests"])   # one request per unique URL


def test_robots_unknown_never_counts_as_allowed():
    p = plan(pol=policy(global_request_cap=100))
    planned_hosts = {q["host"] for q in p["requests"] if q["kind"] == "page"}
    assert planned_hosts == {"alpha.example", "beta.example"}
    assert not planned_hosts & {"delta.example", "epsilon.example", "garbage.example", "wild.example", "denied.example"}


@pytest.mark.parametrize("over,msg", [
    ({"retries": 1}, "no retries"), ({"requests_per_url": 2}, "one request per URL"),
    ({"stop_on_status": [403]}, "403 and 429"), ({"per_host_spacing_seconds": 0}, "positive number"),
    ({"per_host_spacing_seconds": True}, "positive number"), ({"global_request_cap": 0}, "positive integer"),
    ({"global_request_cap": True}, "positive integer"), ({"max_response_bytes": -1}, "positive integer"),
    ({"user_agent": ""}, "user_agent is required"), ({"user_agent": "   "}, "user_agent is required"),
    ({"user_agent": None}, "user_agent is required"), ({"user_agent": "a\nb"}, "user_agent is required"),
    ({"robots_4xx": "maybe"}, "robots_4xx"), ({"robots": {"a.example": "allow"}}, "unknown policy keys"),
    ({"default_robots": "allow"}, "unknown policy keys"),
])
def test_policy_validation(over, msg):
    with pytest.raises(disc.DiscoveryError, match=msg):
        plan(pol=policy(**over))


def test_missing_user_agent_rejected():
    with pytest.raises(disc.DiscoveryError, match="user_agent is required"):
        plan(pol={k: v for k, v in policy().items() if k != "user_agent"})


@pytest.mark.parametrize("mutate,msg", [
    (lambda r: r.pop("records"), "'records' list"),
    (lambda r: r["records"][0].update(source_row=True), "integer source_row"),
    (lambda r: r["records"][1].update(source_row=2), "twice"),
])
def test_plan_rejects_bad_report(mutate, msg):
    rep = report()
    mutate(rep)
    with pytest.raises(disc.DiscoveryError, match=msg):
        plan(rep=rep)


def test_robots_input_must_be_object():
    with pytest.raises(disc.DiscoveryError, match="keyed by origin"):
        plan(rob=["https://a.example"])


# ---- board identity -----------------------------------------------------------------------------------

def test_case_equivalent_token_boards_deduplicate():
    r = results()[12]
    assert r["status"] == "found" and [b["board_key"] for b in r["boards"]] == ["greenhouse:acme"]
    b = r["boards"][0]
    assert b["identifier_variants"] == [{"token": "ACME"}, {"token": "acme"}]   # both spellings kept as evidence
    assert b["evidence_kinds"] == ["anchor", "embed"]


@pytest.mark.parametrize("ats,a,b", [("greenhouse", "Acme", "acme"), ("lever", "ACME", "acme"),
                                     ("ashby", "Acme-Labs", "acme-labs"), ("smartrecruiters", "Visa", "VISA")])
def test_token_vendor_identity_matches_existing_helper(ats, a, b):
    from scripts.scraper.enrichment import build_source_id
    assert disc.board_identity(ats, {"token": a}) == disc.board_identity(ats, {"token": b}) == build_source_id(ats, a)


def test_workday_site_case_stays_significant():
    r = results()[13]
    assert r["status"] == "ambiguous" and len(r["boards"]) == 2
    a = disc.board_identity("workday", {"tenant": "acme", "wd_cluster": "wd5", "site": "External"})
    b = disc.board_identity("workday", {"tenant": "acme", "wd_cluster": "wd5", "site": "external"})
    assert a != b


def test_genuinely_different_boards_stay_ambiguous():
    for html in ('<a href="https://jobs.lever.co/acme"></a><a href="https://jobs.lever.co/acme2"></a>',
                 '<a href="https://jobs.lever.co/acme"></a><a href="https://jobs.ashbyhq.com/acme"></a>',
                 '<a href="https://acme.breezy.hr/"></a><a href="https://ACME2.breezy.hr/"></a>'):
        page = {"source_row": 1, "final_url": "https://d.example/", "http_status": 200, "redirect_chain": [], "html": html}
        assert disc.discover_page(page)["status"] == "ambiguous", html


def test_unsupported_vendor_path_case_not_folded():
    a = disc.classify_link("https://apply.workable.com/Acme/")["key"]
    b = disc.classify_link("https://apply.workable.com/acme/")["key"]
    assert a != b                                                      # no identity rule establishes case-insensitivity


def test_partner_link_is_never_a_company_match():
    r = results()[14]
    assert r["status"] == "found" and r["company_match"] == "unconfirmed" and r["verified"] is False
    b = r["boards"][0]
    assert b["linked_only"] is True and b["evidence_kinds"] == ["anchor"]
    assert "partner or customer" in r["reason"] and "verified" not in r["reason"].replace("unverified", "")


# ---- negative controls: robots path enforcement and false dedupe ---------------------------------------

def test_negative_control_robots_path_enforcement():
    before = _source_sha()
    mutant = _mutant("    if allowed:\n", "    if True:\n")
    bad = mutant.plan_fetches(report(), policy(), robots_json())
    assert 3 in bad["rows"]["planned"] and "robots_deny" not in bad["rows"]   # mutant plans a disallowed path
    good = plan()
    assert good["rows"]["robots_deny"] == [3, 6] and 3 not in good["rows"]["planned"]
    assert _source_sha() == before


def test_negative_control_false_board_dedup():
    before = _source_sha()
    mutant = _mutant('    return f"{ats}:{json.dumps(identifiers, sort_keys=True)}"',
                     '    return f"{ats}:{json.dumps(identifiers, sort_keys=True)}".lower()')
    bad = {r["source_row"]: r for r in mutant.discover(pages())["results"]}[13]
    assert bad["status"] == "found"                                     # mutant folds Workday site case: false dedupe
    assert results()[13]["status"] == "ambiguous"
    assert _source_sha() == before


# ---- redaction --------------------------------------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("https://u:pw@Acme.Example:443/careers;jsessionid=X/jobs;sid=Y?token=S#frag", "https://acme.example/careers/jobs"),
    ("http://acme.example:8080/a?b=c", "http://acme.example:8080/a"),
    ("acme.example/careers?x=1", "https://acme.example/careers"),
    ("https://[bad", "<unparseable>"), ("", None), (None, None),
])
def test_redact_url(raw, expected):
    assert disc.redact_url(raw) == expected


@pytest.mark.parametrize("name", ["C# Labs", "What? Inc", "AT&T; Partners", "Yes! Co.", "## Heading"])
def test_ordinary_names_kept(name):
    assert disc.redact_text(name) == name


@pytest.mark.parametrize("raw,expected", [
    ("see acme.example/p;jsessionid=S?q=1", "see acme.example/p"), ("tok?x=S", "tok"),
    ("login u:pw@acme.example", "login <redacted>"), ("What? Inc https://w.example/?s=S", "What? Inc https://w.example/"),
])
def test_redact_text_removes_secrets(raw, expected):
    assert disc.redact_text(raw) == expected


def test_outputs_carry_no_secrets_and_keep_names(tmp_path):
    rep = report()
    next(r for r in rep["records"] if r["source_row"] == 7)["company"] = "C# Labs & What? Inc"
    (tmp_path / "r.json").write_text(json.dumps(rep), encoding="utf-8")
    assert disc.main(["discover", "--pages", str(FIX / "pages.json"), "--out", str(tmp_path / "d.json")]) == 0
    assert disc.main(["plan", "--report", str(tmp_path / "r.json"), "--policy", str(FIX / "policy.json"),
                      "--out", str(tmp_path / "p.json")]) == 0
    texts = [(tmp_path / n).read_text(encoding="utf-8") for n in ("d.json", "p.json")]
    for text in texts:
        for secret in ("SECRET", "hunter2", "jsessionid", "token=", "gh_src", "utm_", "#frag", "u:pw", "session="):
            assert secret not in text, secret
    assert '"C# Labs & What? Inc"' in texts[1]


# ---- determinism ------------------------------------------------------------------------------------

def test_deterministic_bytes_and_order_independent(tmp_path):
    for d in ("a", "b"):
        disc.main(["discover", "--pages", str(FIX / "pages.json"), "--out", str(tmp_path / d / "d.json")])
        disc.main(["plan", "--report", str(FIX / "intake_report.json"), "--policy", str(FIX / "policy.json"),
                   "--robots", str(FIX / "robots.json"), "--out", str(tmp_path / d / "p.json")])
    for n in ("d.json", "p.json"):
        assert (tmp_path / "a" / n).read_bytes() == (tmp_path / "b" / n).read_bytes()
    shuffled = pages()
    random.Random(3).shuffle(shuffled)
    assert disc.discover(shuffled) == disc.discover(pages())
    rep = report()
    random.Random(5).shuffle(rep["records"])
    assert disc.plan_fetches(rep, policy(), robots_json()) == disc.plan_fetches(report(), policy(), robots_json())


# ---- negative controls by in-memory mutation (the source file is never written) ----------------------

def _mutant(old: str, new: str) -> types.ModuleType:
    src = SOURCE.read_text(encoding="utf-8")
    assert src.count(old) == 1, old
    mod = types.ModuleType("ats_discovery_mutant")
    mod.__dict__.update(__package__="scripts.scraper", __file__=str(SOURCE))
    exec(compile(src.replace(old, new), str(SOURCE), "exec"), mod.__dict__)
    return mod


def _source_sha() -> str:
    return hashlib.sha256(SOURCE.read_bytes()).hexdigest()


def test_negative_control_lookalike_rejection():
    before = _source_sha()
    mutant = _mutant('if det["status"] == ad.CANDIDATE:', 'if det["status"] in (ad.CANDIDATE, ad.LOOKALIKE):')
    bad = {r["source_row"]: r for r in mutant.discover(pages())["results"]}[4]
    assert bad["status"] != "none" and bad["boards"]         # mutant accepts lookalikes: the real check would fail
    assert results()[4]["status"] == "none"                   # real module rejects them
    assert _source_sha() == before                            # source bytes unchanged


def test_negative_control_multi_board_ambiguity():
    before = _source_sha()
    mutant = _mutant("if len(boards) > 1:", "if len(boards) > 99:")
    bad = {r["source_row"]: r for r in mutant.discover(pages())["results"]}[3]
    assert bad["status"] == "found"                           # mutant lets the first board win
    assert results()[3]["status"] == "ambiguous"
    assert _source_sha() == before


# ---- correction round 2: leading BOM and Crawl-delay ---------------------------------------------------

BOM_CASES = [("User-agent: *\nDisallow: /\n", "deny"), ("User-agent: *\nAllow: /\n", "allow"),
             ("User-agent: CMBot\nDisallow: /careers\n\nUser-agent: *\nAllow: /\n", "deny")]


def _bom_bodies(text):
    return [("str", "﻿" + text), ("bytes", ("﻿" + text).encode("utf-8")), ("bytes-sig", text.encode("utf-8-sig"))]


@pytest.mark.parametrize("text,expected", BOM_CASES)
def test_leading_bom_is_normalized_for_str_and_bytes(text, expected):
    for kind, body in _bom_bodies(text):
        state, why = disc.evaluate_robots({"status": 200, "body": body}, "https://a.example/careers", UA, "unknown")
        assert state == expected, (kind, why)


def test_bom_disallow_all_blocks_pages_in_plan():
    rob = robots_json()
    rob["https://alpha.example"] = {"status": 200, "body": "﻿User-agent: *\nDisallow: /\n"}
    p = plan(rob=rob, pol=policy(global_request_cap=100))
    assert {2, 3, 4, 20} <= set(p["rows"]["robots_deny"])
    assert all(q["host"] != "alpha.example" for q in p["requests"])


def _mutant_many(pairs) -> types.ModuleType:
    src = SOURCE.read_text(encoding="utf-8")
    for old, new in pairs:
        assert src.count(old) == 1, old
        src = src.replace(old, new)
    mod = types.ModuleType("ats_discovery_mutant")
    mod.__dict__.update(__package__="scripts.scraper", __file__=str(SOURCE))
    exec(compile(src, str(SOURCE), "exec"), mod.__dict__)
    return mod


def test_negative_control_bom_handling_removed():
    before = _source_sha()
    mutant = _mutant_many([('body.decode("utf-8-sig")', 'body.decode("utf-8")'),
                           ('body = body[1:] if body.startswith("\ufeff") else body', "body = body")])
    failures = 0
    for text, expected in BOM_CASES:
        for kind, body in _bom_bodies(text):
            state, _ = mutant.evaluate_robots({"status": 200, "body": body}, "https://a.example/careers", UA, "unknown")
            failures += state != expected
    assert failures >= 6          # every BOM "Disallow" case (str and bytes) flips to allow without the fix
    deny_all = "﻿User-agent: *\nDisallow: /\n"
    assert mutant.evaluate_robots({"status": 200, "body": deny_all}, "https://a.example/x", UA, "unknown")[0] == "allow"
    assert disc.evaluate_robots({"status": 200, "body": deny_all}, "https://a.example/x", UA, "unknown")[0] == "deny"
    assert _source_sha() == before


@pytest.mark.parametrize("body,delay", [
    ("User-agent: *\nCrawl-delay: 45\nAllow: /\n", 45),
    ("User-agent: CMBot\nCrawl-delay: 90\nAllow: /\n\nUser-agent: *\nCrawl-delay: 5\n", 90),   # specific group wins
    ("User-agent: OtherBot\nCrawl-delay: 90\n\nUser-agent: *\nCrawl-delay: 5\n", 5),           # falls back to *
    ("﻿User-agent: *\nCrawl-delay: 12\n", 12),
    ("User-agent: *\nAllow: /\n", None),
])
def test_crawl_delay_parsed_per_user_agent(body, delay):
    assert disc.robots_crawl_delay({"status": 200, "body": body}, UA) == delay


def test_unreadable_crawl_delay_is_unknown():
    state, why = disc.evaluate_robots({"status": 200, "body": "User-agent: *\nCrawl-delay: 2.5\nAllow: /\n"},
                                      "https://a.example/careers", UA, "unknown")
    assert state == "unknown" and "Crawl-delay" in why
    assert disc.robots_crawl_delay({"status": 503, "body": "User-agent: *\nCrawl-delay: 5\n"}, UA) is None


def _alpha_delay(seconds):
    rob = robots_json()
    rob["https://alpha.example"] = {"status": 200, "body": f"User-agent: *\nCrawl-delay: {seconds}\nDisallow: /about\n"}
    return rob


def test_crawl_delay_above_spacing_defers_pages_and_frees_budget():
    p = plan(rob=_alpha_delay(60), pol=policy(per_host_spacing_seconds=30))
    alpha = next(e for e in p["robots_evaluated"] if e["origin"] == "https://alpha.example")
    assert (alpha["crawl_delay"], alpha["crawl_delay_exceeds_spacing"]) == (60, True)
    assert p["rows"]["deferred_crawl_delay"] == [2, 4, 20]
    assert "Crawl-delay 60s exceeds per_host_spacing_seconds 30" in p["samples"]["deferred_crawl_delay"][0]["reason"]
    assert all(q["host"] != "alpha.example" for q in p["requests"])
    # Deferred pages use no budget: beta's two pages now fit within the same cap of 5.
    assert [(q["kind"], q["host"], q["source_rows"]) for q in p["requests"]] == [
        ("robots", "unknown.example", [7]), ("robots", "zeta.example", [19]),
        ("page", "beta.example", [5]), ("page", "beta.example", [21])]
    assert p["rows"].get("deferred_request_cap") is None
    assert p["rows"]["robots_deny"] == [3, 6]                          # deny still wins over delay handling


@pytest.mark.parametrize("spacing", [60, 90])
def test_crawl_delay_planned_when_spacing_is_at_least_that_long(spacing):
    p = plan(rob=_alpha_delay(60), pol=policy(per_host_spacing_seconds=spacing, global_request_cap=100))
    alpha = [q for q in p["requests"] if q["host"] == "alpha.example"]
    assert [(q["source_rows"], q["not_before_seconds"]) for q in alpha] == [([2, 4], 0), ([20], spacing)]
    assert p["rows"].get("deferred_crawl_delay") is None
    assert next(e for e in p["robots_evaluated"] if e["origin"] == "https://alpha.example")["crawl_delay_exceeds_spacing"] is False


def test_plan_states_fetcher_responsibilities_and_reconciles():
    p = plan(rob=_alpha_delay(60))
    assert any("redirect" in x for x in p["fetcher_responsibilities"])
    assert any("http://" in x and "https://" in x for x in p["fetcher_responsibilities"])
    rec = p["reconciliation"]
    assert rec["input_rows"] == rec["categorized_rows"] == 20
