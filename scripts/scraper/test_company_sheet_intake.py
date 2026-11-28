import json
import textwrap

import pytest

from scripts.scraper import company_sheet_intake as csi

MAP = {"company": "Company", "website": "Scraping Website", "careers": None}


def write(tmp_path, body):
    p = tmp_path / "in.csv"
    p.write_text(textwrap.dedent(body).lstrip(), encoding="utf-8", newline="")
    return p


def run(tmp_path, body, mapping=MAP):
    return csi.run(write(tmp_path, body), mapping, tmp_path / "out")


def by_row(report):
    return {r["source_row"]: r for r in report["records"]}


def test_every_row_preserved_with_row_numbers_and_reports_written(tmp_path):
    rep = run(tmp_path, """
        Company,Scraping Website
        Stripe,https://boards.greenhouse.io/stripe?utm_source=x
        Blank Co,
        ,https://nameless.com
        Bad Co,ftp://bad
        Plain,www.plain.com/careers/
        """)
    rows = by_row(rep)
    assert sorted(rows) == [2, 3, 4, 5, 6]
    assert rows[2]["status"] == "ats_candidate" and rows[2]["identifiers"] == {"token": "stripe"}
    assert rows[3]["status"] == "blank"
    assert rows[4]["status"] == "blank_company"
    assert rows[5]["status"] == "invalid_url"
    assert (rows[6]["status"], rows[6]["normalized_url"]) == ("website_only", "https://plain.com/careers")
    assert rep["reconciliation"]["input_rows"] == rep["reconciliation"]["output_records"] == 5
    out = tmp_path / "out"
    assert len((out / "intake_records.csv").read_text(encoding="utf-8").strip().splitlines()) == 6
    assert json.loads((out / "intake_report.json").read_text(encoding="utf-8"))["reconciliation"]["input_rows"] == 5


@pytest.mark.parametrize("mapping,msg", [
    ({"company": "Company", "website": None, "careers": None}, "at least one"),
    ({"company": None, "website": "Scraping Website", "careers": None}, "company-col is required"),
    ({"company": "Company", "website": "Scraping Website", "careers": "Careers"}, "not in CSV"),
    ({"company": "Company", "website": "Company", "careers": None}, "two roles"),
])
def test_invalid_mapping_fails_clearly(tmp_path, mapping, msg):
    with pytest.raises(csi.MappingError, match=msg) as e:
        run(tmp_path, "Company,Scraping Website\nA,https://a.com\n", mapping)
    if "not in CSV" in msg:
        assert "Headers found" in str(e.value)


def test_duplicate_headers_rejected(tmp_path):
    with pytest.raises(csi.MappingError, match="duplicate headers"):
        run(tmp_path, "Company,Company,Scraping Website\nA,B,https://a.com\n")


def test_cli_exit_code_on_bad_mapping(tmp_path, capsys):
    p = write(tmp_path, "Company,Scraping Website\nA,https://a.com\n")
    assert csi.main(["--csv", str(p), "--out-dir", str(tmp_path / "o"), "--company-col", "Name", "--website-col", "Scraping Website"]) == 2
    assert "Headers found" in capsys.readouterr().err


def test_careers_column_preferred_and_conflicting_boards_ambiguous(tmp_path):
    m = {"company": "Company", "website": "Website", "careers": "Careers"}
    rep = run(tmp_path, """
        Company,Website,Careers
        Acme,https://acme.com,https://jobs.lever.co/acme
        Both,https://jobs.ashbyhq.com/both,https://jobs.lever.co/both
        """, m)
    rows = by_row(rep)
    assert (rows[2]["ats_candidate"], rows[2]["url_column"]) == ("lever", "Careers")
    assert rows[2]["all_urls"] == {"Careers": "https://jobs.lever.co/acme", "Website": "https://acme.com"}
    assert rows[3]["status"] == "ambiguous"


def test_short_row_flagged_not_dropped(tmp_path):
    rep = run(tmp_path, "Company,Scraping Website,Notes\nShort,https://short.com\n")
    assert by_row(rep)[2]["status"] == "invalid_url" and "2 cells" in by_row(rep)[2]["reason"]


def test_only_proven_identical_rows_merge(tmp_path):
    rep = run(tmp_path, """
        Company,Scraping Website
        Aeva,https://aeva.com/
        Aeva,https://www.aeva.com?utm_source=sheet
        Notion,https://jobs.ashbyhq.com/notion
        notion,https://jobs.ashbyhq.com/notion/abc
        Ten X,https://tenx.com
        Ten X,https://tenx.com/careers
        Ghost,
        Ghost,
        Alpha,https://shared.com
        Beta,https://shared.com
        Gamma,https://jobs.ashbyhq.com/gamma
        Gamma Labs,https://jobs.ashbyhq.com/gamma
        """)
    rows = by_row(rep)
    assert rows[3]["merged_into_row"] == 2          # same name, same normalized URL
    assert rows[5]["merged_into_row"] == 4          # case-only name diff, same ATS board
    for n in (6, 7, 8, 9, 10, 11, 12, 13):          # different URL, missing URL, shared domain, shared board
        assert rows[n]["merged_into_row"] is None
    aeva = next(c for c in rep["companies"] if c["company"] == "Aeva")
    assert aeva["source_rows"] == [2, 3] and aeva["urls"] == ["https://aeva.com/", "https://www.aeva.com?utm_source=sheet"]
    groups = {g["group"]: g["source_rows"] for g in rep["review_groups"]}
    assert groups["similar_name:tenx"] == [6, 7]
    assert groups["similar_name:ghost"] == [8, 9]
    assert groups["same_domain:shared.com"] == [10, 11]
    assert groups['same_ats_board:ashby:{"token": "gamma"}'] == [12, 13]
    rec = rep["reconciliation"]
    assert (rec["input_rows"], rec["merged_duplicate_rows"], rec["unique_companies_after_merge"]) == (12, 2, 10)


def test_conflicting_row_never_merges_or_becomes_clean_candidate(tmp_path):
    m = {"company": "Company", "website": "Website", "careers": "Careers"}
    rep = run(tmp_path, """
        Company,Website,Careers
        Acme,,https://jobs.lever.co/acme
        Acme,https://jobs.ashbyhq.com/acme,https://jobs.lever.co/acme
        Acme,,https://jobs.lever.co/acme/123
        """, m)
    rows = by_row(rep)
    assert rows[4]["merged_into_row"] == 2                      # clean identical rows still merge
    bad = rows[3]
    assert (bad["status"], bad["ats_candidate"], bad["identifiers"], bad["merged_into_row"]) == ("ambiguous", None, {}, None)
    assert bad["candidate_boards"] == ['ashby:{"token": "acme"}', 'lever:{"token": "acme"}']
    assert bad["all_urls"] == {"Careers": "https://jobs.lever.co/acme", "Website": "https://jobs.ashbyhq.com/acme"}
    assert 'same_ats_board:lever:{"token": "acme"}' in bad["review_groups"]
    assert "similar_name:acme" in bad["review_groups"]
    companies = {c["canonical_row"]: c for c in rep["companies"]}
    assert companies[2]["source_rows"] == [2, 4] and companies[2]["status"] == "ats_candidate"
    conflict = companies[3]
    assert (conflict["source_rows"], conflict["status"], conflict["ats_candidate"]) == ([3], "ambiguous", None)
    assert conflict["urls"] == ["https://jobs.ashbyhq.com/acme", "https://jobs.lever.co/acme"]
    assert "similar_name:acme" in conflict["review_groups"]
    assert rep["reconciliation"]["conflicting_ats_rows"] == 1
    assert "ambiguous" in (tmp_path / "out" / "intake_records.csv").read_text(encoding="utf-8")


def test_unclean_rows_never_merge_even_if_identical(tmp_path):
    rep = run(tmp_path, """
        Company,Scraping Website
        Bad,ftp://bad
        Bad,ftp://bad
        Half,https://acme.wd1.myworkdayjobs.com/fr/Careers
        Half,https://acme.wd1.myworkdayjobs.com/fr/Careers
        """)
    assert all(r["merged_into_row"] is None for r in rep["records"])


def test_multiline_cell_does_not_shift_logical_rows(tmp_path):
    body = 'Company,Scraping Website\n"Multi\nLine Co",https://multi.com\nNext,https://next.com\n"A\n\nB",\nLast,https://last.com\n'
    rep = run(tmp_path, body)
    rows = by_row(rep)
    assert sorted(rows) == [2, 3, 4, 5]
    assert (rows[2]["company"], rows[2]["source_lines"]) == ("Multi\nLine Co", [2, 3])
    assert (rows[3]["company"], rows[3]["source_lines"]) == ("Next", [4, 4])
    assert rows[4]["source_lines"] == [5, 7] and rows[4]["status"] == "blank"
    assert (rows[5]["company"], rows[5]["source_lines"]) == ("Last", [8, 8])
    assert rep["reconciliation"]["input_rows"] == rep["reconciliation"]["output_records"] == 4
