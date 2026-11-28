"""board_verify + seed_proposal. Offline only: every response is mocked; no fixture names a real company."""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import socket
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import httpx

from scripts.scraper import board_verify as bv
from scripts.scraper import seed_proposal as sp

FIX = Path(__file__).resolve().parent / "fixtures" / "board_verify"
SEEDS = {"layer1_public_ats": [{"slug": "synthetic-seeded", "name": "Synthetic Seeded", "ats": "greenhouse",
                                "token": "synthetic-seeded", "canonical_domain": "seeded.example", "category": "OTHER_STARTUPS"}]}
MAPPING = {"company": "Company", "website": "Website", "careers": "Careers"}
BOARD_URL = {"greenhouse": "https://boards.greenhouse.io/{}", "lever": "https://jobs.lever.co/{}",
             "ashby": "https://jobs.ashbyhq.com/{}", "smartrecruiters": "https://jobs.smartrecruiters.com/{}"}


def rec(row, company, ats, token, website="", url=None, **over):
    """A clean corrected-#882 candidate record whose URL derives exactly the claimed board."""
    url = url if url is not None else (BOARD_URL[ats].format(token) if ats in BOARD_URL else "")
    ids = {"token": token} if token is not None else {}
    r = {"source_row": row, "source_lines": [row, row], "company": company, "url_column": "Careers", "original_url": url,
         "normalized_url": url, "normalized_domain": None, "ats_candidate": ats, "identifiers": ids,
         "candidate_boards": [f"{ats}:{json.dumps(ids, sort_keys=True)}"], "status": "ats_candidate", "reason": "fixture",
         "all_urls": {"Careers": url, "Website": website}, "merged_into_row": None, "review_groups": []}
    r.update(over)
    return r


def intake(*records):
    return {"mapping": MAPPING, "records": list(records)}


_REAL_CONNECT = socket.socket.connect


def guarded_connect(attempts):
    """socket.connect that refuses anything but loopback (asyncio's own self-pipe on Windows) and records it."""
    def connect(self, address):
        host = address[0] if isinstance(address, tuple) else address
        if host not in ("127.0.0.1", "::1", "localhost"):
            attempts.append(address)
            raise AssertionError(f"network connect to {address!r}")
        return _REAL_CONNECT(self, address)
    return connect


def no_dns(attempts):
    def resolve(*a, **k):
        attempts.append(("dns", a))
        raise AssertionError("dns lookup")
    return resolve


def item(ats, token):
    return {"board_id": bv.board_id(ats, token), "ats": ats, "token": token, "url": bv.request_url(ats, token),
            "source_row": 2, "company": "Synthetic", "record_sha256": "0" * 64}


def run_verify(handler, items, evidence=bv.SYNTHETIC):
    sent: list[str] = []

    def counting(req):
        sent.append(str(req.url))
        return handler(req)

    async def go():
        async with httpx.AsyncClient(transport=httpx.MockTransport(counting)) as client:
            return await bv.verify_plan(client, items, evidence=evidence)
    return asyncio.run(go()), sent


def one(ats, handler, token="synthetic-board"):
    (res,), sent = run_verify(handler, [item(ats, token)])
    return res, sent


VALID = {  # one connector-usable posting per connector, in the connector's own response shape
    "greenhouse": {"jobs": [{"id": 1, "title": "T", "absolute_url": "https://boards.greenhouse.io/s/jobs/1"}]},
    "lever": [{"id": "a", "text": "T", "hostedUrl": "https://jobs.lever.co/s/a"}],
    "ashby": {"jobs": [{"id": "a", "title": "T", "jobUrl": "https://jobs.ashbyhq.com/s/a"}]},
    "smartrecruiters": {"content": [{"id": "1", "name": "T"}], "totalFound": 1},
}
EMPTY = {"greenhouse": {"jobs": []}, "lever": [], "ashby": {"jobs": []}, "smartrecruiters": {"content": [], "totalFound": 0}}
WRONG_SHAPE = {"greenhouse": [], "lever": {"postings": []}, "ashby": {"results": []}, "smartrecruiters": {"totalFound": 0}}
FIELDS = {"greenhouse": ("id", "title", "absolute_url"), "lever": ("id", "text", "hostedUrl"),
          "ashby": ("id", "title", "jobUrl"), "smartrecruiters": ("id", "name", None)}
BAD_IDS = [{"x": 1}, [1], True, 0, -3, 1.5, "", "   ", None]
BAD_TITLES = [["T"], {"t": "T"}, "", "  ", 7, None, "T\x00"]
BAD_URLS = ["javascript:alert(1)", "data:text/html,x", "http://jobs.example/1", "/relative/1", "https://",
            "https://user:pw@jobs.example/1", "https://jobs.example:8443/1", "https://jobs example/1", ["https://a.example"],
            {"u": 1}, "", "https://jobs.example/1\n", "https://127.0.0.1/1"]


def posting(ats, **over):
    base = (VALID[ats] if ats == "lever" else VALID[ats][bv.CONNECTORS[ats]["list_key"]])[0]
    p = dict(base)
    p.update(over)
    return p


class EndpointTests(unittest.TestCase):
    def test_urls_match_the_connectors(self):
        self.assertEqual(bv.request_url("greenhouse", "s"), "https://boards-api.greenhouse.io/v1/boards/s/jobs?content=true&pay_transparency=true")
        self.assertEqual(bv.request_url("lever", "s"), "https://api.lever.co/v0/postings/s?mode=json")
        self.assertEqual(bv.request_url("ashby", "s"), "https://api.ashbyhq.com/posting-api/job-board/s?includeCompensation=true")
        self.assertEqual(bv.request_url("smartrecruiters", "S"), "https://api.smartrecruiters.com/v1/companies/S/postings")

    def test_invalid_identifiers_rejected(self):
        for tok in ("", "bad/token", "a%2Fb", "a%zz", "-lead", "a b", "x" * 101, "../x", "a?b", "a#b", None, 5, "ünï", "a%25b"):
            with self.subTest(token=tok), self.assertRaises(ValueError):
                bv.request_url("greenhouse", tok)
        with self.assertRaises(ValueError):
            bv.request_url("workday", "synthetic")
        for ok in ("a.b_c-1", "a%20b", "a~b"):  # negative controls: #882 canonical tokens are accepted
            self.assertTrue(bv.request_url("greenhouse", ok))

    def test_non_approved_hosts_rejected(self):
        for url in ("http://boards-api.greenhouse.io/v1/boards/s/jobs", "https://boards-api.greenhouse.io.evil.example/x",
                    "https://evil.example/v1/boards/s/jobs", "https://boards-api.greenhouse.io:8443/x",
                    "https://user:pw@api.lever.co/v0/postings/s", "https://boards.greenhouse.io/s", None):
            with self.subTest(url=url), self.assertRaises(ValueError):
                bv.check_url(url)
        bv.check_url("https://api.lever.co/v0/postings/s?mode=json")  # negative control

    def test_derive_board_follows_882_url_rules(self):
        cases = {
            "https://boards.greenhouse.io/synthetic": ("greenhouse", "synthetic"),
            "job-boards.greenhouse.io/synthetic/jobs/1": ("greenhouse", "synthetic"),
            "https://boards.greenhouse.io/embed/job_board?for=synthetic": ("greenhouse", "synthetic"),
            "https://boards-api.greenhouse.io/v1/boards/synthetic/jobs": ("greenhouse", "synthetic"),
            "https://www.jobs.lever.co/synthetic/abc": ("lever", "synthetic"),
            "https://api.lever.co/v0/postings/synthetic": ("lever", "synthetic"),
            "https://jobs.ashbyhq.com/Synthetic%20Co": ("ashby", "Synthetic%20Co"),
            "https://api.ashbyhq.com/posting-api/job-board/synthetic": ("ashby", "synthetic"),
            "https://careers.smartrecruiters.com/SyntheticCo": ("smartrecruiters", "SyntheticCo"),
            "https://api.smartrecruiters.com/v1/companies/SyntheticCo/postings": ("smartrecruiters", "SyntheticCo"),
        }
        for url, want in cases.items():
            with self.subTest(url=url):
                self.assertEqual(bv.derive_board(url), want)
        for url in ("https://jobs.lever.co.evil.example/synthetic", "https://ashbyhq.com/careers", "https://jobs.ashbyhq.com/",
                    "https://jobs.lever.co/a%2Fb", "https://boards.eu.greenhouse.io/synthetic", "javascript:alert(1)",
                    "https://u:p@jobs.lever.co/synthetic", "https://synthetic.wd5.myworkdayjobs.com/External", "", None):
            with self.subTest(url=url):
                self.assertIsNone(bv.derive_board(url))


class ClassifyTests(unittest.TestCase):
    def test_valid_and_empty_per_connector(self):
        for ats in bv.CONNECTORS:
            with self.subTest(ats=ats):
                res, sent = one(ats, lambda r, a=ats: httpx.Response(200, json=VALID[a]))
                self.assertEqual((res["outcome"], res["board_exists"], res["usable_postings"]), (bv.VALID_WITH_JOBS, True, 1))
                self.assertEqual(sent, [bv.request_url(ats, "synthetic-board")])
                res, _ = one(ats, lambda r, a=ats: httpx.Response(200, json=EMPTY[a]))
                self.assertEqual((res["outcome"], res["board_exists"], res["usable_postings"]), (bv.VALID_EMPTY, None, 0))

    def test_unsafe_or_mistyped_posting_fields_never_usable(self):
        for ats, (id_k, title_k, url_k) in FIELDS.items():
            # Ashby's connector uses `id or jobUrl`, so a falsy id falls back to the (valid) jobUrl; checked below.
            ids = [v for v in BAD_IDS if v] if ats == "ashby" else BAD_IDS
            bad = [(id_k, v) for v in ids] + [(title_k, v) for v in BAD_TITLES] + ([(url_k, v) for v in BAD_URLS] if url_k else [])
            for key, value in bad:
                with self.subTest(ats=ats, field=key, value=value):
                    self.assertIsNotNone(bv.posting_problem(ats, posting(ats, **{key: value})))
            self.assertIsNone(bv.posting_problem(ats, posting(ats)), "negative control: the valid posting passes")
        # The connector falls back hostedUrl -> applyUrl and id -> jobUrl; the value it would use is what is checked.
        self.assertIsNone(bv.posting_problem("lever", {"id": "a", "text": "T", "applyUrl": "https://jobs.lever.co/s/a/apply"}))
        self.assertIsNotNone(bv.posting_problem("lever", {"id": "a", "text": "T", "hostedUrl": {"x": 1}, "applyUrl": "https://ok.example/a"}))
        self.assertIsNotNone(bv.posting_problem("ashby", {"title": "T", "jobUrl": "javascript:alert(1)"}))
        self.assertIsNone(bv.posting_problem("ashby", {"id": "", "title": "T", "jobUrl": "https://jobs.ashbyhq.com/s/a"}))
        self.assertIsNotNone(bv.posting_problem("ashby", {"id": "", "title": "T", "jobUrl": ""}), "no id and no url")
        self.assertIsNotNone(bv.posting_problem("smartrecruiters", {"id": "", "uuid": {"x": 1}, "name": "T"}))
        for ats in bv.CONNECTORS:
            with self.subTest(ats=ats, case="all unusable -> empty"):
                payload = [posting(ats, **{FIELDS[ats][0]: {"x": 1}})]
                body = payload if ats == "lever" else {bv.CONNECTORS[ats]["list_key"]: payload}
                res, _ = one(ats, lambda r, b=body: httpx.Response(200, json=b))
                self.assertEqual((res["outcome"], res["usable_postings"], res["raw_postings"]), (bv.VALID_EMPTY, 0, 1))
                self.assertTrue(res["unusable_reasons"])

    def test_malformed_json_and_wrong_shape(self):
        for ats in bv.CONNECTORS:
            with self.subTest(ats=ats):
                res, _ = one(ats, lambda r: httpx.Response(200, content=b"<html>"))
                self.assertEqual((res["outcome"], res["board_exists"]), (bv.MALFORMED, None))
                res, _ = one(ats, lambda r, a=ats: httpx.Response(200, json=WRONG_SHAPE[a]))
                self.assertEqual((res["outcome"], res["board_exists"]), (bv.MALFORMED, None), "a wrong shape is never empty")

    def test_status_codes_and_transport(self):
        cases = [(404, bv.NOT_FOUND, False), (429, bv.RATE_LIMITED, None), (500, bv.SERVER_ERROR, None),
                 (502, bv.SERVER_ERROR, None), (503, bv.SERVER_ERROR, None), (403, bv.HTTP_ERROR, None)]
        for status, outcome, exists in cases:
            with self.subTest(status=status):
                res, sent = one("ashby", lambda r, s=status: httpx.Response(s, headers={"Retry-After": "1"}))
                self.assertEqual((res["outcome"], res["board_exists"], res["http_status"]), (outcome, exists, status))
                self.assertEqual(len(sent), 1, "no retries")
        for exc in (httpx.ConnectError("x"), httpx.ReadTimeout("x")):
            with self.subTest(exc=type(exc).__name__):
                def boom(r, e=exc):
                    raise e
                res, _ = one("lever", boom)
                self.assertEqual((res["outcome"], res["board_exists"]), (bv.TRANSPORT_ERROR, None))

    def test_tampered_plan_entry_and_live_evidence_send_nothing(self):
        good = item("greenhouse", "synthetic-board")
        bad = [{**good, "url": "https://evil.example/x"}, {**good, "token": "../x"}, {**good, "ats": "workday"},
               {**good, "board_id": "greenhouse:other"}]
        results, sent = run_verify(lambda r: httpx.Response(200, json=VALID["greenhouse"]), bad)
        self.assertEqual(sent, [])
        self.assertEqual({r["outcome"] for r in results}, {bv.REJECTED})
        for label in ("live", "made-up"):
            with self.subTest(label=label):
                results, sent = run_verify(lambda r: httpx.Response(200, json=VALID["greenhouse"]), [good], evidence=label)
                self.assertEqual((sent, results[0]["outcome"]), ([], bv.REJECTED), "this build accepts no live evidence")


class CandidateTests(unittest.TestCase):
    def kinds(self, *recs, seeds=SEEDS):
        eligible, skipped = bv.select_candidates(intake(*recs), seeds)
        self.assertEqual(len(eligible) + len(skipped), len(recs), "exact row reconciliation")
        self.assertTrue(all("record" in s for s in skipped), "the original record is kept")
        return [e["source_row"] for e in eligible], {s["source_row"]: s["skip_kind"] for s in skipped}

    def test_eligibility_and_every_record_preserved(self):
        ok, kinds = self.kinds(
            rec(2, "Synthetic A", "greenhouse", "synthetic-a"),
            rec(3, "Synthetic B", "workday", None, url="https://b.wd5.myworkdayjobs.com/Ext",
                identifiers={"tenant": "b", "wd_cluster": "wd5", "site": "Ext"}),
            rec(4, "", "lever", "synthetic-c"),
            rec(5, "Synthetic D", "lever", "synthetic-d", status="ambiguous"),
            rec(6, "Synthetic E", "ashby", "bad%2Fe"),
            rec(7, "Synthetic F", "ashby", "synthetic-f", identifiers={"token": "synthetic-f", "extra": "1"}),
            rec(8, "Synthetic A", "greenhouse", "synthetic-a", merged_into_row=2),
            rec(9, "Synthetic G", "smartrecruiters", "SyntheticG", review_groups=["similar_name:x"]),
            rec(10, "Synthetic H", "lever", None),
            "not-a-record")
        self.assertEqual(ok, [2])
        self.assertEqual(kinds, {3: "out_of_scope_ats", 4: "missing_company", 5: "not_candidate", 6: "invalid_identifier",
                                 7: "invalid_identifier", 8: "merged_duplicate", 9: "conflict", 10: "invalid_identifier",
                                 None: "malformed_record"})

    def test_claimed_board_must_match_the_source_url(self):
        ok, kinds = self.kinds(
            # An Ashby URL with an unrelated (valid-looking) Lever token claimed.
            rec(2, "Synthetic A", "lever", "synthetic-lever", url="https://jobs.ashbyhq.com/synthetic-ashby"),
            # Right ATS, different token.
            rec(3, "Synthetic B", "ashby", "synthetic-claimed", url="https://jobs.ashbyhq.com/synthetic-real"),
            # Website URL claimed as a board.
            rec(4, "Synthetic C", "greenhouse", "synthetic-c", url="https://c.example/careers"),
            # Lookalike host.
            rec(5, "Synthetic D", "lever", "synthetic-d", url="https://jobs.lever.co.evil.example/synthetic-d"),
            # original_url not the value of url_column.
            rec(6, "Synthetic E", "lever", "synthetic-e", all_urls={"Careers": "https://jobs.lever.co/other", "Website": ""}),
            # Website column points at another board.
            rec(7, "Synthetic F", "lever", "synthetic-f", website="https://boards.greenhouse.io/synthetic-g"),
            # candidate_boards disagrees.
            rec(8, "Synthetic H", "lever", "synthetic-h", candidate_boards=['lever:{"token": "synthetic-x"}']),
            rec(9, "Synthetic I", "lever", "synthetic-i"))
        self.assertEqual(ok, [9], "negative control: a consistent record is still eligible")
        self.assertEqual(kinds, {2: "ats_token_mismatch", 3: "ats_token_mismatch", 4: "ats_token_mismatch",
                                 5: "ats_token_mismatch", 6: "url_mismatch", 7: "conflict", 8: "conflict"})

    def test_source_row_references(self):
        ok, kinds = self.kinds(
            rec(2, "Synthetic A", "lever", "synthetic-a"), rec(2, "Synthetic B", "lever", "synthetic-b"),
            rec(0, "Synthetic C", "lever", "synthetic-c"), rec("4", "Synthetic D", "lever", "synthetic-d"),
            rec(True, "Synthetic E", "lever", "synthetic-e"),
            rec(6, "Synthetic F", "lever", "synthetic-f", merged_into_row=99),
            rec(7, "Synthetic G", "lever", "synthetic-g", merged_into_row=7),
            rec(8, "Synthetic H", "lever", "synthetic-h"))
        self.assertEqual(ok, [8])
        self.assertEqual(sorted(kinds.items(), key=str), sorted({2: "conflict", 0: "invalid_source_row", "4": "invalid_source_row",
                                                                 True: "invalid_source_row", 6: "invalid_source_row",
                                                                 7: "invalid_source_row"}.items(), key=str))

    def test_duplicate_boards_and_already_seeded(self):
        ok, kinds = self.kinds(rec(2, "Synthetic A", "greenhouse", "synthetic-dup"), rec(3, "Synthetic B", "greenhouse", "Synthetic-Dup"),
                               rec(4, "Synthetic C", "greenhouse", "synthetic-seeded"), rec(5, "Synthetic D", "lever", "synthetic-dup"))
        self.assertEqual(ok, [5], "same token on another ATS is a different board")
        self.assertEqual(kinds, {2: "duplicate_board", 3: "duplicate_board", 4: "already_seeded"})

    def test_malformed_intake(self):
        for bad in ({}, [], {"records": "x"}, None):
            with self.subTest(bad=bad), self.assertRaises(bv.IntakeError):
                bv.select_candidates(bad, SEEDS)


def results_for(data, outcomes, **header):
    """A board_verify-shaped synthetic results file, bound to the intake's eligible records."""
    eligible, _ = bv.select_candidates(data, SEEDS)
    res = [{**{k: e[k] for k in bv.PLAN_FIELDS}, "outcome": outcomes[e["board_id"]], "evidence": bv.SYNTHETIC, "detail": "fixture"}
           for e in eligible if e["board_id"] in outcomes]
    return {"evidence": bv.SYNTHETIC, "test_only": True, **header, "results": res}


def meta(row, category="OTHER_STARTUPS", domain=None):
    return {"source_row": row, "category": category, "canonical_domain": domain, "provenance": "synthetic reviewer"}


def statuses(report):
    return {p["source_row"]: p["status"] for p in report["proposals"]}


ALL_STATUSES = {sp.TEST_ONLY, sp.UNRESOLVED, sp.NOT_QUALIFIED}


class ProposalTests(unittest.TestCase):
    def setUp(self):
        self.data = intake(rec(2, "Synthetic A", "greenhouse", "synthetic-a", "https://a.example"),
                           rec(3, "Synthetic B", "lever", "synthetic-b", "https://b.example"),
                           rec(4, "Synthetic C", "ashby", "synthetic-c", "https://c.example"),
                           rec(5, "Synthetic D", "smartrecruiters", "SyntheticD", "https://d.example"),
                           rec(6, "Synthetic E", "greenhouse", "synthetic-e", "https://e.example"))
        self.md = [meta(r) for r in (2, 3, 4, 5, 6)]

    def test_synthetic_evidence_is_test_only_and_production_is_always_empty(self):
        v = results_for(self.data, {"greenhouse:synthetic-a": bv.VALID_WITH_JOBS, "lever:synthetic-b": bv.VALID_EMPTY,
                                    "ashby:synthetic-c": bv.RATE_LIMITED, "smartrecruiters:SyntheticD": bv.NOT_FOUND})
        r = sp.propose(self.data, SEEDS, v, self.md)
        self.assertEqual(statuses(r), {2: sp.TEST_ONLY, 3: sp.NOT_QUALIFIED, 4: sp.NOT_QUALIFIED, 5: sp.NOT_QUALIFIED, 6: sp.NOT_QUALIFIED})
        self.assertEqual(r["production_proposals"], [])
        self.assertEqual(r["input_problems"]["verification"], [])

    def test_forged_live_labels_and_contradictory_test_only_flags_are_quarantined(self):
        good = results_for(self.data, {"greenhouse:synthetic-a": bv.VALID_WITH_JOBS})
        res0 = good["results"][0]
        forged = {
            "file says live": {**good, "evidence": "live"},
            "file says test_only false": {**good, "test_only": False},
            "file has no test_only": {k: v for k, v in good.items() if k != "test_only"},
            "file test_only is a string": {**good, "test_only": "true"},
            "result says live": {**good, "results": [{**res0, "evidence": "live"}]},
            "result test_only false": {**good, "results": [{**res0, "test_only": False}]},
            "result has no evidence": {**good, "results": [{k: v for k, v in res0.items() if k != "evidence"}]},
        }
        for name, v in forged.items():
            with self.subTest(name):
                r = sp.propose(self.data, SEEDS, v, self.md)
                self.assertEqual(r["production_proposals"], [])
                self.assertEqual(statuses(r)[2], sp.NOT_QUALIFIED, "a forged result is never used")
                self.assertTrue(any("quarantined" in q["problem"] for q in r["input_problems"]["verification"]))
                self.assertTrue(set(statuses(r).values()) <= ALL_STATUSES)
        self.assertEqual(statuses(sp.propose(self.data, SEEDS, good, self.md))[2], sp.TEST_ONLY, "negative control")

    def test_unbound_results_are_quarantined(self):
        good = results_for(self.data, {"greenhouse:synthetic-a": bv.VALID_WITH_JOBS})
        res0 = good["results"][0]
        for key, value in (("source_row", 3), ("record_sha256", "f" * 64), ("url", bv.request_url("lever", "synthetic-a")),
                           ("ats", "lever"), ("token", "synthetic-b"), ("company", "Synthetic Other")):
            with self.subTest(field=key):
                r = sp.propose(self.data, SEEDS, {**good, "results": [{**res0, key: value}]}, self.md)
                self.assertEqual(statuses(r)[2], sp.NOT_QUALIFIED)
                self.assertTrue(any("unbound" in q["problem"] for q in r["input_problems"]["verification"]))
        # A result planned from a different version of the same row (record edited after planning) is unbound.
        edited = intake(*[{**x, "reason": "edited after planning"} if x["source_row"] == 2 else x for x in self.data["records"]])
        r = sp.propose(edited, SEEDS, good, self.md)
        self.assertEqual(statuses(r)[2], sp.NOT_QUALIFIED)

    def test_cli_never_writes_production_even_from_forged_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "intake.json").write_text(json.dumps(self.data), encoding="utf-8")
            (d / "meta.json").write_text(json.dumps(self.md), encoding="utf-8")
            good = results_for(self.data, {"greenhouse:synthetic-a": bv.VALID_WITH_JOBS})
            forged = {**good, "evidence": "live", "test_only": False,
                      "results": [{**x, "evidence": "live"} for x in good["results"]]}
            for name, v in (("synthetic", good), ("forged", forged)):
                with self.subTest(name):
                    (d / "v.json").write_text(json.dumps(v), encoding="utf-8")
                    with redirect_stdout(io.StringIO()):
                        code = sp.main(["--intake", str(d / "intake.json"), "--verification", str(d / "v.json"),
                                        "--metadata", str(d / "meta.json"), "--out-dir", str(d / name)])
                    self.assertEqual(code, 0)
                    self.assertEqual(json.loads((d / name / "proposed_seeds.json").read_text(encoding="utf-8")), {"layer1_public_ats": []})
                    test = json.loads((d / name / "proposed_seeds.TEST_ONLY_SYNTHETIC.json").read_text(encoding="utf-8"))[sp.TEST_ONLY_KEY]
                    self.assertEqual([e["slug"] for e in test], ["synthetic-a"] if name == "synthetic" else [])

    def test_missing_fields_stay_unresolved(self):
        recs = [rec(2, "Synthetic A", "greenhouse", "synthetic-a", ""),
                rec(3, "Synthetic B", "greenhouse", "synthetic-b", "https://b.example"),
                rec(4, "株式会社", "greenhouse", "synthetic-c", "https://c.example"),
                rec(5, "Synthetic D", "greenhouse", "synthetic-d", "https://www.linkedin.com/company/x"),
                rec(6, "Synthetic E", "greenhouse", "synthetic-e", "https://e.example/about"),
                rec(7, "Synthetic F", "greenhouse", "synthetic-f", "https://jobs.f.example")]
        data = intake(*recs)
        v = results_for(data, {f"greenhouse:synthetic-{c}": bv.VALID_WITH_JOBS for c in "abcdef"})
        r = sp.propose(data, SEEDS, v, [meta(2), meta(4), meta(5), meta(6), meta(7)])
        by = {p["source_row"]: p for p in r["proposals"]}
        self.assertEqual(set(by[2]["unresolved"]), {"canonical_domain"})
        self.assertEqual(set(by[3]["unresolved"]), {"category"}, "no category without reviewer metadata")
        self.assertEqual(set(by[4]["unresolved"]), {"slug"})
        self.assertEqual(set(by[5]["unresolved"]), {"canonical_domain"}, "third-party profile host is not a company domain")
        self.assertEqual(by[6]["unresolved"], {}, "negative control: a plain company website resolves")
        self.assertEqual(set(by[7]["unresolved"]), {"canonical_domain"}, "subdomain: registrable domain unknown")
        self.assertEqual(statuses(r)[6], sp.TEST_ONLY)
        self.assertIsNone(by[3]["seed"]["category"], "unresolved stays null, never guessed")

    def test_slug_collisions(self):
        data = intake(rec(2, "Synthetic Nu", "greenhouse", "synthetic-nu-1", "https://nu1.example"),
                      rec(3, "synthetic-nu!", "lever", "synthetic-nu-2", "https://nu2.example"),
                      rec(4, "Synthetic Seeded", "ashby", "synthetic-other", "https://other.example"),
                      rec(5, "Synthetic Xi", "ashby", "synthetic-xi", "https://xi.example"))
        v = results_for(data, {b: bv.VALID_WITH_JOBS for b in ("greenhouse:synthetic-nu-1", "lever:synthetic-nu-2",
                                                               "ashby:synthetic-other", "ashby:synthetic-xi")})
        r = sp.propose(data, SEEDS, v, [meta(n) for n in (2, 3, 4, 5)])
        by = {p["source_row"]: p for p in r["proposals"]}
        self.assertTrue(any("slug collision" in c for c in by[2]["conflicts"]))
        self.assertTrue(any("slug collision" in c for c in by[3]["conflicts"]))
        self.assertTrue(any("already used by seed board greenhouse:synthetic-seeded" in c for c in by[4]["conflicts"]))
        self.assertEqual(by[5]["conflicts"], [], "negative control")
        self.assertEqual(statuses(r), {2: sp.UNRESOLVED, 3: sp.UNRESOLVED, 4: sp.UNRESOLVED, 5: sp.TEST_ONLY})

    def test_shared_domain_different_companies_not_merged(self):
        data = intake(rec(2, "Synthetic Omicron", "greenhouse", "synthetic-o", "https://shared.example"),
                      rec(3, "Synthetic Pi", "lever", "synthetic-p", "https://www.shared.example/about"),
                      rec(4, "Synthetic Rho", "ashby", "synthetic-r", "https://rho.example"))
        v = results_for(data, {b: bv.VALID_WITH_JOBS for b in ("greenhouse:synthetic-o", "lever:synthetic-p", "ashby:synthetic-r")})
        r = sp.propose(data, SEEDS, v, [meta(n) for n in (2, 3, 4)])
        self.assertEqual(len(r["proposals"]), 3, "two companies on one domain stay two proposals")
        by = {p["source_row"]: p for p in r["proposals"]}
        for row in (2, 3):
            self.assertEqual(by[row]["seed"]["canonical_domain"], "shared.example")
            self.assertTrue(any("shared domain" in c for c in by[row]["conflicts"]))
        self.assertEqual(by[4]["conflicts"], [])

    def test_conflicting_input(self):
        v = results_for(self.data, {b: bv.VALID_WITH_JOBS for b in ("greenhouse:synthetic-a", "lever:synthetic-b",
                                                                    "ashby:synthetic-c", "smartrecruiters:SyntheticD")})
        dup = next(x for x in v["results"] if x["board_id"] == "ashby:synthetic-c")
        v["results"] += [{**dup, "outcome": bv.RATE_LIMITED}, {**dup, "board_id": "lever:synthetic-unknown"}]
        md = [meta(2, domain="other-a.example"), meta(3), meta(3, category="MNC_BIGTECH"), meta(5, category="NOT_A_CATEGORY"),
              meta(99), {"category": "OTHER_STARTUPS"}, meta(4)]
        r = sp.propose(self.data, SEEDS, v, md)
        by = {p["source_row"]: p for p in r["proposals"]}
        self.assertTrue(any("sheet website says a.example, metadata says other-a.example" in c for c in by[2]["conflicts"]))
        self.assertTrue(any("conflicting reviewer metadata" in c for c in by[3]["conflicts"]))
        self.assertTrue(any("more than one verification result" in c for c in by[4]["conflicts"]))
        self.assertTrue(any("NOT_A_CATEGORY" in c for c in by[5]["conflicts"]))
        self.assertEqual({k: s for k, s in statuses(r).items() if k != 6}, {2: sp.UNRESOLVED, 3: sp.UNRESOLVED, 4: sp.UNRESOLVED, 5: sp.UNRESOLVED})
        self.assertEqual(len(r["input_problems"]["metadata"]), 3, "unknown row, missing row and conflicting duplicate kept")
        self.assertEqual(len(r["input_problems"]["verification"]), 2, "unknown board and duplicate result kept")


class CliTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name)

    def quiet(self, fn, argv):
        with redirect_stdout(io.StringIO()):
            return fn(argv)

    def test_network_guard_negative_control(self):
        attempts: list = []

        async def go():
            async with httpx.AsyncClient() as client:  # a real transport: the guard must stop it
                await client.get("https://guard-check.invalid/")
        with patch.object(socket.socket, "connect", guarded_connect(attempts)), patch.object(socket, "getaddrinfo", no_dns(attempts)):
            with self.assertRaises(Exception):
                asyncio.run(go())
        self.assertTrue(attempts, "the guard records a real network attempt")

    def test_default_mode_makes_zero_requests(self):
        attempts: list = []

        async def no_send(*a, **k):
            attempts.append("httpx")
            raise AssertionError("network used")
        with patch.object(socket.socket, "connect", guarded_connect(attempts)), patch.object(httpx.AsyncClient, "send", no_send), \
                patch.object(socket, "getaddrinfo", no_dns(attempts)):
            code = self.quiet(bv.main, ["--intake", str(FIX / "intake_report.sample.json"), "--out-dir", str(self.out)])
        self.assertEqual((code, attempts), (0, []))
        plan = json.loads((self.out / "request_plan.json").read_text(encoding="utf-8"))
        self.assertEqual(plan["requests_made"], 0)
        self.assertFalse((self.out / "verification_results.json").exists())
        self.assertTrue(all(bv.check_url(p["url"]) is None and len(p["record_sha256"]) == 64 for p in plan["planned"]))

    def test_fixture_pipeline_end_to_end_is_offline_and_test_only(self):
        seeds_path = bv.DEFAULT_SEEDS_PATH
        before = hashlib.sha256(seeds_path.read_bytes()).hexdigest()
        attempts: list = []
        with patch.object(socket.socket, "connect", guarded_connect(attempts)), patch.object(socket, "getaddrinfo", no_dns(attempts)):
            self.assertEqual(self.quiet(bv.main, ["--intake", str(FIX / "intake_report.sample.json"), "--out-dir", str(self.out),
                                                  "--fixture-responses", str(FIX / "fixture_responses.sample.json")]), 0)
            self.assertEqual(self.quiet(sp.main, ["--intake", str(FIX / "intake_report.sample.json"), "--out-dir", str(self.out),
                                                  "--verification", str(self.out / "verification_results.json"),
                                                  "--metadata", str(FIX / "metadata.sample.json")]), 0)
        self.assertEqual(attempts, [], "fixture replay used no network")
        self.assertEqual(hashlib.sha256(seeds_path.read_bytes()).hexdigest(), before, "company_seeds.json untouched")
        results = json.loads((self.out / "verification_results.json").read_text(encoding="utf-8"))
        self.assertEqual((results["evidence"], results["test_only"]), (bv.SYNTHETIC, True))
        self.assertTrue(all(r["evidence"] == bv.SYNTHETIC for r in results["results"]))
        self.assertEqual({r["outcome"] for r in results["results"]},
                         {bv.VALID_WITH_JOBS, bv.VALID_EMPTY, bv.RATE_LIMITED, bv.SERVER_ERROR, bv.MALFORMED, bv.TRANSPORT_ERROR})
        prod = json.loads((self.out / "proposed_seeds.json").read_text(encoding="utf-8"))
        self.assertEqual(prod, {"layer1_public_ats": []}, "fixtures never produce production proposals")
        test = json.loads((self.out / "proposed_seeds.TEST_ONLY_SYNTHETIC.json").read_text(encoding="utf-8"))
        self.assertNotIn("layer1_public_ats", test, "test-only proposals sit under a key no seed loader reads")
        entries = test[sp.TEST_ONLY_KEY]
        self.assertEqual([e["slug"] for e in entries], ["synthetic-alpha", "synthetic-beta"])
        real_keys = {tuple(s) for s in json.loads(seeds_path.read_text(encoding="utf-8"))["layer1_public_ats"]}
        self.assertTrue(all(tuple(e) == sp.SEED_FIELDS and tuple(e) in real_keys for e in entries), "exact seed schema")
        report = json.loads((self.out / "seed_review_report.json").read_text(encoding="utf-8"))
        intake_rows = json.loads((FIX / "intake_report.sample.json").read_text(encoding="utf-8"))["records"]
        rows = [p["source_row"] for p in report["proposals"]] + [s["source_row"] for s in report["skipped"]]
        self.assertEqual(sorted(rows), sorted(r["source_row"] for r in intake_rows), "every intake record accounted for once")
        self.assertEqual({s["source_row"]: s["skip_kind"] for s in report["skipped"]}[16], "ats_token_mismatch")
        self.assertEqual(report["input_problems"]["verification"], [])
        self.assertEqual(len(report["inputs"]["intake"]["sha256"]), 64)

    def test_bad_inputs_exit_2(self):
        bad = self.out / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        empty = self.out / "empty.json"
        empty.write_text("{}", encoding="utf-8")
        for fn in (bv.main, sp.main):
            for path in (bad, empty, self.out / "missing.json"):
                with self.subTest(fn=fn.__module__, path=path.name), redirect_stdout(io.StringIO()), \
                        patch("sys.stderr", io.StringIO()):
                    self.assertEqual(fn(["--intake", str(path), "--out-dir", str(self.out / "o")]), 2)


if __name__ == "__main__":
    unittest.main()
