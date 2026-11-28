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
                      "--out", str(tmp_path / "p.json")]) == 0
    assert ATTEMPTS == []


# ---- discovery statuses ----------------------------------------------------------------------------

def test_every_status_from_fixtures():
    out = disc.discover(pages())
    assert out["input_pages"] == 10
    assert out["by_status"] == {"found": 4, "none": 2, "ambiguous": 1, "blocked": 2, "error": 1}
    r = {x["source_row"]: x for x in out["results"]}
    assert {n: x["status"] for n, x in r.items()} == {
        2: "none", 3: "ambiguous", 4: "none", 5: "found", 6: "found", 7: "found", 8: "blocked", 9: "blocked", 10: "error", 11: "found"}
    assert [x["source_row"] for x in out["results"]] == sorted(r)
    assert all(x["verified"] is False for x in out["results"])
    assert "no retry" in r[8]["reason"] and "429" in r[8]["reason"] and "403" in r[9]["reason"]
    assert r[10]["reason"] == "HTTP 404"


def test_embed_relative_and_repeated_links_collapse_to_one_board():
    r = results()[7]
    assert [b["board_key"] for b in r["boards"]] == ['greenhouse:{"token": "acme"}']
    b = r["boards"][0]
    assert b["support"] == "supported" and b["evidence_count"] == 4
    assert {e["source"] for e in b["evidence"]} == {"a[href]", "iframe[src]", "script[src]"}
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
    assert r["status"] == "found" and r["boards"][0]["board_key"] == 'lever:{"token": "redirected"}'
    assert r["boards"][0]["evidence"] == [{"source": "final_url", "url": "https://jobs.lever.co/redirected"}]


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
    assert [b["board_key"] for b in r["boards"]] == ['ashby:{"token": "acme-labs"}', 'lever:{"token": "acme"}']
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


# ---- planner ----------------------------------------------------------------------------------------

def test_plan_reconciles_every_row_once():
    p = disc.plan_fetches(report(), policy())
    rec = p["reconciliation"]
    assert rec["input_rows"] == rec["categorized_rows"] == 15
    assert p["rows"] == {"planned": [2, 3, 4, 5, 14], "deferred_request_cap": [15], "robots_unknown": [7], "robots_deny": [6],
                         "skipped_job_board_or_social": [8], "skipped_file": [9], "invalid_url": [16],
                         "merged_duplicate": [10], "invalid_merge_reference": [11], "not_website_only": [12, 13]}
    assert sorted(n for v in p["rows"].values() for n in v) == list(range(2, 17))


def test_plan_one_request_per_url_spacing_and_cap():
    p = disc.plan_fetches(report(), policy())
    assert [(r["seq"], r["host"], r["source_rows"], r["not_before_seconds"]) for r in p["requests"]] == [
        (1, "alpha.example", [3], 0), (2, "alpha.example", [2, 4], 30), (3, "beta.example", [5], 0), (4, "delta.example", [14], 0)]
    assert p["reconciliation"]["planned_requests"] == 4 == p["policy"]["global_request_cap"]
    big = disc.plan_fetches(report(), policy(global_request_cap=100, per_host_spacing_seconds=90))
    assert [r["not_before_seconds"] for r in big["requests"] if r["host"] == "alpha.example"] == [0, 90]
    assert big["rows"].get("deferred_request_cap") is None


def test_robots_unknown_never_counts_as_allowed():
    p = disc.plan_fetches(report(), policy())
    assert p["robots_pending_hosts"] == ["unknown.example"]
    assert all(r["host"] != "unknown.example" for r in p["requests"])
    allow_all = disc.plan_fetches(report(), policy(default_robots="allow", global_request_cap=100))
    assert 7 in allow_all["rows"]["planned"]                          # only an explicit allow plans it
    deny_all = disc.plan_fetches(report(), policy(robots={}, default_robots="deny"))
    assert deny_all["requests"] == [] and 2 in deny_all["rows"]["robots_deny"]


@pytest.mark.parametrize("over,msg", [
    ({"retries": 1}, "no retries"), ({"requests_per_url": 2}, "one request per URL"),
    ({"stop_on_status": [403]}, "403 and 429"), ({"per_host_spacing_seconds": 0}, "positive number"),
    ({"per_host_spacing_seconds": True}, "positive number"), ({"global_request_cap": 0}, "positive integer"),
    ({"global_request_cap": True}, "positive integer"), ({"max_response_bytes": -1}, "positive integer"),
    ({"robots": {"a.example": "maybe"}}, "robots values"), ({"default_robots": "yes"}, "default_robots"),
])
def test_policy_validation(over, msg):
    with pytest.raises(disc.DiscoveryError, match=msg):
        disc.plan_fetches(report(), policy(**over))


@pytest.mark.parametrize("mutate,msg", [
    (lambda r: r.pop("records"), "'records' list"),
    (lambda r: r["records"][0].update(source_row=True), "integer source_row"),
    (lambda r: r["records"][1].update(source_row=2), "twice"),
])
def test_plan_rejects_bad_report(mutate, msg):
    rep = report()
    mutate(rep)
    with pytest.raises(disc.DiscoveryError, match=msg):
        disc.plan_fetches(rep, policy())


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
                   "--out", str(tmp_path / d / "p.json")])
    for n in ("d.json", "p.json"):
        assert (tmp_path / "a" / n).read_bytes() == (tmp_path / "b" / n).read_bytes()
    shuffled = pages()
    random.Random(3).shuffle(shuffled)
    assert disc.discover(shuffled) == disc.discover(pages())
    rep = report()
    random.Random(5).shuffle(rep["records"])
    assert disc.plan_fetches(rep, policy()) == disc.plan_fetches(report(), policy())


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
