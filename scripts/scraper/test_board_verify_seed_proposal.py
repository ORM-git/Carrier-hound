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


def rec(row, company, ats, token, website="", **over):
    r = {"source_row": row, "company": company, "url_column": "Careers", "original_url": f"https://x/{token}",
         "normalized_url": None, "normalized_domain": None, "ats_candidate": ats,
         "identifiers": {"token": token} if token is not None else {}, "status": "ats_candidate", "reason": "fixture",
         "all_urls": {"Careers": f"https://x/{token}", "Website": website}, "merged_into_row": None, "review_groups": []}
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
            "source_row": 2, "company": "Synthetic"}


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
UNUSABLE = {  # postings present but missing a field the connector requires
    "greenhouse": {"jobs": [{"id": 1, "title": "T"}]},
    "lever": [{"id": "a", "text": "T"}],
    "ashby": {"jobs": [{"id": "a", "jobUrl": "https://jobs.ashbyhq.com/s/a"}]},
    "smartrecruiters": {"content": [{"id": "1"}, "not-an-object"]},
}


class EndpointTests(unittest.TestCase):
    def test_urls_match_the_connectors(self):
        self.assertEqual(bv.request_url("greenhouse", "s"), "https://boards-api.greenhouse.io/v1/boards/s/jobs?content=true&pay_transparency=true")
        self.assertEqual(bv.request_url("lever", "s"), "https://api.lever.co/v0/postings/s?mode=json")
        self.assertEqual(bv.request_url("ashby", "s"), "https://api.ashbyhq.com/posting-api/job-board/s?includeCompensation=true")
        self.assertEqual(bv.request_url("smartrecruiters", "S"), "https://api.smartrecruiters.com/v1/companies/S/postings")

    def test_invalid_identifiers_rejected(self):
        for tok in ("", "bad/token", "a%2Fb", "a~b", "-lead", "trail-", "a b", "x" * 101, "../x", "a?b", "a#b", None, 5, "ünï"):
            with self.subTest(token=tok), self.assertRaises(ValueError):
                bv.request_url("greenhouse", tok)
        with self.assertRaises(ValueError):
            bv.request_url("workday", "synthetic")
        self.assertTrue(bv.request_url("greenhouse", "a.b_c-1"), "negative control: a normal token is accepted")

    def test_non_approved_hosts_rejected(self):
        for url in ("http://boards-api.greenhouse.io/v1/boards/s/jobs", "https://boards-api.greenhouse.io.evil.example/x",
                    "https://evil.example/v1/boards/s/jobs", "https://boards-api.greenhouse.io:8443/x",
                    "https://user:pw@api.lever.co/v0/postings/s", "https://boards.greenhouse.io/s", None):
            with self.subTest(url=url), self.assertRaises(ValueError):
                bv.check_url(url)
        bv.check_url("https://api.lever.co/v0/postings/s?mode=json")  # negative control


class ClassifyTests(unittest.TestCase):
    def test_valid_and_empty_per_connector(self):
        for ats in bv.CONNECTORS:
            with self.subTest(ats=ats):
                res, sent = one(ats, lambda r, a=ats: httpx.Response(200, json=VALID[a]))
                self.assertEqual((res["outcome"], res["board_exists"], res["usable_postings"]), (bv.VALID_WITH_JOBS, True, 1))
                self.assertEqual(sent, [bv.request_url(ats, "synthetic-board")])
                res, _ = one(ats, lambda r, a=ats: httpx.Response(200, json=EMPTY[a]))
                self.assertEqual((res["outcome"], res["board_exists"], res["usable_postings"]), (bv.VALID_EMPTY, None, 0))

    def test_postings_without_connector_fields_are_not_counted(self):
        for ats in bv.CONNECTORS:
            with self.subTest(ats=ats):
                res, _ = one(ats, lambda r, a=ats: httpx.Response(200, json=UNUSABLE[a]))
                self.assertEqual(res["outcome"], bv.VALID_EMPTY)
                self.assertEqual(res["usable_postings"], 0)
                self.assertGreater(res["raw_postings"], 0)

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

    def test_tampered_plan_entry_sends_nothing(self):
        good = item("greenhouse", "synthetic-board")
        bad = [{**good, "url": "https://evil.example/x"}, {**good, "token": "../x"}, {**good, "ats": "workday"},
               {**good, "board_id": "greenhouse:other"}]
        results, sent = run_verify(lambda r: httpx.Response(200, json=VALID["greenhouse"]), bad)
        self.assertEqual(sent, [])
        self.assertEqual({r["outcome"] for r in results}, {bv.REJECTED})
        results, sent = run_verify(lambda r: httpx.Response(200, json=VALID["greenhouse"]), [good], evidence="made-up")
        self.assertEqual((sent, results[0]["outcome"]), ([], bv.REJECTED), "unknown evidence label is rejected")


class CandidateTests(unittest.TestCase):
    def test_eligibility_and_every_record_preserved(self):
        recs = [rec(2, "Synthetic A", "greenhouse", "synthetic-a"),
                rec(3, "Synthetic B", "workday", None, identifiers={"tenant": "t", "wd_cluster": "wd5", "site": "s"}),
                rec(4, "", "lever", "synthetic-c"),
                rec(5, "Synthetic D", "lever", "synthetic-d", status="ambiguous"),
                rec(6, "Synthetic E", "ashby", "bad%2Fe"),
                rec(7, "Synthetic F", "ashby", "synthetic-f", identifiers={"token": "synthetic-f", "extra": "1"}),
                rec(8, "Synthetic A", "greenhouse", "synthetic-a", merged_into_row=2),
                rec(9, "Synthetic G", "smartrecruiters", "SyntheticG", review_groups=["similar_name:x"]),
                rec(10, "Synthetic H", "lever", None),
                "not-a-record"]
        eligible, skipped = bv.select_candidates(intake(*recs), SEEDS)
        self.assertEqual([e["source_row"] for e in eligible], [2])
        kinds = {s["source_row"]: s["skip_kind"] for s in skipped}
        self.assertEqual(kinds, {3: "out_of_scope_ats", 4: "missing_company", 5: "not_candidate", 6: "invalid_identifier",
                                 7: "invalid_identifier", 8: "merged_duplicate", 9: "conflict", 10: "invalid_identifier",
                                 None: "malformed_record"})
        self.assertEqual(len(eligible) + len(skipped), len(recs))
        self.assertTrue(all("record" in s for s in skipped), "the original record is kept")

    def test_duplicate_boards_and_already_seeded(self):
        recs = [rec(2, "Synthetic A", "greenhouse", "synthetic-dup"), rec(3, "Synthetic B", "greenhouse", "Synthetic-Dup"),
                rec(4, "Synthetic C", "greenhouse", "synthetic-seeded"), rec(5, "Synthetic D", "lever", "synthetic-dup")]
        eligible, skipped = bv.select_candidates(intake(*recs), SEEDS)
        self.assertEqual([e["source_row"] for e in eligible], [5], "same token on another ATS is a different board")
        kinds = {s["source_row"]: s["skip_kind"] for s in skipped}
        self.assertEqual(kinds, {2: "duplicate_board", 3: "duplicate_board", 4: "already_seeded"})

    def test_malformed_intake(self):
        for bad in ({}, [], {"records": "x"}, None):
            with self.subTest(bad=bad), self.assertRaises(bv.IntakeError):
                bv.select_candidates(bad, SEEDS)


def verified(*results, file_evidence=bv.SYNTHETIC):
    return {"evidence": file_evidence, "results": list(results)}


def vres(ats, token, outcome=bv.VALID_WITH_JOBS, evidence=bv.SYNTHETIC):
    return {"board_id": bv.board_id(ats, token), "outcome": outcome, "evidence": evidence, "detail": "fixture"}


def meta(row, category="OTHER_STARTUPS", domain=None):
    return {"source_row": row, "category": category, "canonical_domain": domain, "provenance": "synthetic reviewer"}


def statuses(report):
    return {p["source_row"]: p["status"] for p in report["proposals"]}


class ProposalTests(unittest.TestCase):
    def test_qualification_needs_live_nonempty_evidence(self):
        recs = [rec(2, "Synthetic A", "greenhouse", "synthetic-a", "https://a.example"),
                rec(3, "Synthetic B", "lever", "synthetic-b", "https://b.example"),
                rec(4, "Synthetic C", "ashby", "synthetic-c", "https://c.example"),
                rec(5, "Synthetic D", "smartrecruiters", "SyntheticD", "https://d.example"),
                rec(6, "Synthetic E", "greenhouse", "synthetic-e", "https://e.example")]
        md = [meta(r) for r in (2, 3, 4, 5, 6)]
        synth = sp.propose(intake(*recs), SEEDS, verified(vres("greenhouse", "synthetic-a"), vres("lever", "synthetic-b", bv.VALID_EMPTY),
                                                          vres("ashby", "synthetic-c", bv.RATE_LIMITED),
                                                          vres("smartrecruiters", "SyntheticD", bv.NOT_FOUND)), md)
        self.assertEqual(statuses(synth), {2: sp.TEST_ONLY, 3: sp.NOT_QUALIFIED, 4: sp.NOT_QUALIFIED, 5: sp.NOT_QUALIFIED,
                                           6: sp.NOT_QUALIFIED})
        live = verified(vres("greenhouse", "synthetic-a", evidence=bv.LIVE), vres("lever", "synthetic-b", bv.VALID_EMPTY, bv.LIVE),
                        file_evidence=bv.LIVE)
        self.assertEqual(statuses(sp.propose(intake(*recs), SEEDS, live, md))[2], sp.PRODUCTION)
        self.assertEqual(statuses(sp.propose(intake(*recs), SEEDS, live, md))[3], sp.NOT_QUALIFIED, "live but empty never qualifies")
        # Negative controls: a result claiming live inside a synthetic file, or a file claiming live with synthetic
        # results, stays test-only.
        for v in (verified(vres("greenhouse", "synthetic-a", evidence=bv.LIVE)),
                  verified(vres("greenhouse", "synthetic-a"), file_evidence=bv.LIVE)):
            with self.subTest(v=v):
                self.assertEqual(statuses(sp.propose(intake(*recs), SEEDS, v, md))[2], sp.TEST_ONLY)

    def test_missing_fields_stay_unresolved(self):
        recs = [rec(2, "Synthetic A", "greenhouse", "synthetic-a", ""),
                rec(3, "Synthetic B", "greenhouse", "synthetic-b", "https://b.example"),
                rec(4, "株式会社", "greenhouse", "synthetic-c", "https://c.example"),
                rec(5, "Synthetic D", "greenhouse", "synthetic-d", "https://www.linkedin.com/company/x"),
                rec(6, "Synthetic E", "greenhouse", "synthetic-e", "https://boards.greenhouse.io/synthetic-e"),
                rec(7, "Synthetic F", "greenhouse", "synthetic-f", "https://jobs.f.example")]
        v = verified(*(vres("greenhouse", t) for t in ("synthetic-a", "synthetic-b", "synthetic-c", "synthetic-d", "synthetic-e", "synthetic-f")))
        r = sp.propose(intake(*recs), SEEDS, v, [meta(2), meta(4), meta(5), meta(6), meta(7)])
        by = {p["source_row"]: p for p in r["proposals"]}
        self.assertEqual(set(by[2]["unresolved"]), {"canonical_domain"})
        self.assertEqual(set(by[3]["unresolved"]), {"category"}, "no category without reviewer metadata")
        self.assertEqual(set(by[4]["unresolved"]), {"slug"})
        self.assertEqual(set(by[5]["unresolved"]), {"canonical_domain"}, "third-party profile host is not a company domain")
        self.assertEqual(set(by[6]["unresolved"]), {"canonical_domain"}, "ATS host is not a company domain")
        self.assertEqual(set(by[7]["unresolved"]), {"canonical_domain"}, "subdomain: registrable domain unknown")
        self.assertTrue(all(p["status"] == sp.UNRESOLVED for p in r["proposals"]))
        self.assertIsNone(by[3]["seed"]["category"], "unresolved stays null, never guessed")

    def test_slug_collisions(self):
        recs = [rec(2, "Synthetic Nu", "greenhouse", "synthetic-nu-1", "https://nu1.example"),
                rec(3, "synthetic-nu!", "lever", "synthetic-nu-2", "https://nu2.example"),
                rec(4, "Synthetic Seeded", "ashby", "synthetic-other", "https://other.example"),
                rec(5, "Synthetic Xi", "ashby", "synthetic-xi", "https://xi.example")]
        v = verified(vres("greenhouse", "synthetic-nu-1"), vres("lever", "synthetic-nu-2"), vres("ashby", "synthetic-other"), vres("ashby", "synthetic-xi"))
        r = sp.propose(intake(*recs), SEEDS, v, [meta(n) for n in (2, 3, 4, 5)])
        by = {p["source_row"]: p for p in r["proposals"]}
        self.assertTrue(any("slug collision" in c for c in by[2]["conflicts"]))
        self.assertTrue(any("slug collision" in c for c in by[3]["conflicts"]))
        self.assertTrue(any("already used by seed board greenhouse:synthetic-seeded" in c for c in by[4]["conflicts"]))
        self.assertEqual(by[5]["conflicts"], [], "negative control")
        self.assertEqual(statuses(r), {2: sp.UNRESOLVED, 3: sp.UNRESOLVED, 4: sp.UNRESOLVED, 5: sp.TEST_ONLY})

    def test_shared_domain_different_companies_not_merged(self):
        recs = [rec(2, "Synthetic Omicron", "greenhouse", "synthetic-o", "https://shared.example"),
                rec(3, "Synthetic Pi", "lever", "synthetic-p", "https://www.shared.example/about"),
                rec(4, "Synthetic Rho", "ashby", "synthetic-r", "https://rho.example")]
        v = verified(vres("greenhouse", "synthetic-o"), vres("lever", "synthetic-p"), vres("ashby", "synthetic-r"))
        r = sp.propose(intake(*recs), SEEDS, v, [meta(n) for n in (2, 3, 4)])
        self.assertEqual(len(r["proposals"]), 3, "two companies on one domain stay two proposals")
        by = {p["source_row"]: p for p in r["proposals"]}
        for row in (2, 3):
            self.assertEqual(by[row]["seed"]["canonical_domain"], "shared.example")
            self.assertTrue(any("shared domain" in c for c in by[row]["conflicts"]))
        self.assertEqual(by[4]["conflicts"], [])

    def test_conflicting_input(self):
        recs = [rec(2, "Synthetic A", "greenhouse", "synthetic-a", "https://a.example"),
                rec(3, "Synthetic B", "lever", "synthetic-b", "https://b.example"),
                rec(4, "Synthetic C", "ashby", "synthetic-c", "https://c.example"),
                rec(5, "Synthetic D", "ashby", "synthetic-d", "https://d.example")]
        v = verified(vres("greenhouse", "synthetic-a"), vres("lever", "synthetic-b"), vres("ashby", "synthetic-c"),
                     vres("ashby", "synthetic-c", bv.RATE_LIMITED), vres("ashby", "synthetic-d"), vres("lever", "synthetic-unknown"))
        md = [meta(2, domain="other-a.example"), meta(3), meta(3, category="MNC_BIGTECH"), meta(4), meta(5, category="NOT_A_CATEGORY"),
              meta(99), {"category": "OTHER_STARTUPS"}]
        r = sp.propose(intake(*recs), SEEDS, v, md)
        by = {p["source_row"]: p for p in r["proposals"]}
        self.assertTrue(any("sheet website says a.example, metadata says other-a.example" in c for c in by[2]["conflicts"]))
        self.assertTrue(any("conflicting reviewer metadata" in c for c in by[3]["conflicts"]))
        self.assertTrue(any("conflicting verification" in c for c in by[4]["conflicts"]))
        self.assertTrue(any("NOT_A_CATEGORY" in c for c in by[5]["conflicts"]))
        self.assertEqual(set(statuses(r).values()), {sp.UNRESOLVED})
        self.assertEqual(len(r["input_problems"]["metadata"]), 3, "unknown row, missing row and conflicting duplicate kept")
        self.assertEqual(len(r["input_problems"]["verification"]), 2, "unknown board and conflicting duplicate kept")


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
        self.assertTrue(all(p["url"].startswith("https://") and bv.check_url(p["url"]) is None for p in plan["planned"]))

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
        self.assertEqual(report["verification_evidence"], [bv.SYNTHETIC])
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
