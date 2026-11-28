import ast
import json
import random
import socket
from pathlib import Path

import pytest

from scripts.scraper import intake_triage as it

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "intake_triage_report.example.json"


ATTEMPTS = []


def _blocked(*a, **k):
    ATTEMPTS.append(a[1:] if a and isinstance(a[0], socket.socket) else a)
    raise AssertionError("network access attempted")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    ATTEMPTS.clear()
    for name in ("connect", "connect_ex", "sendto"):
        monkeypatch.setattr(socket.socket, name, _blocked)
    monkeypatch.setattr(socket, "create_connection", _blocked)
    monkeypatch.setattr(socket, "getaddrinfo", _blocked)
    yield
    assert ATTEMPTS == [] or ATTEMPTS == [("guard-self-test",)] * len(ATTEMPTS), f"outbound attempts: {ATTEMPTS}"


def load():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def triage(report=None):
    return it.triage(report or load(), it.connector_evidence(it.DEFAULT_FETCHERS))


def test_network_guard_catches_attempt_without_real_request():
    # The patched methods are the guard itself, so the attempt is refused before any socket I/O or DNS lookup.
    assert socket.socket.connect is _blocked and socket.create_connection is _blocked and socket.getaddrinfo is _blocked
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        with pytest.raises(AssertionError, match="network access attempted"):
            s.connect(("guard-self-test",))
    with pytest.raises(AssertionError, match="network access attempted"):
        socket.create_connection(("guard-self-test",))
    assert ATTEMPTS == [(("guard-self-test",),), (("guard-self-test",),)]
    ATTEMPTS[:] = [("guard-self-test",)] * 2  # expected self-test attempts; teardown rejects any other


def test_full_cli_run_makes_no_network_attempt(tmp_path):
    assert it.main(["--report", str(FIXTURE), "--out-dir", str(tmp_path)]) == 0
    assert ATTEMPTS == []


def test_module_imports_no_network_libs():
    tree = ast.parse(Path(it.__file__).read_text(encoding="utf-8"))
    imported = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    imported |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert not imported & {"socket", "http", "httpx", "requests", "aiohttp", "urllib3", "ssl"}
    assert "urllib.request" not in Path(it.__file__).read_text(encoding="utf-8")


def test_every_row_in_exactly_one_bucket():
    t = triage()
    rec = t["reconciliation"]
    assert rec["input_rows"] == rec["bucketed_rows"] == rec["declared_input_rows"] == 15
    assert {b: n for b, n in rec["by_bucket"].items() if n} == {
        "website_only": 5, "merged_duplicate": 1, "missing_url": 1, "unsupported_ats": 2, "connector_candidate": 1,
        "ambiguous": 1, "missing_company": 1, "unrecognized_status": 1, "invalid_url": 1, "ats_incomplete": 1}
    rows = [n for b in t["buckets"].values() for n in b["source_rows"]]
    assert sorted(rows) == list(range(2, 17))
    assert [r["source_row"] for r in t["rows"]] == list(range(2, 17))


def test_references_do_not_double_count_and_merges_stay_separate():
    t = triage()
    refs = t["references"]
    assert refs["proven_merges"] == [{"retained_row": 2, "merged_rows": [3]}]
    assert next(r for r in t["rows"] if r["source_row"] == 3)["merged_into_row"] == 2
    assert [(g["label"], g["kind"], g["source_rows"]) for g in refs["possible_duplicates"]] == [
        ('same_ats_board:lever:{"token": "zeta"}', "same_ats_board", [8, 9]), ("similar_name:gamma", "similar_name", [5, 16])]
    assert all(g["id"].startswith(f"rg-{g['kind']}-") for g in refs["possible_duplicates"])
    assert refs["ambiguous"] == [{"source_row": 9, "source_lines": [9, 9], "bucket": "ambiguous",
                                  "reason": "columns point at different ATS boards; see https://eta.example/x",
                                  "candidate_boards": ['ashby:{"token": "eta"}', 'lever:{"token": "zeta"}']}]
    assert t["reconciliation"]["bucketed_rows"] == 15  # references add no rows


def test_connector_groups_compare_against_real_fetchers():
    c = triage()["connectors"]
    assert {"fetch_greenhouse", "fetch_lever", "fetch_ashby", "fetch_smartrecruiters", "fetch_workday_cxs"} <= set(c["evidence"])
    assert "boards-api.greenhouse.io" in c["evidence"]["fetch_greenhouse"]["api_hosts"]
    unsupported = {g["vendor"]: g for g in c["unsupported_ats_groups"]}
    assert unsupported["workable"]["connector"] == "unsupported"
    assert unsupported["greenhouse"]["connector"] == "unresolved"
    assert "boards-api.greenhouse.io" in unsupported["greenhouse"]["reason"]
    assert unsupported["greenhouse"]["hosts"] == {"job-boards.eu.greenhouse.example": 1}
    assert [(g["vendor"], g["connector"]) for g in c["candidate_groups"]] == [("lever", "supported")]
    assert "unverified" in c["candidate_groups"][0]["reason"]
    assert [(g["vendor"], g["connector"]) for g in c["ats_incomplete_groups"]] == [("workday", "unresolved")]


def test_website_evidence_classes():
    w = triage()["website_evidence"]
    assert w["explicit_careers_path"]["source_rows"] == [2]
    assert w["homepage_like"]["source_rows"] == [4, 16]
    assert w["file"]["source_rows"] == [10]
    assert w["unknown"]["source_rows"] == [11]
    assert w["job_board_or_social"]["count"] == 0


@pytest.mark.parametrize("url,cls", [
    ("https://linkedin.com/company/x", "job_board_or_social"), ("https://in.linkedin.com/company/x", "job_board_or_social"),
    ("https://notlinkedin.com/careers", "explicit_careers_path"), ("https://careers.acme.example", "explicit_careers_path"),
    ("https://acme.example/en-us/join-us", "explicit_careers_path"), ("https://acme.example/careers.html", "explicit_careers_path"),
    ("https://acme.example/en", "homepage_like"), ("https://acme.example/index.html", "homepage_like"),
    ("https://acme.example/brochure.PDF", "file"), ("https://acme.example/blog/jobs-report-2026", "unknown"),
    ("not a url://", "unknown"), (None, "unknown"),
])
def test_website_evidence_unit(url, cls):
    assert it.website_evidence(url)[0] == cls


@pytest.mark.parametrize("url,expected", [
    ("HTTPS://WWW.Acme.Example.:443/Path/", ("acme.example", None, "/Path/")),
    ("http://acme.example:80", ("acme.example", None, "")),
    ("https://acme.example:8443/x", ("acme.example", 8443, "/x")),
    ("acme.example/careers", ("acme.example", None, "/careers")),
    ("https://acme.example:99999", None), ("ftp://acme.example", None), ("", None), (42, None),
])
def test_split_url_case_ports_trailing_dots(url, expected):
    assert it.split_url(url) == expected


def test_missing_urls_keep_names_and_only_present_hints():
    t = triage()
    gamma_id = next(g["id"] for g in t["references"]["possible_duplicates"] if g["label"] == "similar_name:gamma")
    assert t["missing_urls"] == [{
        "source_row": 5, "source_lines": [5, 7], "company": "Gamma.example Labs", "review_groups": [gamma_id],
        "hints": [{"kind": "name_contains_dot_token", "value": "Gamma.example", "note": "text in the name; not a verified domain"},
                  {"kind": "review_group_rows_with_urls", "value": [16], "note": "possible duplicates; not proof"}]}]
    assert next(r for r in t["rows"] if r["source_row"] == 5)["source_lines"] == [5, 7]


def test_outputs_redact_secrets_and_are_deterministic(tmp_path):
    a = it.run(FIXTURE, tmp_path / "a")
    it.run(FIXTURE, tmp_path / "b")
    for name in ("intake_triage.json", "intake_triage.md"):
        text = (tmp_path / "a" / name).read_text(encoding="utf-8")
        assert text == (tmp_path / "b" / name).read_text(encoding="utf-8")
        for secret in ("SECRET", "user:pass", "#frag", "utm_source", "?token", "api_key"):
            assert secret not in text
    assert "https://theta.example/files/deck.pdf" in (tmp_path / "a" / "intake_triage.json").read_text(encoding="utf-8")
    assert "15 input rows -> 15 bucketed rows" in (tmp_path / "a" / "intake_triage.md").read_text(encoding="utf-8")
    shuffled = load()
    random.Random(7).shuffle(shuffled["records"])
    b = it.triage(shuffled, it.connector_evidence(it.DEFAULT_FETCHERS))
    assert json.dumps(b, sort_keys=True) == json.dumps({k: v for k, v in a.items() if k != "input_sha256"}, sort_keys=True)


def test_minimal_records_without_optional_fields():
    t = triage({"records": [{"source_row": 2, "status": "website_only"}, {"source_row": 3}]})
    assert t["reconciliation"]["by_bucket"]["website_only"] == 1
    assert t["buckets"]["unrecognized_status"]["source_rows"] == [3]
    assert t["website_evidence"]["unknown"]["source_rows"] == [2]


def test_broken_merge_reference_kept_visible():
    rep = load()
    rep["records"][1]["merged_into_row"] = 999
    t = triage(rep)
    assert t["buckets"]["broken_merge_reference"]["source_rows"] == [3]
    assert t["reconciliation"]["bucketed_rows"] == 15


@pytest.mark.parametrize("mutate,msg", [
    (lambda r: r.pop("records"), "'records' list"),
    (lambda r: r["records"][0].pop("source_row"), "no integer source_row"),
    (lambda r: r["records"][0].update(source_row="2"), "no integer source_row"),
    (lambda r: r["records"][1].update(source_row=2), "appears twice"),
    (lambda r: r["records"].pop(), "declares 15 input rows but holds 14"),
])
def test_malformed_reports_fail_clearly(mutate, msg):
    rep = load()
    mutate(rep)
    with pytest.raises(it.TriageError, match=msg):
        triage(rep)


@pytest.mark.parametrize("buckets,msg", [
    ({"a": [2]}, r"dropped=\[3\]"),
    ({"a": [2, 3], "b": [3]}, r"double=\[3\]"),
    ({"a": [2, 3, 4]}, r"unknown=\[4\]"),
])
def test_partition_negative_controls(buckets, msg):
    with pytest.raises(it.TriageError, match=msg):
        it.check_partition([2, 3], buckets)


def test_cli_bad_input_exit_code(tmp_path, capsys):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    assert it.main(["--report", str(bad), "--out-dir", str(tmp_path / "o")]) == 2
    assert "not valid JSON" in capsys.readouterr().err
    assert it.main(["--report", str(FIXTURE), "--out-dir", str(tmp_path / "o"), "--fetchers", str(tmp_path / "none.py")]) == 2


def test_fixture_uses_reserved_example_hosts_only():
    for r in load()["records"]:
        parts = it.split_url(r["original_url"].replace("ftp://", "https://")) if r["original_url"] else None
        assert parts is None or parts[0].endswith(".example")


# ---- review checks -------------------------------------------------------------------------------

def test_possible_duplicate_url_is_only_a_referenced_hint():
    t = triage()
    row5 = next(r for r in t["rows"] if r["source_row"] == 5)
    assert (row5["bucket"], row5["merged_into_row"]) == ("missing_url", None)  # sibling URL changes neither
    entry = t["missing_urls"][0]
    assert entry["source_row"] == 5 and "url" not in entry
    hint = next(h for h in entry["hints"] if h["kind"] == "review_group_rows_with_urls")
    assert hint["value"] == [16] and "not proof" in hint["note"]   # a row reference, not the sibling's URL
    assert "gamma.example" not in json.dumps(entry).replace("Gamma.example", "")
    assert t["buckets"]["missing_url"]["samples"][0]["url"] is None
    assert all(5 not in g["source_rows"] for g in t["connectors"]["candidate_groups"])
    assert all(5 not in v["source_rows"] for v in t["website_evidence"].values())
    assert all(5 not in m["merged_rows"] and m["retained_row"] != 5 for m in t["references"]["proven_merges"])
    # Same holds when the sibling is a clean connector candidate in the same review group.
    rep = load()
    rep["review_groups"][1]["source_rows"] = [5, 8]
    t2 = triage(rep)
    assert next(r for r in t2["rows"] if r["source_row"] == 5)["bucket"] == "missing_url"
    assert [g["source_rows"] for g in t2["connectors"]["candidate_groups"]] == [[8]]


def test_connector_parsing_with_no_connectors_fails_clearly(tmp_path):
    empty = tmp_path / "fetchers.py"
    empty.write_text("def helper():\n    return 'https://api.example'\n", encoding="utf-8")
    with pytest.raises(it.TriageError, match=r"no fetch_\* connector functions found"):
        it.connector_evidence(empty)
    broken = tmp_path / "broken.py"
    broken.write_text("def fetch_x(:\n", encoding="utf-8")
    with pytest.raises(it.TriageError, match="cannot read connector code"):
        it.connector_evidence(broken)


def test_workday_and_workable_never_confused(tmp_path):
    src = tmp_path / "fetchers.py"
    src.write_text("async def fetch_workday_cxs(c, l, seed):\n    return f'https://{seed}.wd5.myworkdayjobs.com'\n", encoding="utf-8")
    conns = it.connector_evidence(src)
    assert [c["function"] for c in it.find_connectors(conns, "workday")] == ["fetch_workday_cxs"]
    assert it.find_connectors(conns, "workable") == [] and it.find_connectors(conns, "work") == []
    rep = load()
    rep["records"][13]["status"] = "unsupported_ats"   # row 15: workday URL the intake could not use
    groups = {g["vendor"]: g for g in it.triage(rep, conns)["connectors"]["unsupported_ats_groups"]}
    assert groups["workable"]["connector"] == "unsupported" and "fetch_workable" in groups["workable"]["reason"]
    assert groups["workday"]["connector"] == "unresolved" and "fetch_workday_cxs" in groups["workday"]["reason"]
    assert groups["greenhouse"]["connector"] == "unsupported"  # no greenhouse fetcher in this source


def test_eu_greenhouse_stays_unresolved_even_with_greenhouse_connector():
    groups = {g["vendor"]: g for g in triage()["connectors"]["unsupported_ats_groups"]}
    assert groups["greenhouse"]["connector"] == "unresolved"
    assert groups["greenhouse"]["source_rows"] == [7]
    assert all(7 not in g["source_rows"] for g in triage()["connectors"]["candidate_groups"])


SECRETS = ("SECRET", "hunter2", "sess=", "sig=", "#frag", "utm_", "api_key", "user:pass", "?")


def _poisoned():
    rep = load()
    r = rep["records"]
    r[0]["company"] = "Acme https://acme.example/x?sig=SECRETa"
    r[1]["company"] = "Acme https://acme.example/x?sig=SECRETa"
    r[2]["reason"] = "see beta.example/p?sess=SECRETb#frag"
    r[4]["ats_candidate"] = "workable"
    r[4]["original_url"] = r[4]["normalized_url"] = "https://admin:hunter2@apply.workable.example/d?api_key=SECRETc"
    r[11]["status"] = "odd https://kappa.example/?utm_source=SECRETd"
    r[7]["candidate_boards"] = ['ashby:{"token": "eta?x=SECRETe"}', 'lever:{"token": "zeta"}']
    rep["review_groups"][0]["group"] = "similar_name:gamma https://g.example/?SECRETf"
    rep["review_groups"][0]["urls"] = ["https://user:pass@gamma.example/a?SECRETg#frag"]
    return rep


def test_redaction_covers_every_output_and_error(tmp_path, capsys):
    p = tmp_path / "poisoned.json"
    p.write_text(json.dumps(_poisoned()), encoding="utf-8")
    assert it.main(["--report", str(p), "--out-dir", str(tmp_path / "o")]) == 0
    outputs = [(tmp_path / "o" / n).read_text(encoding="utf-8") for n in ("intake_triage.json", "intake_triage.md")]
    outputs.append(capsys.readouterr().out)
    bad = _poisoned()
    bad["records"][3]["source_row"] = "https://x.example/?SECRETh"   # error path
    p.write_text(json.dumps(bad), encoding="utf-8")
    assert it.main(["--report", str(p), "--out-dir", str(tmp_path / "o2")]) == 2
    outputs.append(capsys.readouterr().err)
    for text in outputs:
        for secret in SECRETS:
            assert secret not in text, (secret, text[:200])
    assert "https://acme.example/x" in outputs[0]   # redacted, not deleted


@pytest.mark.parametrize("raw,expected", [
    ("https://a.example/p?t=SECRET#f", "https://a.example/p"),
    ("see a.example/p?t=SECRET now", "see a.example/p now"), ('ashby:{"token": "eta?x=S"}', 'ashby:{"token": "eta"}'),
    ("mail jobs@a.example", "mail <redacted>"),
    ("ftp://u:p@a.example/x?y", "<unparseable>"),
    ("path segment /careers", "path segment /careers"),
    ('lever:{"token": "zeta"}', 'lever:{"token": "zeta"}'),
])
def test_redact_text_unit(raw, expected):
    assert it.redact_text(raw) == expected


def test_repeated_runs_identical_bytes(tmp_path):
    for d in ("a", "b", "c"):
        it.run(FIXTURE, tmp_path / d)
    for n in ("intake_triage.json", "intake_triage.md"):
        first = (tmp_path / "a" / n).read_bytes()
        assert first == (tmp_path / "b" / n).read_bytes() == (tmp_path / "c" / n).read_bytes()
        assert b"\r\n" not in first


@pytest.mark.parametrize("tamper,msg", [
    (lambda a: a["website_only"].pop(), "dropped="),
    (lambda a: a["ambiguous"].append(a["website_only"][0]), "double="),
])
def test_triage_reconciliation_rejects_dropped_or_double_counted_rows(monkeypatch, tamper, msg):
    real = it.check_partition

    def tampered(row_ids, buckets):
        tamper(buckets)
        return real(row_ids, buckets)
    monkeypatch.setattr(it, "check_partition", tampered)
    with pytest.raises(it.TriageError, match=msg):
        triage()


def test_markdown_structure_survives_redaction(tmp_path):
    it.run(FIXTURE, tmp_path)
    md = (tmp_path / "intake_triage.md").read_text(encoding="utf-8")
    assert md.startswith("# Company intake triage\n")
    assert "\n## Connector groups" in md and "\n## References" in md


# ---- review round 2 ------------------------------------------------------------------------------

def _two_groups_same_redacted_label():
    rep = load()
    rep["review_groups"] = [
        {"group": "dup https://x.example/?sig=SECRET1", "kind": "similar_name", "source_rows": [2, 4], "urls": []},
        {"group": "dup https://x.example/?sig=SECRET2", "kind": "similar_name", "source_rows": [10, 11], "urls": []},
        {"group": "dup https://x.example/?sig=SECRET3", "kind": "similar_name", "source_rows": [10, 11], "urls": []},
    ]
    return rep


def test_groups_with_same_redacted_label_stay_separate(tmp_path):
    labels = [g["group"] for g in _two_groups_same_redacted_label()["review_groups"]]
    assert len({it.redact_text(x) for x in labels}) == 1          # negative control: labels alone would collide
    t = triage(_two_groups_same_redacted_label())
    groups = t["references"]["possible_duplicates"]
    assert len(groups) == 3 and len({g["id"] for g in groups}) == 3  # identical rows too: suffixed, never combined
    assert sorted(g["source_rows"] for g in groups) == [[2, 4], [10, 11], [10, 11]]
    assert {g["label"] for g in groups} == {"dup https://x.example/"}
    p = tmp_path / "r.json"
    p.write_text(json.dumps(_two_groups_same_redacted_label()), encoding="utf-8")
    out = it.run(p, tmp_path / "o")
    assert len(out["references"]["possible_duplicates"]) == 3
    text = (tmp_path / "o" / "intake_triage.json").read_text(encoding="utf-8")
    assert "SECRET" not in text
    assert it.run(p, tmp_path / "o2")["references"] == out["references"]   # IDs stable across runs


def test_scrub_never_silently_combines_keys():
    assert it.scrub({"see a.example/p?t=1": 2, "see a.example/p?t=2": 3}) == {"see a.example/p": 5}  # counts summed
    with pytest.raises(it.TriageError, match="merge two distinct keys"):                              # negative control
        it.scrub({"g a.example/?s=1": [2], "g a.example/?s=2": [3]})


@pytest.mark.parametrize("name", ["C# Labs", "What? Inc", "F# Software", "Yes! & Why? Co", "AT&T #1 Partner", "## Heading"])
def test_ordinary_names_with_question_or_hash_survive(name):
    assert it.redact_text(name) == name


@pytest.mark.parametrize("raw,expected", [
    ("see beta.example/p?sess=SECRETb#frag", "see beta.example/p"),          # scheme-less URL
    ("acme.example?token=SECRET", "acme.example"),
    ("eta?x=SECRETe", "eta"),                                                # query-like tail
    ("C#?api_key=SECRET", "C"),
    ("https://u:SECRET@acme.example/p?q=1#f", "https://acme.example/p"),
    ("login admin:SECRET@acme.example", "login <redacted>"),
    ("What? Inc https://w.example/?sig=SECRET", "What? Inc https://w.example/"),
])
def test_secrets_still_removed_next_to_ordinary_text(raw, expected):
    assert it.redact_text(raw) == expected                                  # negative controls: secret-bearing input


def test_names_survive_in_written_reports_and_privacy_holds(tmp_path):
    rep = _poisoned()
    rep["records"][10]["company"] = "C# Labs"      # row 12 sample/name
    rep["records"][12]["company"] = "What? Inc"    # row 14
    p = tmp_path / "poisoned.json"
    p.write_text(json.dumps(rep), encoding="utf-8")
    it.run(p, tmp_path / "o")
    text = (tmp_path / "o" / "intake_triage.json").read_text(encoding="utf-8")
    assert '"C# Labs"' in text and '"What? Inc"' in text
    for secret in ("SECRET", "hunter2", "sess=", "sig=", "#frag", "utm_", "api_key", "user:pass"):
        assert secret not in text


def test_raw_input_kept_apart_from_sanitized_output(tmp_path):
    p = tmp_path / "report.json"
    p.write_bytes(FIXTURE.read_bytes())
    before = p.read_bytes()
    with pytest.raises(it.TriageError, match="must differ"):              # negative control: same directory refused
        it.run(p, tmp_path)
    assert sorted(x.name for x in tmp_path.iterdir()) == ["report.json"]
    rep = load()
    snapshot = json.dumps(rep, sort_keys=True)
    triage(rep)
    assert json.dumps(rep, sort_keys=True) == snapshot                    # raw report object not mutated
    it.run(p, tmp_path / "out")
    assert p.read_bytes() == before


@pytest.mark.parametrize("bad", [True, False, 2.0, "2", [2], {"row": 2}, 0, -1])
def test_invalid_merge_references_rejected(bad):
    rep = load()
    rep["records"].insert(0, {"source_row": 1, "status": "website_only", "normalized_url": "https://one.example"})
    rep["reconciliation"]["input_rows"] = 16
    rep["records"][2]["merged_into_row"] = bad                            # row 3
    t = triage(rep)
    assert t["buckets"]["broken_merge_reference"]["source_rows"] == [3]
    assert t["buckets"]["merged_duplicate"]["count"] == 0
    assert t["references"]["proven_merges"] == []
    assert next(r for r in t["rows"] if r["source_row"] == 3)["merged_into_row"] is None


def test_true_is_not_row_one_negative_control():
    assert True in {1: "row 1"}                    # the hazard: bool hashes and compares equal to 1
    assert not it._is_row(True) and not it._is_row(False) and it._is_row(1)
    rep = load()
    rep["records"].insert(0, {"source_row": 1, "status": "website_only"})
    rep["reconciliation"]["input_rows"] = 16
    rep["records"][2]["merged_into_row"] = 1      # a real integer reference still merges
    assert triage(rep)["references"]["proven_merges"][0] == {"retained_row": 1, "merged_rows": [3]}


def test_bool_row_refs_in_review_groups_are_not_rows():
    rep = load()
    rep["review_groups"][0]["source_rows"] = [5, 16, True, "7"]
    g = next(g for g in triage(rep)["references"]["possible_duplicates"] if g["label"] == "similar_name:gamma")
    assert g["source_rows"] == [5, 16] and g["invalid_row_refs"] == 2


# ---- field-aware redaction: ?/# token tails and ;path-parameters ---------------------------------------------------

CANARY = "CANARY"  # every planted value contains it; matched case-insensitively (group IDs are lower-cased)


def _canaried():
    """One synthetic canary per affected field and URL form (all hosts .example)."""
    rep = load()
    r = rep["records"]
    r[0]["company"] = "Acme a#CANARYco1"                                    # bare # tail in a name
    r[2]["company"] = "Beta abc?CANARYco2"                                  # bare ? tail in a name
    r[2]["reason"] = ("see https://beta.example/p;jsessionid=CANARYr1?q=1 and beta.example/q;sid=CANARYr2 "
                      "tok?CANARYr3 and https://beta.example/a;x=CANARYr4/b;y=CANARYr5/c")
    r[4]["ats_candidate"] = "workable#CANARYats"                            # vendor key and group label
    r[4]["normalized_url"] = "https://apply.workable.example/d;x=CANARYnu1/e;y=CANARYnu2?q=1#f"
    r[12]["original_url"] = "https://mu.example/m;jsessionid=CANARYou?x=1"  # normalized_url empty -> original used
    r[12]["normalized_url"] = ""
    r[11]["status"] = "odd?CANARYst"                                        # unrecognized status, echoed in reason
    r[7]["candidate_boards"] = ['ashby:{"token": "eta#CANARYcb1"}', "boards.example/b;sid=CANARYcb2",
                                "https://x.example/c;s=CANARYcb3?q=1"]
    r[7]["reason"] = "conflict abc?CANARYr6"
    g = rep["review_groups"][0]
    g["group"] = "similar_name:gamma?CANARYgl"
    g["kind"] = "similar_name#CANARYgk"                                    # kind feeds the group ID
    g["urls"] = ["https://gamma.example/a;jsessionid=CANARYgu1?q=1", "https://gamma.example/b;x=CANARYgu2"]
    return rep


def _written(tmp_path, rep, sub="o"):
    p = tmp_path / f"{sub}.json"
    p.write_text(json.dumps(rep), encoding="utf-8")
    it.run(p, tmp_path / sub)
    return [(tmp_path / sub / n).read_text(encoding="utf-8") for n in ("intake_triage.json", "intake_triage.md")]


def test_no_canary_survives_in_json_or_markdown(tmp_path):
    for text in _written(tmp_path, _canaried()):
        assert CANARY.lower() not in text.lower(), text[text.lower().find("canary") - 80:][:200]
    js = _written(tmp_path, _canaried(), "again")[0]
    # Redacted, not deleted: the URL and the field values are still there in display form.
    for kept in ("https://beta.example/p", "beta.example/q", "https://beta.example/a/b/c", "https://apply.workable.example/d/e",
                 "https://mu.example/m", "https://gamma.example/a", "https://gamma.example/b", '"Acme a"', '"Beta abc"',
                 '"vendor": "workable"', "boards.example/b", "https://x.example/c", "conflict abc", "status 'odd' not known"):
        assert kept in js, kept


def test_canary_output_is_deterministic(tmp_path):
    a = _written(tmp_path, _canaried(), "a")
    b = _written(tmp_path, _canaried(), "b")
    assert a == b
    shuffled = _canaried()
    random.Random(11).shuffle(shuffled["records"])
    drop_sha = lambda s: {k: v for k, v in json.loads(s).items() if k != "input_sha256"}  # noqa: E731
    assert drop_sha(_written(tmp_path, shuffled, "c")[0]) == drop_sha(a[0])               # input order does not matter


@pytest.mark.parametrize("raw,expected", [
    ("abc?CANARY", "abc"), ("a#CANARY", "a"), ("?CANARY", ""), ("C#Labs", "C"),     # text on both sides / leading ?
    ("C# Labs", "C# Labs"), ("F# Corp", "F# Corp"), ("What? Inc", "What? Inc"),       # delimiter ends the token
    ("Why?! Co", "Why?! Co"), ("AT&T #1 Partner", "AT&T #1 Partner"), ("## Heading", "## Heading"),  # punctuation / leading #
    ("calls boards-api.greenhouse.io; observed", "calls boards-api.greenhouse.io; observed"),       # sentence ";" kept
    ("x b.example/q;sid=CANARY y", "x b.example/q y"), ("c.example;sid=CANARY", "c.example"),
    ("https://u:p@a.example/a;x=C1/b;y=C2/c?q=1#f", "https://a.example/a/b/c"),
])
def test_token_boundary_is_explicit(raw, expected):
    assert it.redact_text(raw) == expected


@pytest.mark.parametrize("url,expected", [
    ("https://a.example/p;jsessionid=CANARY", "https://a.example/p"),
    ("https://a.example/p;jsessionid=CANARY?q=1#f", "https://a.example/p"),
    ("https://user:pw@a.example/a;x=CANARY/b;y=CANARY/c", "https://a.example/a/b/c"),
    ("https://a.example/careers/", "https://a.example/careers/"),
])
def test_redact_url_drops_path_params_on_every_segment(url, expected):
    assert it.redact_url(url) == expected


def test_names_with_hash_or_question_survive_next_to_canaries(tmp_path):
    rep = _canaried()
    rep["records"][10]["company"] = "C# Labs"
    rep["records"][13]["company"] = "F# Corp"
    rep["records"][14]["company"] = "What? Inc"
    js, md = _written(tmp_path, rep)
    assert '"C# Labs"' in js and '"F# Corp"' in js and '"What? Inc"' in js
    assert CANARY.lower() not in (js + md).lower()


def test_group_ids_stay_distinct_when_kinds_redact_alike(tmp_path):
    rep = _canaried()
    rep["review_groups"].append({**rep["review_groups"][0], "group": "other?CANARYx", "kind": "similar_name#CANARYgk2"})
    ids = [g["id"] for g in it.triage(rep, it.connector_evidence(it.DEFAULT_FETCHERS))["references"]["possible_duplicates"]
           if g["kind"] == "similar_name"]
    assert len(ids) == 2 and len(set(ids)) == 2 and ids[1] == f"{ids[0]}-2"          # existing collision suffix
    assert all(CANARY.lower() not in i for i in ids)


def _base_strip_query_tail(m):  # the a5e4c76b rule, kept only as an in-memory negative control
    tok = m.group(0)
    i = min((tok.find(c) for c in "?#" if c in tok), default=-1)
    if i < 0:
        return tok
    head, tail = tok[:i], tok[i:]
    return head if ("." in head or "/" in head or "=" in tail) else tok


@pytest.mark.parametrize("disable,survivors", [
    ("token_tail", ("canaryco1", "canaryco2", "canaryr3", "canaryr6", "canaryst", "canaryats", "canarycb1", "canarygl", "canarygk")),
    ("path_params", ("canaryr1", "canaryr2", "canaryr4", "canarynu1", "canaryou", "canarycb2", "canarycb3", "canarygu1", "canarygu2")),
])
def test_negative_controls_each_fix_is_load_bearing(tmp_path, monkeypatch, disable, survivors):
    src = Path(it.__file__).read_bytes()
    if disable == "token_tail":
        monkeypatch.setattr(it, "_strip_query_tail", _base_strip_query_tail)
    else:
        monkeypatch.setattr(it, "_PATH_PARAMS", it.re.compile(r"(?!)"))      # never matches
    text = "\n".join(_written(tmp_path, _canaried())).lower()
    leaked = [c for c in survivors if c in text]
    assert leaked == list(survivors), leaked                                  # every planted value of that kind leaks
    assert Path(it.__file__).read_bytes() == src                              # in-memory only; source bytes untouched
