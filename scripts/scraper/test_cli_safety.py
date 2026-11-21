"""Zero-write safety tests for both Python ingestion CLIs (engine.py, run_ingestion.py).

No network, no database, no real .env: dotenv loading is stubbed, credentials are fake, every HTTP call goes
through a recording MockTransport, and SupabaseSetDiffWriter explodes if it is ever constructed.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import os
import sys
import unittest
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


def run_cli(module, argv: list[str], target: str):
    """Runs module.main() with argv, the run function replaced by a recording AsyncMock."""
    fake_run = AsyncMock(return_value={})
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
            with self.subTest(cli=module.__name__), isolated(FAKE_ENV):
                fake_run, code, err = run_cli(module, [], target)
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
                fake_run, _, _ = run_cli(module, [engine.WRITE_FLAG], target)
                self.assertIs(fake_run.call_args.kwargs["dry_run"], False)

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


class DryRunZeroWriteTests(unittest.TestCase):
    def test_run_master_dry_run_with_credentials_never_writes_and_stays_on_one_board(self):
        rec = Recorder()
        jobspy = AsyncMock(side_effect=AssertionError("layer3 must not run for an exact board"))
        with isolated(FAKE_ENV):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                sources=[BOARD], dry_run=True, transport=httpx.MockTransport(rec), jobspy_scrape_fn=jobspy))
        self.assertEqual(rec.db_calls(), [])
        self.assertEqual(report["sources_requested"], [BOARD])
        self.assertEqual({(m, h) for m, h, _ in rec.calls}, {("GET", "boards-api.greenhouse.io")})
        self.assertEqual(len(rec.calls), 1, rec.calls)  # exactly one board fetched
        self.assertEqual([s["source"] for s in report["sources"]], [BOARD])
        self.assertEqual(report["db"]["expired"], 0)
        self.assertEqual(report["expiry_reports"], [])
        jobspy.assert_not_called()

    def test_exact_board_filter_is_case_and_space_insensitive_but_never_expands(self):
        rec = Recorder()
        with isolated(FAKE_ENV):
            report = asyncio.run(run_ingestion.run_master_ingestion(
                sources=["  GreenHouse:Stripe "], dry_run=True, transport=httpx.MockTransport(rec)))
        self.assertEqual([s["source"] for s in report["sources"]], [BOARD])
        self.assertEqual(len(rec.calls), 1)

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


if __name__ == "__main__":
    unittest.main()
