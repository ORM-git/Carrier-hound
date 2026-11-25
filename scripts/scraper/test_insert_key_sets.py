"""PGRST102 diagnosis (run 45535361727): bulk insert key sets at the real writer boundary.

Offline only: every HTTP call goes to httpx.MockTransport. The mock enforces PostgREST's documented bulk-insert
rule (every object in a JSON array body must have the same keys, else 400 PGRST102 "All object keys must match").
These tests prove what the WRITER sends; they do not prove what caused the production failure.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from scripts.scraper import engine, fetchers, run_ingestion
from scripts.scraper.persistence import KEY_MISMATCH_MESSAGE, db_error_diagnostic, key_set_summary

FAKE_URL = "https://unit-test-project.supabase.co"
FAKE_KEY = "fake-service-role-key-for-tests-0123456789"
KEY_MISMATCH = {"code": "PGRST102", "message": KEY_MISMATCH_MESSAGE, "details": None, "hint": None}
SECRET_BODY = {"code": "XX000", "message": "SECRET-MESSAGE", "details": "SECRET-DETAILS Key (apply_url)=(https://SECRET)",
               "hint": "SECRET-HINT"}


def gh(n: int, **over) -> dict:
    """Greenhouse row: carries remote_eligibility; company slug 'acme' resolves to a company_id."""
    r = fetchers.build_normalized_job(
        seed={"name": "Acme", "slug": "acme"}, source="greenhouse", source_type="greenhouse", source_id="greenhouse:acme",
        source_job_id=f"g{n}", title="Software Engineer", location="Remote", apply_url=f"https://example.com/g/{n}",
        remote_eligibility="worldwide")
    r.update(over)
    return r


def lv(n: int, **over) -> dict:
    """Lever row: no remote_eligibility key; slug 'beta' has no company_id in the map."""
    r = fetchers.build_normalized_job(
        seed={"name": "Beta", "slug": "beta"}, source="lever", source_type="lever", source_id="lever:beta",
        source_job_id=f"l{n}", title="Data Engineer", location="Remote", apply_url=f"https://example.com/l/{n}")
    r.update(over)
    return r


COMPANY_MAP = {"acme": "co-acme"}


class Pg:
    """Mock PostgREST. `on_post(index, rows)` may return a Response or raise to inject a failure."""

    def __init__(self, on_post=None):
        self.on_post = on_post
        self.posts: list[list[dict]] = []
        self.patches: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=[])
        if request.method == "PATCH":
            self.patches.append(request.url.path)
            return httpx.Response(200, headers={"content-range": "0-0/0"}, json=[])
        assert request.method == "POST" and request.url.path == "/rest/v1/jobs", request.url.path
        assert request.headers["content-type"] == "application/json"
        rows = json.loads(request.content)
        assert isinstance(rows, list) and all(isinstance(r, dict) for r in rows)
        self.posts.append(rows)
        if self.on_post:
            injected = self.on_post(len(self.posts) - 1, rows)
            if injected is not None:
                return injected
        if len({frozenset(r) for r in rows}) > 1:
            return httpx.Response(400, json=KEY_MISMATCH)
        return httpx.Response(201, json=[{**r, "id": f"id-{len(self.posts)}-{i}"} for i, r in enumerate(rows)])

    def sent_ids(self) -> list[str]:
        return [r["source_job_id"] for rows in self.posts for r in rows]


def sync(rows: list[dict], pg: Pg, company_map=COMPANY_MAP) -> dict:
    async def run():
        writer = engine.SupabaseSetDiffWriter(FAKE_URL, FAKE_KEY)
        async with httpx.AsyncClient(transport=httpx.MockTransport(pg)) as client:
            return await writer.sync_jobs_set_diff(client, rows, dict(company_map))
    return asyncio.run(run())


def keys(stats: dict, name: str) -> list[list[str]]:
    return sorted(stats.get(name) or [])


class WriterKeySetTests(unittest.TestCase):
    def test_mixed_key_sets_go_out_as_contiguous_same_key_sub_batches_in_order(self):
        pg = Pg()
        stats = sync([gh(1), gh(2), lv(1), gh(3)], pg)
        self.assertFalse(stats["persistence_failed"], stats["write_errors"])
        self.assertEqual([len(p) for p in pg.posts], [2, 1, 1], "contiguous runs, never regrouped")
        self.assertEqual(pg.sent_ids(), ["g1", "g2", "l1", "g3"], "row order preserved")
        for rows in pg.posts:
            self.assertEqual(len({frozenset(r) for r in rows}), 1, "each request has one key set")
        lever = pg.posts[1][0]
        self.assertNotIn("company_id", lever, "omitted column stays omitted (DB default), never padded with null")
        self.assertNotIn("remote_eligibility", lever)
        self.assertEqual(pg.posts[0][0]["company_id"], "co-acme")
        self.assertEqual(stats["inserted"], 4)
        self.assertEqual(keys(stats, "inserted_source_keys"),
                         sorted([["greenhouse:acme", "g1"], ["greenhouse:acme", "g2"], ["greenhouse:acme", "g3"], ["lever:beta", "l1"]]))

    def test_uniform_batch_is_one_request(self):
        pg = Pg()
        stats = sync([gh(1), gh(2), gh(3)], pg)
        self.assertEqual([len(p) for p in pg.posts], [3])
        self.assertEqual(stats["inserted"], 3)

    def test_empty_batch_sends_nothing(self):
        pg = Pg()
        stats = sync([], pg)
        self.assertEqual(pg.posts, [])
        self.assertEqual((stats["inserted"], stats["persistence_failed"]), (0, False))

    def test_missing_and_explicit_null_are_different_key_sets(self):
        explicit_null = gh(1, remote_eligibility=None)
        missing = gh(2)
        del missing["remote_eligibility"]
        pg = Pg()
        stats = sync([explicit_null, missing], pg)
        self.assertEqual([len(p) for p in pg.posts], [1, 1])
        self.assertIn("remote_eligibility", pg.posts[0][0])
        self.assertIsNone(pg.posts[0][0]["remote_eligibility"], "explicit null is sent as null")
        self.assertNotIn("remote_eligibility", pg.posts[1][0], "missing stays missing")
        self.assertEqual(stats["inserted"], 2)

    def test_duplicate_apply_url_claimed_only_after_confirmed_insert(self):
        url = "https://example.com/shared"
        # First candidate (lever key set) inserted -> the later greenhouse candidate is a duplicate.
        pg = Pg()
        stats = sync([lv(1, apply_url=url), gh(1, apply_url=url), gh(2)], pg)
        self.assertEqual(pg.sent_ids(), ["l1", "g2"])
        self.assertEqual([d["source_key"] for d in stats["duplicate_skipped"]], ["greenhouse:acme/g1"])

        # First candidate rejected by a CHECK (nothing written) -> the next candidate gets its chance.
        check = httpx.Response(400, json={"code": "23514", "message": "violates check constraint \"jobs_job_type_check\""})
        pg = Pg(on_post=lambda i, rows: check if rows[0]["source_job_id"] == "l1" else None)
        stats = sync([lv(1, apply_url=url), gh(1, apply_url=url)], pg)
        self.assertEqual(pg.sent_ids(), ["l1", "g1"])
        self.assertEqual(keys(stats, "inserted_source_keys"), [["greenhouse:acme", "g1"]])
        self.assertEqual(stats["duplicate_skipped"], [])

    def test_partial_success_counts_and_source_keys_then_unknown_400_stops(self):
        pg = Pg(on_post=lambda i, rows: httpx.Response(400, json=SECRET_BODY) if i == 1 else None)
        stats = sync([gh(1), gh(2), lv(1), lv(2), gh(3)], pg)
        self.assertEqual(pg.sent_ids(), ["g1", "g2", "l1", "l2"], "nothing is sent after the failed sub-batch")
        self.assertTrue(stats["persistence_failed"])
        self.assertEqual((stats["inserted"], stats["failed_writes"]), (2, 2))
        self.assertEqual(keys(stats, "inserted_source_keys"), [["greenhouse:acme", "g1"], ["greenhouse:acme", "g2"]])
        self.assertEqual(keys(stats, "persisted_source_keys"), keys(stats, "inserted_source_keys"))
        self.assertEqual(len(stats["write_errors"]), 1)
        err = stats["write_errors"][0]
        self.assertIn("HTTP 400 code XX000", err)
        self.assertIn("batch 2 rows, 1 key set", err)

    def test_network_failure_on_a_sub_batch_stops_writes(self):
        def boom(i, rows):
            if i == 1:
                raise httpx.ConnectError(f"SECRET connect failure to {FAKE_URL}/rest/v1/jobs?apikey={FAKE_KEY}")
            return None
        pg = Pg(on_post=boom)
        stats = sync([gh(1), lv(1), gh(2)], pg)
        self.assertEqual(pg.sent_ids(), ["g1", "l1"])
        self.assertTrue(stats["persistence_failed"])
        self.assertEqual((stats["inserted"], stats["failed_writes"]), (1, 1))
        self.assertEqual(stats["write_errors"], ["Job insert exception: ConnectError; batch 1 rows, 1 key set(s): 1 rows missing none"])

    def test_unknown_pgrst102_stays_generic_and_recognized_one_is_classified(self):
        unknown = httpx.Response(400, json={"code": "PGRST102", "message": "Empty or invalid json SECRET", "details": "SECRET"})
        stats = sync([gh(1)], Pg(on_post=lambda i, rows: unknown))
        self.assertTrue(stats["persistence_failed"])
        self.assertIn("HTTP 400 code PGRST102;", stats["write_errors"][0])
        self.assertNotIn("keys must match", stats["write_errors"][0])

        known = httpx.Response(400, json=KEY_MISMATCH)
        stats = sync([gh(1), gh(2)], Pg(on_post=lambda i, rows: known))
        self.assertIn("HTTP 400 code PGRST102 (all object keys must match); batch 2 rows, 1 key set(s)", stats["write_errors"][0])

    def test_failure_diagnostics_never_carry_row_values_response_text_urls_or_credentials(self):
        secret_rows = [gh(1, title="SECRET-TITLE", description="SECRET-DESC", company="SECRET-CO",
                          apply_url="https://SECRET-URL.example/1", source_job_id="SECRET-ID-1"),
                       lv(1, title="SECRET-TITLE-2", apply_url="https://SECRET-URL.example/2", source_job_id="SECRET-ID-2")]
        for injected in (httpx.Response(400, json=SECRET_BODY), httpx.Response(400, text="SECRET plain body"),
                         httpx.Response(503, json={**SECRET_BODY, "code": "PGRST102"})):
            stats = sync(secret_rows, Pg(on_post=lambda i, rows, r=injected: r))
            diag = json.dumps({"write_errors": stats["write_errors"], "rejected": stats["rejected"]})
            for leak in ("SECRET", FAKE_URL, FAKE_KEY, "unit-test-project", "example", "co-acme"):
                self.assertNotIn(leak, diag)
            self.assertTrue(stats["persistence_failed"])


class DiagnosticUnitTests(unittest.TestCase):
    def test_key_set_summary_is_bounded_and_names_only_allowed_columns(self):
        allowed = {f"c{i}" for i in range(20)}
        rows = [{f"c{j}": "SECRET" for j in range(20) if j != i} | {"SECRET_COLUMN": 1} for i in range(12)]
        text = key_set_summary(rows, allowed)
        self.assertTrue(text.startswith("batch 12 rows, 12 key set(s): 1 rows missing [c0]; "))
        self.assertTrue(text.endswith("; +7 more"))
        self.assertNotIn("SECRET", text)
        self.assertEqual(key_set_summary([], allowed), "batch 0 rows, 0 key set(s)")

    def test_db_error_diagnostic_classifies_only_the_exact_message(self):
        self.assertEqual(db_error_diagnostic(400, json.dumps(KEY_MISMATCH)),
                         ("PGRST102", "HTTP 400 code PGRST102 (all object keys must match)"))
        for body in (json.dumps({"code": "PGRST102", "message": "All object keys must match SECRET"}),
                     json.dumps({"code": "PGRST102", "message": "Empty or invalid json"}), "not json SECRET"):
            code, reason = db_error_diagnostic(400, body)
            self.assertNotIn("keys must match", reason)
            self.assertNotIn("SECRET", reason)
        self.assertEqual(db_error_diagnostic(503, json.dumps(KEY_MISMATCH))[1], "HTTP 503 code PGRST102")


SEEDS = {"layer1_public_ats": [{"ats": "greenhouse", "slug": "acme", "token": "acme", "name": "Acme"},
                               {"ats": "lever", "slug": "beta", "token": "beta", "name": "Beta"}]}


class ExpiryVetoTests(unittest.TestCase):
    def test_partial_insert_failure_vetoes_expiry_and_sends_no_expiry_patch(self):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(SEEDS, tmp)
        tmp.close()
        self.addCleanup(os.unlink, tmp.name)
        pg = Pg(on_post=lambda i, rows: httpx.Response(400, json=SECRET_BODY) if i == 1 else None)
        rows = [gh(1), gh(2), lv(1)]
        empty = AsyncMock(return_value=([], None))
        with patch.dict(os.environ, {"NEXT_PUBLIC_SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}), \
                patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
                patch.object(engine.SupabaseSetDiffWriter, "sync_companies", AsyncMock(return_value=dict(COMPANY_MAP))), \
                patch.object(run_ingestion, "fetch_layer1_seed", AsyncMock(return_value=(rows, None))), \
                patch.object(run_ingestion, "enrich_greenhouse_pay_transparency", AsyncMock(return_value=None)), \
                patch.object(run_ingestion, "fetch_jobspy_india", empty), \
                patch.object(run_ingestion, "fetch_arbeitnow", empty), \
                patch.object(run_ingestion, "fetch_adzuna", empty):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                seeds_path=tmp.name, dry_run=False, allow_uncapped=True, no_expire=False, allow_expire=True,
                cohort="non-workday", transport=httpx.MockTransport(pg)))
        self.assertTrue(report["expiry_vetoed"])
        self.assertEqual(pg.patches, [], "no expiry request after a failed write")
        self.assertTrue(engine.ingestion_has_errors(report))
        self.assertNotIn("SECRET", json.dumps(report.get("write_errors") or report.get("db_stats", {}).get("write_errors") or []))


if __name__ == "__main__":
    unittest.main()
