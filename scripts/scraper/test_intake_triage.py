import ast
import json
import random
import socket
from pathlib import Path

import pytest

from scripts.scraper import intake_triage as it

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "intake_triage_report.example.json"


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*a, **k):
        raise AssertionError("network access attempted")
    for name in ("connect", "connect_ex", "sendto"):
        monkeypatch.setattr(socket.socket, name, blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)
    monkeypatch.setattr(socket, "getaddrinfo", blocked)


def load():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def triage(report=None):
    return it.triage(report or load(), it.connector_evidence(it.DEFAULT_FETCHERS))


def test_network_guard_is_active_and_module_imports_no_network_libs():
    with pytest.raises(AssertionError, match="network"):
        socket.create_connection(("triage.example", 443))
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
    assert [g["group"] for g in refs["possible_duplicates"]] == ['same_ats_board:lever:{"token": "zeta"}', "similar_name:gamma"]
    assert refs["ambiguous"] == [{"source_row": 9, "source_lines": [9, 9], "bucket": "ambiguous",
                                  "reason": "columns point at different ATS boards; see https://eta.example/x",
                                  "candidate_boards": ['ashby:{"token": "eta"}', 'lever:{"token": "zeta"}']}]
    assert t["reconciliation"]["bucketed_rows"] == 15  # references add no rows


def test_connector_groups_compare_against_real_fetchers():
    c = triage()["connectors"]
    assert {"greenhouse", "lever", "ashby", "smartrecruiters", "workday"} <= set(c["evidence"])
    assert "boards-api.greenhouse.io" in c["evidence"]["greenhouse"]["api_hosts"]
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
    assert t["missing_urls"] == [{
        "source_row": 5, "source_lines": [5, 7], "company": "Gamma.example Labs", "review_groups": ["similar_name:gamma"],
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
