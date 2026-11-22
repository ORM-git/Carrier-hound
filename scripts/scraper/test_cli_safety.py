"""Zero-write safety tests for both Python ingestion CLIs (engine.py, run_ingestion.py).

No network, no database, no real .env: dotenv loading is stubbed, credentials are fake, every HTTP call goes
through a recording MockTransport, and SupabaseSetDiffWriter explodes if it is ever constructed.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from scripts.scraper import engine, run_ingestion

FAKE_HOST = "unit-test-project.supabase.co"
FAKE_KEY = "fake-service-role-key-for-tests-0123456789"
FAKE_ENV = {"NEXT_PUBLIC_SUPABASE_URL": f"https://{FAKE_HOST}", "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}
NO_CREDS = {"NEXT_PUBLIC_SUPABASE_URL": "", "SUPABASE_URL": "", "SUPABASE_SERVICE_ROLE_KEY": "", "SUPABASE_SERVICE_KEY": ""}
BOARD = "greenhouse:stripe"  # a real board id from company_seeds.json (ats:slug)


def _writer_must_not_exist(*_a, **_k):
    raise AssertionError("SupabaseSetDiffWriter constructed in a mode that must not write")


class Recorder:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.method, request.url.host, request.url.path))
        if request.url.host == FAKE_HOST:
            return httpx.Response(500, json={"error": "database must not be called"})
        if request.url.host == "boards-api.greenhouse.io":
            if "/jobs/" in request.url.path:
                return httpx.Response(200, json={"pay_input_ranges": []})
            return httpx.Response(200, json={"jobs": [{
                "id": 101, "title": "Software Engineer", "absolute_url": "https://boards.greenhouse.io/stripe/jobs/101",
                "location": {"name": "San Francisco, CA"}, "updated_at": "2026-11-20T00:00:00Z", "content": "<p>Build</p>",
            }]})
        return httpx.Response(404, json={})

    def db_calls(self):
        return [c for c in self.calls if c[1] == FAKE_HOST]


@contextlib.contextmanager
def isolated(env: dict[str, str]):
    """Fake env only, no .env loading, writer construction forbidden."""
    with patch.dict(os.environ, env), \
            patch.object(engine, "load_dotenv_into_env", lambda: None), \
            patch.object(run_ingestion, "load_dotenv_into_env", lambda: None), \
            patch.object(engine, "SupabaseSetDiffWriter", side_effect=_writer_must_not_exist), \
            patch.object(run_ingestion, "SupabaseSetDiffWriter", side_effect=_writer_must_not_exist):
        yield


def run_cli(module, argv: list[str], target: str, run_result: dict | None = None):
    """Runs module.main() with argv, the run function replaced by a recording AsyncMock."""
    fake_run = AsyncMock(return_value=run_result or {})
    err = io.StringIO()
    with patch.object(module, target, fake_run), patch.object(sys, "argv", ["prog", *argv]), \
            contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
        code = 0
        try:
            module.main()
        except SystemExit as exc:
            code = exc.code
    return fake_run, code, err.getvalue()


CLIS = [(engine, "run_ingestion"), (run_ingestion, "run_master_ingestion")]


class CliModeTests(unittest.TestCase):
    def test_no_flag_is_dry_run_even_with_credentials_present(self):
        for module, target in CLIS:
            for argv in ([], ["--production"]):
                with self.subTest(cli=module.__name__, argv=argv), isolated(FAKE_ENV):
                    fake_run, code, err = run_cli(module, argv, target)
                    self.assertEqual(code, 0)
                    self.assertIs(fake_run.call_args.kwargs["dry_run"], True)
                    self.assertIn("DRY-RUN", err)

    def test_explicit_dry_run_flag(self):
        for module, target in CLIS:
            with self.subTest(cli=module.__name__), isolated(FAKE_ENV):
                fake_run, _, _ = run_cli(module, ["--dry-run"], target)
                self.assertIs(fake_run.call_args.kwargs["dry_run"], True)

    def test_dry_run_and_write_are_mutually_exclusive(self):
        for module, target in CLIS:
            with self.subTest(cli=module.__name__), isolated(FAKE_ENV):
                fake_run, code, err = run_cli(module, ["--dry-run", engine.WRITE_FLAG], target)
                self.assertEqual(code, 2)
                self.assertIn("not allowed with argument", err)
                fake_run.assert_not_called()

    def test_write_flag_is_the_only_way_to_request_writes(self):
        for module, target in CLIS:
            with self.subTest(cli=module.__name__), isolated(FAKE_ENV):
                fake_run, _, _ = run_cli(module, [engine.WRITE_FLAG, "--max-rows", "10", "--no-expire"], target)
                self.assertIs(fake_run.call_args.kwargs["dry_run"], False)
                self.assertEqual(fake_run.call_args.kwargs["max_rows"], 10)
                self.assertIs(fake_run.call_args.kwargs["no_expire"], True)

    def test_production_flag_allows_uncapped_write_on_both_clis(self):
        for module, target in CLIS:
            with self.subTest(cli=module.__name__), isolated(FAKE_ENV):
                fake_run, code, _ = run_cli(module, [engine.WRITE_FLAG, "--production"], target)
                self.assertEqual(code, 0)
                self.assertIs(fake_run.call_args.kwargs["dry_run"], False)
                self.assertIsNone(fake_run.call_args.kwargs["max_rows"])
                self.assertIs(fake_run.call_args.kwargs["allow_uncapped"], True)
                self.assertIs(fake_run.call_args.kwargs["no_expire"], True)

    def test_expire_flag_enables_expiry_only_for_uncapped_production_write(self):
        with isolated(FAKE_ENV):
            fake_run, code, _ = run_cli(
                run_ingestion, [engine.WRITE_FLAG, "--production", "--expire"], "run_master_ingestion",
            )
            self.assertEqual(code, 0)
            self.assertIsNone(fake_run.call_args.kwargs["max_rows"])
            self.assertIs(fake_run.call_args.kwargs["no_expire"], False)
            self.assertIs(fake_run.call_args.kwargs["allow_expire"], True)

    def test_expiry_flag_refuses_capped_and_dry_run_modes(self):
        cases = [
            [engine.WRITE_FLAG, "--max-rows", "10", "--expire"],
            ["--dry-run", "--expire"],
        ]
        for module, target in CLIS:
            for argv in cases:
                with self.subTest(cli=module.__name__, argv=argv), isolated(FAKE_ENV):
                    fake_run, code, err = run_cli(module, argv, target)
                    self.assertEqual(code, 2)
                    if module is engine:
                        self.assertIn("scripts.scraper.run_ingestion", err)
                    else:
                        self.assertIn("expiry", err.lower())
                    fake_run.assert_not_called()

    def test_environment_variables_cannot_enable_writes_or_expiry(self):
        unsafe_looking_env = {
            **FAKE_ENV, "PRODUCTION": "1", "ALLOW_UNCAPPED": "1",
            "WRITE_TO_DATABASE": "1", "EXPIRE": "1", "NO_EXPIRE": "0",
        }
        for module, target in CLIS:
            with self.subTest(cli=module.__name__), isolated(unsafe_looking_env):
                fake_run, code, _ = run_cli(module, [], target)
                self.assertEqual(code, 0)
                self.assertTrue(fake_run.call_args.kwargs["dry_run"])
                self.assertTrue(fake_run.call_args.kwargs["no_expire"])

    def test_engine_cli_refuses_expiry_before_network_and_points_to_master_runner(self):
        with isolated(FAKE_ENV), patch.object(sys, "argv", [
            "prog", engine.WRITE_FLAG, "--production", "--expire",
        ]), patch.object(httpx, "AsyncClient", side_effect=AssertionError("network called")):
            err = io.StringIO()
            with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    engine.main()
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("scripts.scraper.run_ingestion", err.getvalue())

    def test_failure_reports_make_ingestion_error_and_cli_exit_nonzero(self):
        failure_report = {"expiry_reports": [{"source_id": BOARD, "status": "failed", "error": "HTTP 500"}]}
        self.assertTrue(engine.ingestion_has_errors(failure_report))
        for module, target in CLIS:
            with self.subTest(cli=module.__name__), isolated(FAKE_ENV):
                _fake_run, code, err = run_cli(
                    module, ["--max-rows", "10"], target, failure_report,
                )
                self.assertEqual(code, 1)
                self.assertIn("expiry", err.lower())

    def test_write_mode_requires_positive_cap_before_invoking_either_orchestrator(self):
        for module, target in CLIS:
            for cap_args in ([], ["--max-rows", "0"], ["--max-rows", "-1"]):
                with self.subTest(cli=module.__name__, cap_args=cap_args), isolated(FAKE_ENV):
                    fake_run, code, err = run_cli(module, [engine.WRITE_FLAG, *cap_args], target)
                    self.assertEqual(code, 2)
                    self.assertIn("--max-rows", err)
                    fake_run.assert_not_called()

    def test_write_flag_without_valid_credentials_refuses_before_any_network(self):
        bad_envs = [
            NO_CREDS,
            {**NO_CREDS, "NEXT_PUBLIC_SUPABASE_URL": f"http://{FAKE_HOST}", "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY},
            {**NO_CREDS, "NEXT_PUBLIC_SUPABASE_URL": f"https://{FAKE_HOST}", "SUPABASE_SERVICE_ROLE_KEY": "short"},
        ]
        for module, _ in CLIS:
            for env in bad_envs:
                with self.subTest(cli=module.__name__, env=sorted(k for k, v in env.items() if v)), isolated(env), \
                        patch.object(httpx, "AsyncClient", side_effect=AssertionError("network used before credential check")), \
                        patch.object(sys, "argv", ["prog", engine.WRITE_FLAG]):
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                        with self.assertRaises(SystemExit) as ctx:
                            module.main()
                    self.assertEqual(ctx.exception.code, 2)
                    self.assertIn("write mode refused", err.getvalue())
                    self.assertNotIn(FAKE_KEY, err.getvalue())  # never echoes credential values

    def test_both_clis_exit_nonzero_when_source_or_persistence_errors_are_reported(self):
        cases = [
            (engine, "run_ingestion", {"errors": ["source fetch failed"]}),
            (run_ingestion, "run_master_ingestion", {"failed_sources": [{"source": BOARD, "error": "source fetch failed"}]}),
            (engine, "run_ingestion", {"db": {"persistence_failed": True}}),
            (run_ingestion, "run_master_ingestion", {"db": {"persistence_failed": True}}),
        ]
        for module, target, result in cases:
            with self.subTest(cli=module.__name__, result=result), isolated(FAKE_ENV):
                _fake_run, code, err = run_cli(module, ["--max-rows", "10"], target, result)
                self.assertEqual(code, 1)
                self.assertIn("ingestion failed", err)


class DryRunZeroWriteTests(unittest.TestCase):
    def test_direct_write_orchestration_requires_positive_cap_before_fetch(self):
        for cap in (None, 0, -1):
            rec = Recorder()
            with self.subTest(cap=cap), isolated(FAKE_ENV):
                with self.assertRaises(engine.WriteAuthorizationError):
                    asyncio.run(engine.run_ingestion(dry_run=False, max_rows=cap, transport=httpx.MockTransport(rec)))
                with self.assertRaises(engine.WriteAuthorizationError):
                    asyncio.run(run_ingestion.run_master_ingestion(
                        sources=[BOARD], dry_run=False, max_rows=cap, transport=httpx.MockTransport(rec)))
            self.assertEqual(rec.calls, [])

        rec = Recorder()
        with isolated(FAKE_ENV):
            with self.assertRaises(engine.WriteAuthorizationError):
                asyncio.run(run_ingestion.run_master_ingestion(
                    sources=[BOARD], dry_run=True, max_rows=10, no_expire=False,
                    transport=httpx.MockTransport(rec),
                ))
        self.assertEqual(rec.calls, [])

    def test_run_master_dry_run_with_credentials_never_writes_and_stays_on_one_board(self):
        rec = Recorder()
        jobspy = AsyncMock(side_effect=AssertionError("layer3 must not run for an exact board"))
        with isolated(FAKE_ENV):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                sources=[BOARD], dry_run=True, transport=httpx.MockTransport(rec), jobspy_scrape_fn=jobspy))
        self.assertEqual(rec.db_calls(), [])
        self.assertEqual(report["sources_requested"], [BOARD])
        self.assertEqual({(m, h) for m, h, _ in rec.calls}, {("GET", "boards-api.greenhouse.io")})
        self.assertEqual(len(rec.calls), 2, rec.calls)  # board list plus selected job pay details
        self.assertEqual([s["source"] for s in report["sources"]], [BOARD])
        self.assertEqual(report["db"]["expired"], 0)
        self.assertEqual(report["expiry_reports"], [])
        self.assertIs(report["dry_run"], True)
        self.assertEqual(report["fetched"], 1)
        self.assertEqual(report["selected"], 1)
        self.assertEqual(report["skipped_by_cap"], 0)
        self.assertEqual(report["persisted_counts"], None)
        self.assertEqual(report["projected_counts"]["inserted"], 1)
        jobspy.assert_not_called()

    def test_exact_board_filter_is_case_and_space_insensitive_but_never_expands(self):
        rec = Recorder()
        with isolated(FAKE_ENV):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                sources=["  GreenHouse:Stripe "], dry_run=True, transport=httpx.MockTransport(rec)))
        self.assertEqual([s["source"] for s in report["sources"]], [BOARD])
        self.assertEqual(len(rec.calls), 2)

    def test_engine_dry_run_with_credentials_never_writes(self):
        rec = Recorder()
        with isolated(FAKE_ENV):
            asyncio.run(engine.run_ingestion(dry_run=True, max_seeds_per_layer=1, transport=httpx.MockTransport(rec)))
        self.assertTrue(rec.calls, "fetchers should have run against the mock transport")
        self.assertEqual(rec.db_calls(), [])

    def test_library_write_mode_without_credentials_raises_before_fetching(self):
        rec = Recorder()
        with isolated(NO_CREDS):
            with self.assertRaises(engine.WriteAuthorizationError):
                asyncio.run(engine.run_ingestion(dry_run=False, transport=httpx.MockTransport(rec)))
            with self.assertRaises(engine.WriteAuthorizationError):
                asyncio.run(run_ingestion.run_master_ingestion(sources=[BOARD], dry_run=False, transport=httpx.MockTransport(rec)))
        self.assertEqual(rec.calls, [])

    def test_company_lookup_failure_prevents_all_persistence_and_expiry_requests(self):
        rec = Recorder()
        real_writer = run_ingestion.SupabaseSetDiffWriter

        def fail_company_lookup(request: httpx.Request) -> httpx.Response:
            rec(request)
            if request.url.host == "boards-api.greenhouse.io" and "/jobs/" in request.url.path:
                return httpx.Response(200, json={"pay_input_ranges": []})
            if request.url.host == FAKE_HOST:
                return httpx.Response(500, json={"error": "lookup failed"})
            return httpx.Response(200, json={"jobs": [{
                "id": 101, "title": "Software Engineer", "absolute_url": "https://boards.greenhouse.io/stripe/jobs/101",
                "location": {"name": "Remote US"}, "first_published": "2026-10-01T00:00:00Z", "content": "Build",
            }]})

        with isolated(FAKE_ENV), patch.object(run_ingestion, "SupabaseSetDiffWriter", real_writer):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                sources=[BOARD], dry_run=False, max_rows=10,
                transport=httpx.MockTransport(fail_company_lookup),
            ))

        self.assertTrue(report["db"]["persistence_failed"])
        self.assertTrue(any("Companies lookup error" in error for error in report["db"]["write_errors"]))
        db_calls = rec.db_calls()
        self.assertEqual([call[0] for call in db_calls], ["GET"])
        self.assertIn("companies", db_calls[0][2])
        self.assertEqual(report["expiry_reports"], [])

    def test_write_cap_is_global_across_sources_and_larger_than_one_writer_batch(self):
        seeds = {
            "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
            "layer1_public_ats": [
                {"ats": "greenhouse", "slug": "alpha", "source_priority": 1},
                {"ats": "greenhouse", "slug": "beta", "source_priority": 1},
            ],
            "layer2_enterprise_json": {},
        }
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(seeds, tmp)
        tmp.close()

        fetched_by_slug = {
            slug: [
                {
                    "company": slug.title(), "company_slug": slug, "title": f"Role {index:03d}",
                    "source": "greenhouse", "source_type": "greenhouse", "source_id": f"greenhouse:{slug}",
                    "source_job_id": f"{slug}-{index:03d}", "source_priority": 1, "salary_min": 1, "salary_max": 1,
                }
                for index in range(60)
            ]
            for slug in ("alpha", "beta")
        }
        calls: dict[str, list[tuple[str, str]]] = {"companies": [], "jobs": []}
        rec = Recorder()

        class RecordingWriter:
            persistence_failed = False
            failed_writes = 0
            write_errors: list[str] = []

            async def sync_companies(self, _client, jobs):
                calls["companies"][:] = [(j["source_id"], j["source_job_id"]) for j in jobs]
                return {slug: f"company-{slug}" for slug in ("alpha", "beta")}

            async def sync_jobs_set_diff(self, _client, jobs, _company_map):
                calls["jobs"][:] = [(j["source_id"], j["source_job_id"]) for j in jobs]
                return {
                    "inserted": len(jobs), "updated": 0, "skipped_unchanged": 0, "expired": 0,
                    "failed_writes": 0, "persistence_failed": False, "write_errors": [],
                    "persisted_ids": [f"row-{i}" for i in range(len(jobs))],
                    "persisted_source_keys": [list(k) for k in calls["jobs"]],
                }

        async def fake_fetch(_client, _limiter, seed):
            return fetched_by_slug[seed["slug"]]

        try:
            with isolated(FAKE_ENV), patch.object(run_ingestion, "fetch_layer1_seed", side_effect=fake_fetch), \
                    patch.object(run_ingestion, "SupabaseSetDiffWriter", return_value=RecordingWriter()):
                report = asyncio.run(run_ingestion.run_master_ingestion(
                    sources=["greenhouse"], seeds_path=tmp.name, dry_run=False, max_rows=55,
                    transport=httpx.MockTransport(rec),
                ))
        finally:
            Path(tmp.name).unlink(missing_ok=True)

        expected = sorted(
            (job["source_id"], job["source_job_id"])
            for rows in fetched_by_slug.values()
            for job in rows
        )[:55]
        self.assertEqual(report["fetched"], 120)
        self.assertEqual(report["selected"], 55)
        self.assertEqual(report["skipped_by_cap"], 65)
        self.assertEqual(calls["companies"], expected)
        self.assertEqual(calls["jobs"], expected)
        self.assertEqual(rec.db_calls(), [])
        self.assertIs(report["dry_run"], False)
        self.assertEqual(report["persisted_counts"]["inserted"], 55)
        self.assertEqual(report["expiry_reports"], [])

    def test_engine_entrypoint_applies_cap_before_company_and_job_sync(self):
        seeds = {
            "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
            "layer1_public_ats": [{"ats": "greenhouse", "slug": "stripe", "source_priority": 1}],
            "layer2_enterprise_json": {},
        }
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(seeds, tmp)
        tmp.close()
        jobs = [
            {"company": "Stripe", "company_slug": "stripe", "title": f"Role {i:03d}",
             "source": "greenhouse", "source_type": "greenhouse", "source_id": "greenhouse:stripe",
             "source_job_id": f"stripe-{i:03d}", "source_priority": 1, "salary_min": 1, "salary_max": 1}
            for i in range(60)
        ]
        synced: dict[str, int] = {"companies": 0, "jobs": 0}

        class RecordingWriter:
            persistence_failed = False
            failed_writes = 0
            write_errors: list[str] = []

            async def sync_companies(self, _client, selected):
                synced["companies"] = len(selected)
                return {"stripe": "company-stripe"}

            async def sync_jobs_set_diff(self, _client, selected, _company_map):
                synced["jobs"] = len(selected)
                return {
                    "inserted": len(selected), "updated": 0, "skipped_unchanged": 0,
                    "failed_writes": 0, "persistence_failed": False, "write_errors": [],
                    "persisted_ids": [f"row-{i}" for i in range(len(selected))],
                    "persisted_source_keys": [[j["source_id"], j["source_job_id"]] for j in selected],
                }

        async def fake_fetch(_client, _limiter, _seed):
            return jobs

        rec = Recorder()
        try:
            with isolated(FAKE_ENV), patch.object(engine, "fetch_layer1_seed", side_effect=fake_fetch), \
                    patch.object(engine, "SupabaseSetDiffWriter", return_value=RecordingWriter()):
                report = asyncio.run(engine.run_ingestion(
                    seeds_path=tmp.name, dry_run=False, max_rows=55, transport=httpx.MockTransport(rec),
                ))
        finally:
            Path(tmp.name).unlink(missing_ok=True)

        self.assertEqual(report["fetched"], 60)
        self.assertEqual(report["selected"], 55)
        self.assertEqual(report["skipped_by_cap"], 5)
        self.assertEqual(synced, {"companies": 55, "jobs": 55})
        self.assertEqual(rec.db_calls(), [])
        self.assertEqual(report["persisted_counts"]["inserted"], 55)

    def test_partial_source_canary_never_queries_or_patches_for_expiry(self):
        seeds = {
            "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
            "layer1_public_ats": [{"ats": "smartrecruiters", "slug": "stripe", "source_priority": 1}],
            "layer2_enterprise_json": {},
        }
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(seeds, tmp)
        tmp.close()
        partial_job = {
            "source_type": "smartrecruiters", "source_id": "smartrecruiters:stripe",
            "source_job_id": "stripe-1", "company": "Stripe", "company_slug": "stripe",
            "title": "Engineer", "source_priority": 1,
        }
        rec = Recorder()

        class RecordingWriter:
            persistence_failed = False
            failed_writes = 0
            write_errors: list[str] = []

            async def sync_companies(self, _client, _jobs):
                return {"stripe": "company-stripe"}

            async def sync_jobs_set_diff(self, _client, selected, _company_map):
                return {
                    "inserted": len(selected), "updated": 0, "skipped_unchanged": 0,
                    "failed_writes": 0, "persistence_failed": False, "write_errors": [],
                    "persisted_ids": ["row-1"], "persisted_source_keys": [["smartrecruiters:stripe", "stripe-1"]],
                }

        async def fake_fetch(_client, _limiter, _seed):
            return [partial_job]

        try:
            with isolated(FAKE_ENV), patch.object(run_ingestion, "fetch_layer1_seed", side_effect=fake_fetch), \
                    patch.object(run_ingestion, "SupabaseSetDiffWriter", return_value=RecordingWriter()):
                report = asyncio.run(run_ingestion.run_master_ingestion(
                    sources=["smartrecruiters"], seeds_path=tmp.name, dry_run=False, max_rows=None,
                    allow_uncapped=True, no_expire=False, allow_expire=True,
                    transport=httpx.MockTransport(rec),
                ))
        finally:
            Path(tmp.name).unlink(missing_ok=True)

        self.assertFalse(report["sources"][0]["is_full_coverage"])
        self.assertEqual(report["expiry_reports"][0]["status"], "skipped_partial_coverage")
        self.assertEqual(rec.db_calls(), [])

    def test_expire_flag_runs_the_existing_full_coverage_expiry_path(self):
        seeds = {
            "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
            "layer1_public_ats": [{"ats": "greenhouse", "slug": "stripe", "source_priority": 1}],
            "layer2_enterprise_json": {},
        }
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(seeds, tmp)
        tmp.close()
        job = {
            "source_type": "greenhouse", "source_id": BOARD, "source_job_id": "stripe-101",
            "company": "Stripe", "company_slug": "stripe", "title": "Engineer", "source_priority": 1,
        }

        class ExpiryRecorder(Recorder):
            def __init__(self) -> None:
                super().__init__()
                self.requests: list[httpx.Request] = []

            def __call__(self, request: httpx.Request) -> httpx.Response:
                if request.url.host == FAKE_HOST and request.method == "GET" and request.url.path.endswith("/jobs"):
                    self.calls.append((request.method, request.url.host, request.url.path))
                    self.requests.append(request)
                    return httpx.Response(200, json=[{"id": "row-1"}], headers={"content-range": "0-0/1"})
                if request.url.host == FAKE_HOST and request.method == "PATCH" and request.url.path.endswith("/jobs"):
                    self.calls.append((request.method, request.url.host, request.url.path))
                    self.requests.append(request)
                    return httpx.Response(200, json=[{"id": "stale-row"}])
                return super().__call__(request)

        class RecordingWriter:
            persistence_failed = False
            failed_writes = 0
            write_errors: list[str] = []
            base_url = f"https://{FAKE_HOST}/rest/v1"
            headers = {"apikey": FAKE_KEY, "Authorization": f"Bearer {FAKE_KEY}"}

            async def sync_companies(self, _client, _jobs):
                return {"stripe": "company-stripe"}

            async def sync_jobs_set_diff(self, _client, selected, _company_map):
                return {
                    "inserted": len(selected), "updated": 0, "skipped_unchanged": 0,
                    "failed_writes": 0, "persistence_failed": False, "write_errors": [],
                    "persisted_ids": ["row-1"], "persisted_source_keys": [[BOARD, "stripe-101"]],
                }

        async def fake_fetch(_client, _limiter, _seed):
            return [job]

        rec = ExpiryRecorder()
        try:
            with isolated(FAKE_ENV), patch.object(run_ingestion, "fetch_layer1_seed", side_effect=fake_fetch), \
                    patch.object(run_ingestion, "SupabaseSetDiffWriter", return_value=RecordingWriter()):
                report = asyncio.run(run_ingestion.run_master_ingestion(
                    sources=[BOARD], seeds_path=tmp.name, dry_run=False, max_rows=None,
                    allow_uncapped=True, no_expire=False, allow_expire=True,
                    transport=httpx.MockTransport(rec),
                ))
        finally:
            Path(tmp.name).unlink(missing_ok=True)

        self.assertEqual(report["expiry_reports"][0]["status"], "completed", (report["expiry_reports"], rec.calls))
        self.assertEqual(report["expiry_reports"][0]["expired"], 1)
        self.assertEqual(report["db"]["expired"], 1)
        self.assertEqual([method for method, host, _ in rec.calls if host == FAKE_HOST], ["GET", "PATCH"])
        baseline_req, expiry_req = rec.requests
        self.assertEqual(baseline_req.url.params["source_id"], f"eq.{BOARD}")
        self.assertEqual(expiry_req.url.params["source_id"], f"eq.{BOARD}")
        cutoff = expiry_req.url.params["last_seen_at"].removeprefix("lt.")
        parsed_cutoff = datetime.fromisoformat(cutoff)
        self.assertIsNotNone(parsed_cutoff.tzinfo)
        self.assertIn("%2B00%3A00", str(expiry_req.url))

    def test_expiry_http_errors_invalid_responses_and_exceptions_fail_cli(self):
        seeds = {
            "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
            "layer1_public_ats": [{"ats": "greenhouse", "slug": "stripe", "source_priority": 1}],
            "layer2_enterprise_json": {},
        }
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(seeds, tmp)
        tmp.close()
        job = {
            "source_type": "greenhouse", "source_id": BOARD, "source_job_id": "stripe-101",
            "company": "Stripe", "company_slug": "stripe", "title": "Engineer", "source_priority": 1,
        }

        class RecordingWriter:
            persistence_failed = False
            failed_writes = 0
            write_errors: list[str] = []
            base_url = f"https://{FAKE_HOST}/rest/v1"
            headers = {"apikey": FAKE_KEY, "Authorization": f"Bearer {FAKE_KEY}"}

            async def sync_companies(self, _client, _jobs):
                return {"stripe": "company-stripe"}

            async def sync_jobs_set_diff(self, _client, selected, _company_map):
                return {
                    "inserted": len(selected), "updated": 0, "skipped_unchanged": 0,
                    "failed_writes": 0, "persistence_failed": False, "write_errors": [],
                    "persisted_ids": ["row-1"], "persisted_source_keys": [[BOARD, "stripe-101"]],
                }

        async def fake_fetch(_client, _limiter, _seed):
            return [job]

        scenarios = [
            ("HTTP 400", httpx.Response(400, json={"error": "bad filter"})),
            ("HTTP 500", httpx.Response(500, json={"error": "database unavailable"})),
            ("malformed JSON", httpx.Response(200, content=b"not-json", headers={"content-type": "application/json"})),
            ("wrong response shape", httpx.Response(200, json={"id": "stale-row"})),
            ("transport exception", RuntimeError("connection dropped")),
        ]
        try:
            for label, patch_result in scenarios:
                def respond(request: httpx.Request) -> httpx.Response:
                    if request.url.host == FAKE_HOST and request.method == "GET":
                        return httpx.Response(200, json=[{"id": "row-1"}], headers={"content-range": "0-0/1"})
                    if request.url.host == FAKE_HOST and request.method == "PATCH":
                        if isinstance(patch_result, Exception):
                            raise patch_result
                        return patch_result
                    return Recorder()(request)

                with self.subTest(scenario=label), isolated(FAKE_ENV), \
                        patch.object(run_ingestion, "fetch_layer1_seed", side_effect=fake_fetch), \
                        patch.object(run_ingestion, "SupabaseSetDiffWriter", return_value=RecordingWriter()):
                    report = asyncio.run(run_ingestion.run_master_ingestion(
                        sources=[BOARD], seeds_path=tmp.name, dry_run=False, max_rows=None,
                        allow_uncapped=True, no_expire=False, allow_expire=True,
                        transport=httpx.MockTransport(respond),
                    ))
                    self.assertEqual(report["expiry_reports"][0]["status"], "failed", report.get("sources"))
                    _fake_run, code, err = run_cli(
                        run_ingestion, ["--max-rows", "10"], "run_master_ingestion", report,
                    )
                    self.assertEqual(code, 1)
                    self.assertIn("expiry", err.lower())
        finally:
            Path(tmp.name).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
