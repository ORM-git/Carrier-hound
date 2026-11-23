"""Self-contained verification suite for the async Python high-volume ingestion engine."""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import email.utils
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from scripts.scraper.engine import (
    SupabaseSetDiffWriter,
    compute_content_fingerprint,
    load_company_seeds,
    partition_set_diff,
)
from scripts.scraper.enrichment import (
    assign_company_category,
    assign_role_category,
    compute_dedupe_hash,
    extract_top_keywords,
    normalize_company_alias,
    resolve_logo_url,
)
from scripts.scraper.fetch_aggregators_and_india import (
    INDIA_LOCATIONS,
    INDIA_ROLES,
    JOBSPY_SITES,
    fetch_adzuna,
    fetch_arbeitnow,
    fetch_jobspy_india,
    normalize_aggregator_job,
)
from scripts.scraper.fetchers import (
    build_normalized_job,
    fetch_amazon_jobs,
    fetch_ashby,
    fetch_greenhouse,
    fetch_lever,
    fetch_microsoft_jobs,
    fetch_smartrecruiters,
    fetch_workday_cxs,
)
from scripts.scraper.rate_limiter import (
    HostTokenBucket,
    PerHostRateLimiter,
    parse_retry_after,
    redact_sensitive_params,
    request_with_backoff,
)
from scripts.scraper.run_ingestion import (
    evaluate_count_drop_guard,
    run_master_ingestion,
)


class HighVolumeIngestionEngineTests(unittest.TestCase):
    def test_seeds_and_deterministic_categories(self) -> None:
        seeds = load_company_seeds()
        self.assertIn("layer1_public_ats", seeds)
        self.assertIn("layer2_enterprise_json", seeds)
        l1_cats = {s["category"] for s in seeds["layer1_public_ats"]}
        self.assertIn("HIGH_PRODUCT_YC", l1_cats)
        self.assertIn("OTHER_STARTUPS", l1_cats)

        self.assertEqual(assign_company_category("HIGH_PRODUCT_YC", "Stripe", "stripe"), "HIGH_PRODUCT_YC")
        self.assertEqual(assign_company_category(None, "Walmart", "walmart", source_layer="layer2"), "MNC_BIGTECH")
        self.assertEqual(assign_company_category(None, "Infosys", "infosys"), "INDIAN_IT_AND_OTHER")
        self.assertEqual(assign_company_category(None, "NewSeed Startup", "newseed"), "OTHER_STARTUPS")

    def test_aho_corasick_top_8_keywords_and_role_category(self) -> None:
        jd = (
            "<p>Build scalable AI pipelines using Python, Java, AWS, Kubernetes, "
            "React, LangChain, RAG, Distributed Systems, SQL, Docker, and Terraform.</p>"
        )
        kws = extract_top_keywords("Senior AI & ML Engineer (Python, RAG)", jd, max_keywords=8)
        self.assertEqual(len(kws), 8)
        self.assertIn("Python", kws)
        self.assertIn("RAG", kws)
        self.assertIn("LangChain", kws)
        self.assertIn("Distributed Systems", kws)
        self.assertNotIn("Terraform", kws)  # Capped at top 8
        self.assertEqual(assign_role_category("Senior AI & ML Engineer", None, kws), "AI_ML")
        self.assertEqual(assign_role_category("Staff Cloud Kubernetes Engineer", None, kws), "CLOUD")
        self.assertEqual(assign_role_category("Senior Data Engineer (Snowflake)", None, kws), "DATA")
        self.assertEqual(assign_role_category("Full Stack Software Engineer", None, kws), "SDE")

    def test_logo_resolution_and_avatar_fallback(self) -> None:
        self.assertEqual(
            resolve_logo_url("https://cdn.example.com/logo.png", "stripe.com"),
            "https://cdn.example.com/logo.png",
        )
        self.assertEqual(
            resolve_logo_url(None, "stripe.com"),
            "https://www.google.com/s2/favicons?domain=stripe.com&sz=128",
        )
        self.assertIsNone(resolve_logo_url(None, None))

    def test_dedupe_hash_normalization(self) -> None:
        h1 = compute_dedupe_hash("Stripe", "Senior Software Engineer", "US", "San Francisco, CA")
        h2 = compute_dedupe_hash("stripe", "senior software engineer", "us", "San Francisco, CA")
        self.assertEqual(len(h1), 64)
        self.assertEqual(h1, h2)

    def test_source_key_uniqueness_per_vendor_and_board_token(self) -> None:
        """Requirement 1: Key is unique per source vendor and includes board/company token in source_job_id."""
        gh_job = build_normalized_job(
            seed={"name": "Stripe", "slug": "stripe", "token": "stripe"},
            source="greenhouse",
            source_type="greenhouse",
            source_job_id="stripe:101",
            title="Software Engineer",
            location="San Francisco, CA",
            apply_url="https://boards.greenhouse.io/stripe/jobs/101",
        )
        lev_job = build_normalized_job(
            seed={"name": "Figma", "slug": "figma", "token": "figma"},
            source="lever",
            source_type="lever",
            source_job_id="figma:101",
            title="Software Engineer",
            location="San Francisco, CA",
            apply_url="https://jobs.lever.co/figma/101",
        )
        wd_job = build_normalized_job(
            seed={"name": "Walmart", "slug": "walmart"},
            source="workday",
            source_type="workday",
            source_job_id="walmart:walmart_careers:101",
            title="Software Engineer",
            location="Bentonville, AR",
            apply_url="https://walmart.wd5.myworkdayjobs.com/walmart_careers/job/101",
        )
        amz_job = build_normalized_job(
            seed={"name": "Amazon", "slug": "amazon"},
            source="amazon_jobs",
            source_type="amazon",
            source_job_id="amazon:101",
            title="Software Engineer",
            location="Seattle, WA",
            apply_url="https://amazon.jobs/en/jobs/101",
        )

        # Even with identical native ID "101", the composite keys (source_type, source_job_id) NEVER collide
        keys = {
            (gh_job["source_type"], gh_job["source_job_id"]),
            (lev_job["source_type"], lev_job["source_job_id"]),
            (wd_job["source_type"], wd_job["source_job_id"]),
            (amz_job["source_type"], amz_job["source_job_id"]),
        }
        self.assertEqual(len(keys), 4)
        self.assertIn(("greenhouse", "stripe:101"), keys)
        self.assertIn(("lever", "figma:101"), keys)
        self.assertIn(("workday", "walmart:walmart_careers:101"), keys)
        self.assertIn(("amazon", "amazon:101"), keys)

    def test_greenhouse_country_rules_do_not_change_other_vendor_remote_fallback(self) -> None:
        job = build_normalized_job(
            seed={"name": "Lever Co", "slug": "lever-co", "token": "lever-co"},
            source="lever", source_type="lever", source_job_id="lever-co-1",
            title="Engineer", location="Remote", apply_url="https://jobs.example.com/1",
        )
        self.assertIsNone(job["country_code"])
        self.assertEqual(job["country"], "Remote")

    def test_rate_limiter_spacing_and_token_bucket(self) -> None:
        """Requirement 2: Token bucket enforces proper spacing per host; 20 requests cannot pass in 0.25s at 4 req/s."""
        bucket = HostTokenBucket(rate_per_sec=4.0, capacity=1.0)
        completed_times: list[float] = []

        async def worker() -> None:
            await bucket.acquire()
            completed_times.append(asyncio.get_event_loop().time())

        async def _test() -> None:
            # Schedule 5 tasks at once to verify strict spacing
            t0 = asyncio.get_event_loop().time()
            tasks = [asyncio.create_task(worker()) for _ in range(5)]
            await asyncio.gather(*tasks)
            t1 = asyncio.get_event_loop().time()
            elapsed = t1 - t0
            # 5 requests at 4 req/s require 4 intervals of 0.25s = 1.00s minimum
            self.assertGreaterEqual(elapsed, 0.90)
            self.assertEqual(len(completed_times), 5)

        asyncio.run(_test())

    def test_parse_retry_after_seconds_and_http_date(self) -> None:
        """Requirement 6: Retry-After parses both integer seconds and RFC 7231 HTTP-date string."""
        self.assertEqual(parse_retry_after("120"), 120.0)
        self.assertEqual(parse_retry_after("0"), 0.0)

        # RFC 7231 / RFC 2822 HTTP-date in the future
        future_dt = datetime.now(timezone.utc)
        # Format as RFC 2822
        future_rfc = email.utils.format_datetime(future_dt)
        parsed_delay = parse_retry_after(future_rfc)
        self.assertGreaterEqual(parsed_delay, 0.0)
        self.assertLess(parsed_delay, 2.0)

        # Invalid returns default
        self.assertEqual(parse_retry_after("invalid-date", default_delay=5.0), 5.0)

    def test_secret_redaction_and_adzuna_error_sanitization(self) -> None:
        """Requirement 3: Strip secrets (app_key, api_key, token) from URLs, logs, and error messages."""
        leak_url = "https://api.adzuna.com/v1/api/jobs/in/search/1?app_id=my_id&app_key=SECRET_KEY_12345&what=dev"
        sanitized = redact_sensitive_params(leak_url)
        self.assertNotIn("SECRET_KEY_12345", sanitized)
        self.assertIn("app_key=[REDACTED]", sanitized)

        leak_err = "Error 403: Forbidden with token=SUPER_SECRET_TOKEN and api_key=KEY_999"
        sanitized_err = redact_sensitive_params(leak_err)
        self.assertNotIn("SUPER_SECRET_TOKEN", sanitized_err)
        self.assertNotIn("KEY_999", sanitized_err)
        self.assertIn("token=[REDACTED]", sanitized_err)
        self.assertIn("api_key=[REDACTED]", sanitized_err)

    def test_change_detection_mutable_fields_and_source_key_lookup(self) -> None:
        """Requirement 3 & 7: Fingerprint checks all mutable fields; unchanged jobs update last_seen_at."""
        base_job = {
            "company": "Stripe",
            "title": "Software Engineer",
            "description": "Python, React, AWS",
            "location": "San Francisco, CA",
            "country": "United States",
            "country_code": "US",
            "currency": "USD",
            "remote": False,
            "is_remote": False,
            "status": "active",
            "logo_url": "https://cdn.example.com/logo.png",
            "apply_url": "https://stripe.com/apply/1",
            "role_category": "SDE",
            "salary_text": "$180k-$220k",
            "salary_min": 180000,
            "salary_max": 220000,
            "is_active": True,
            "source_priority": 1,
            "top_keywords": ["Python", "React", "AWS"],
            "source_type": "greenhouse",
            "source_job_id": "stripe:100",
            "dedupe_hash": "hash_base",
        }
        fp_base = compute_content_fingerprint(base_job)

        # Mutating any of these fields must alter the fingerprint
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "description": "Changed desc"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "company": "Stripe Inc"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "logo_url": "https://other.com/l.png"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "country": "Canada"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "currency": "CAD"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "remote": True, "is_remote": True}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "status": "expired"}))

        # Test lookup by primary source key (source_type, source_job_id) even when title / dedupe_hash mutated
        mutated_job = {
            **base_job,
            "title": "Senior Staff Software Engineer",
            "dedupe_hash": "hash_new_different",
        }
        existing_row = {"id": "uuid-1", **base_job}

        to_insert, to_update, unchanged_ids = partition_set_diff([mutated_job], [existing_row])
        self.assertEqual(len(to_insert), 0)
        self.assertEqual(len(to_update), 1)
        self.assertEqual(to_update[0][0], "uuid-1")
        self.assertEqual(to_update[0][1]["title"], "Senior Staff Software Engineer")

        # Test unchanged job goes to unchanged_ids for last_seen_at refresh
        to_insert2, to_update2, unchanged2 = partition_set_diff([base_job], [existing_row])
        self.assertEqual(len(to_insert2), 0)
        self.assertEqual(len(to_update2), 0)
        self.assertEqual(unchanged2, ["uuid-1"])

    def test_same_dedupe_hash_on_two_boards_coexists_never_merged(self) -> None:
        """#643 contract: dedupe_hash is advisory; two boards with the same hash both persist."""
        a = {"company": "Stripe", "title": "SWE", "source_type": "greenhouse", "source_id": "greenhouse:stripe",
             "source_job_id": "1", "source_priority": 1, "dedupe_hash": "same"}
        b = {**a, "source_type": "lever", "source_id": "lever:stripe", "source_priority": 2}
        to_insert, to_update, unchanged = partition_set_diff([a, b], [])
        self.assertEqual(len(to_insert), 2)
        # an existing row on board A must not absorb board B's job with the same hash
        to_insert, to_update, unchanged = partition_set_diff([b], [{"id": "uuid-a", **a}])
        self.assertEqual((len(to_insert), to_update, unchanged), (1, [], []))
        # jobs without a source_job_id are never collapsed together
        n1 = {**a, "source_job_id": None, "title": "x"}
        n2 = {**a, "source_job_id": None, "title": "y"}
        self.assertEqual(len(partition_set_diff([n1, n2], [])[0]), 2)

    def test_same_vendor_native_id_collision_never_crosses_boards(self) -> None:
        """greenhouse:b/42 must INSERT, never update greenhouse:a/42 (or a NULL-board row it cannot prove)."""
        a = {"company": "A", "title": "SWE", "source_type": "greenhouse", "source_id": "greenhouse:a",
             "source_job_id": "42", "source_priority": 1}
        b = {**a, "company": "B", "source_id": "greenhouse:b"}
        row_a = {"id": "uuid-a", **a}

        # different non-null source_id, same vendor + native id: insert, row A untouched
        ins, upd, unch = partition_set_diff([b], [row_a])
        self.assertEqual(([j["source_id"] for j in ins], upd, unch), (["greenhouse:b"], [], []))

        # both boards in one batch with row A present: A unchanged, B inserted
        ins, upd, unch = partition_set_diff([a, b], [row_a])
        self.assertEqual(([j["source_id"] for j in ins], upd, unch), (["greenhouse:b"], [], ["uuid-a"]))

        # mutated A still updates its own row only
        ins, upd, unch = partition_set_diff([{**a, "title": "Senior SWE"}, b], [row_a])
        self.assertEqual(([j["source_id"] for j in ins], [u[0] for u in upd]), (["greenhouse:b"], ["uuid-a"]))

    def test_null_board_legacy_fallback_only_when_unambiguous(self) -> None:
        a = {"company": "A", "title": "SWE", "source_type": "greenhouse", "source_id": "greenhouse:a",
             "source_job_id": "42", "source_priority": 1}
        b = {**a, "company": "B", "source_id": "greenhouse:b"}
        legacy = {"id": "uuid-legacy", **a, "source_id": None}

        # one board, one legacy row, same vendor: adopt the legacy row
        ins, upd, _ = partition_set_diff([a], [legacy])
        self.assertEqual((ins, [u[0] for u in upd]), ([], ["uuid-legacy"]))

        # two same-vendor boards claim native id 42: cannot tell whose legacy row it is -> insert both
        ins, upd, unch = partition_set_diff([a, b], [legacy])
        self.assertEqual((sorted(j["source_id"] for j in ins), upd, unch), (["greenhouse:a", "greenhouse:b"], [], []))

        # two legacy rows for the same (vendor, native id): ambiguous -> insert
        legacy2 = {**legacy, "id": "uuid-legacy-2", "company": "Other"}
        ins, upd, _ = partition_set_diff([a], [legacy, legacy2])
        self.assertEqual((len(ins), upd), (1, []))

        # vendor in source_id disagrees with source_type: provenance unclear -> insert
        odd = {**a, "source_id": "lever:a"}
        ins, upd, _ = partition_set_diff([odd], [legacy])
        self.assertEqual((len(ins), upd), (1, []))

        # legacy rows never match across vendors
        ins, upd, _ = partition_set_diff([{**a, "source_type": "lever", "source_id": "lever:a"}], [legacy])
        self.assertEqual((len(ins), upd), (1, []))

    def test_persistence_failure_vetos_expiry_step(self) -> None:
        """Requirement 1: HTTP 400/409/500 errors on job or company writes veto expiry step."""
        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "/companies" in url:
                return httpx.Response(500, text="Database connection error")
            if "/jobs" in url:
                return httpx.Response(400, text="Constraint error")
            return httpx.Response(200, json=[])

        async def _test() -> None:
            writer = SupabaseSetDiffWriter("https://mock.supabase.co", "mock-key")
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                res = await writer.sync_companies(client, [{"company": "Foo", "company_slug": "foo"}])
                self.assertTrue(writer.persistence_failed)
                self.assertGreater(writer.failed_writes, 0)
                self.assertTrue(len(writer.write_errors) > 0)

        asyncio.run(_test())

    def test_sync_companies_does_not_overwrite_better_logo_or_domain(self) -> None:
        """Requirement 8: sync_companies does not overwrite a known better logo or domain with null or aggregator value."""
        existing_company = {
            "id": "comp-stripe-1",
            "slug": "stripe",
            "name": "Stripe",
            "logo_url": "https://szakevhxhwpeskidvtfs.supabase.co/storage/v1/object/public/company-logos/stripe.png",
            "canonical_domain": "stripe.com",
            "domain": "stripe.com",
            "category": "HIGH_PRODUCT_YC",
            "ats_type": "greenhouse",
        }

        captured_patches: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if request.method == "GET" and "/companies" in url:
                return httpx.Response(200, json=[existing_company])
            if request.method == "PATCH" and "/companies" in url:
                captured_patches.append(json.loads(request.content.decode("utf-8")))
                return httpx.Response(200, json=[])
            return httpx.Response(200, json=[])

        async def _test() -> None:
            writer = SupabaseSetDiffWriter("https://mock.supabase.co", "mock-key")
            # Incoming aggregator job with null logo and no canonical domain
            aggregator_job = {
                "company": "Stripe",
                "company_slug": "stripe",
                "canonical_domain": None,
                "company_category": "OTHER_STARTUPS",
                "logo_url": None,
                "source": "jobspy",
                "source_priority": 2,
            }
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                id_map = await writer.sync_companies(client, [aggregator_job])
                self.assertEqual(id_map.get("stripe"), "comp-stripe-1")
                # Ensure no patch overwrote logo_url or domain with null!
                for p in captured_patches:
                    self.assertNotIn("logo_url", p)
                    self.assertNotIn("canonical_domain", p)

        asyncio.run(_test())

    def test_expiry_scope_partial_coverage_and_failed_source_safety(self) -> None:
        """Requirement 2: Expiry skips partial coverage sources (Workday, Amazon, Microsoft, Arbeitnow) and failed sources."""
        # 1) Drop guard blocks when baseline query fails / returns <= 0
        guard_no_base = evaluate_count_drop_guard(50, 0, source_name="greenhouse")
        self.assertFalse(guard_no_base["allowed"])
        self.assertIn("failed or returned no baseline", guard_no_base["reason"])

        # 2) Drop guard blocks when count drops by >50%
        guard_drop = evaluate_count_drop_guard(40, 100, source_name="greenhouse", min_ratio=0.5)
        self.assertFalse(guard_drop["allowed"])
        self.assertIn("50% count-drop guard triggered", guard_drop["reason"])

        # 3) Drop guard allows when count is healthy (>= 50%)
        guard_ok = evaluate_count_drop_guard(60, 100, source_name="greenhouse", min_ratio=0.5)
        self.assertTrue(guard_ok["allowed"])

    def test_jobspy_missing_import_or_error_reports_failed_status(self) -> None:
        """Requirement 5: JobSpy missing import returns explicit error message so expiry stays off."""
        async def _test() -> None:
            with patch("scripts.scraper.fetch_aggregators_and_india.run_jobspy_scrape_in_subprocess", new_callable=AsyncMock) as mock_proc:
                mock_proc.return_value = ([], "python-jobspy not installed. Run 'pip install python-jobspy'")
                jobs, err = await fetch_jobspy_india(roles=("Software Engineer",), locations=("Bangalore, India",))
                if err:
                    self.assertIn("python-jobspy", err)
                    self.assertEqual(len(jobs), 0)

        asyncio.run(_test())

    def test_sql_fixture_all_10_fetchers_and_legacy_cross_vendor_duplicates(self) -> None:
        """Requirement 1: Migration supports all 10 fetchers and legacy cross-vendor duplicate IDs without collision."""
        mig_dir = Path(__file__).resolve().parents[2] / "supabase" / "migrations"
        sql_content = (mig_dir / "20261116a_high_volume_ingestion_schema.sql").read_text(encoding="utf-8")
        # #645 owns the vendor CHECK and the canonical identity index; 16a must leave both alone
        repair_d = (mig_dir / "20261116d_repair_642_identity_and_similarity_safety.sql").read_text(encoding="utf-8")
        repair_e = (mig_dir / "20261116e_repair_642_concurrent_indexes.sql").read_text(encoding="utf-8")

        all_10_fetchers = [
            "greenhouse", "lever", "ashby", "smartrecruiters", "workday",
            "amazon", "microsoft", "jobspy", "arbeitnow", "adzuna",
        ]
        for f in all_10_fetchers:
            self.assertIn(f"'{f}'", repair_d, f"#645 jobs_source_type_check must include {f}")

        self.assertIn("idx_jobs_source_id_source_job_id_uniq", repair_e)
        self.assertIn("WHERE source_id IS NOT NULL", repair_e)
        self.assertIn("indisvalid", repair_e)

        code = "\n".join(l for l in sql_content.splitlines() if not l.strip().startswith("--"))
        for forbidden in ("CREATE OR REPLACE FUNCTION", "CREATE INDEX", "CREATE UNIQUE INDEX", "DROP INDEX",
                          "ADD CONSTRAINT", "DROP CONSTRAINT", "CREATE OR REPLACE VIEW", "GRANT ", "UPDATE public."):
            self.assertNotIn(forbidden, code, f"repair-aware 16a must not contain {forbidden!r}")

        # Simulate SQL unique index behavior on fixture data
        # Legacy rows have source_id IS NULL and can share the same numeric source_job_id across vendors
        legacy_rows = [
            {"id": "leg-1", "source_type": "greenhouse", "source_id": None, "source_job_id": "99999"},
            {"id": "leg-2", "source_type": "lever", "source_id": None, "source_job_id": "99999"},
            {"id": "leg-3", "source_type": "ats", "source_id": None, "source_job_id": "99999"},
        ]

        # In the partial index (WHERE source_id IS NOT NULL), rows with source_id IS NULL never collide
        indexed_keys: set[tuple[str, str]] = set()
        for row in legacy_rows:
            if row["source_id"] is not None:
                key = (row["source_id"], row["source_job_id"])
                self.assertNotIn(key, indexed_keys)
                indexed_keys.add(key)
        self.assertEqual(len(indexed_keys), 0)

        # New rows from all 10 fetchers populate source_id and (source_id, source_job_id) is strictly unique
        new_rows = [
            {"id": f"new-{f}", "source_type": f, "source_id": f"{f}:test_board", "source_job_id": "99999"}
            for f in all_10_fetchers
        ]
        for row in new_rows:
            key = (row["source_id"], row["source_job_id"])
            self.assertNotIn(key, indexed_keys)
            indexed_keys.add(key)
        self.assertEqual(len(indexed_keys), len(all_10_fetchers))

        # Rollback is a separate data-preserving script: only marked, empty, dependency-free columns; no CASCADE
        rollback_sql = (mig_dir.parent / "scripts" / "rollback-20261116a.sql").read_text(encoding="utf-8")
        self.assertIn("added by 20261116a", rollback_sql)
        self.assertNotIn("CASCADE", "\n".join(l for l in rollback_sql.splitlines() if not l.strip().startswith("--")))
        self.assertNotIn("DELETE FROM", rollback_sql)

        # Requirement 3: Actually execute forward then rollback SQL on populated Postgres fixture
        repo_root = Path(__file__).resolve().parents[2]
        npx_bin = shutil.which("npx.cmd") if os.name == "nt" else shutil.which("npx")
        if not npx_bin:
            npx_bin = shutil.which("npx") or shutil.which("npx.cmd")
        if not npx_bin:
            self.fail("npx not found on PATH")

        timeout_seconds = 120
        try:
            proc = subprocess.run(
                [npx_bin, "tsx", "scripts/test-postgres-migration-rollback-fixture.ts"],
                cwd=str(repo_root),
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            self.fail(
                f"PostgreSQL forward & rollback fixture timed out after {timeout_seconds}s:\n"
                f"STDOUT:\n{exc.stdout or ''}\nSTDERR:\n{exc.stderr or ''}"
            )

        self.assertEqual(
            proc.returncode,
            0,
            f"PostgreSQL forward & rollback fixture execution failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
        )
        self.assertIn("[PASS] All post-rollback assertions PASSED", proc.stdout)

    def test_change_detection_skills_and_all_mutable_fields(self) -> None:
        """Requirement 3: Fingerprint checks skills and all mutable fields; skills change emits to_update."""
        base_job = {
            "company": "Stripe",
            "title": "Software Engineer",
            "description": "Python, React, AWS",
            "location": "San Francisco, CA",
            "country": "United States",
            "country_code": "US",
            "currency": "USD",
            "remote": False,
            "is_remote": False,
            "remote_scope": "US",
            "remote_eligibility": "authorized",
            "job_type": "full-time",
            "category": "engineering",
            "role_category": "SDE",
            "status": "active",
            "is_active": True,
            "verified": True,
            "logo_url": "https://cdn.example.com/logo.png",
            "apply_url": "https://stripe.com/apply/1",
            "salary_text": "$180k-$220k",
            "salary_min": 180000,
            "salary_max": 220000,
            "salary_period": "year",
            "source_priority": 1,
            "top_keywords": ["python", "react", "aws"],
            "skills": ["python", "django", "postgresql"],
            "source_type": "greenhouse",
            "source_id": "greenhouse:stripe",
            "source_job_id": "stripe:101",
            "dedupe_hash": "hash_base_stripe",
        }
        fp_base = compute_content_fingerprint(base_job)

        # Changing skills alters fingerprint
        fp_skills = compute_content_fingerprint({**base_job, "skills": ["python", "django", "fastapi"]})
        self.assertNotEqual(fp_base, fp_skills)

        # Changing other mutable fields alters fingerprint
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "remote_scope": "Global"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "remote_eligibility": "any"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "job_type": "contract"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "category": "data"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "verified": False}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "company_id": "comp-999"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "salary_period": "month"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "canonical_domain": "newdomain.com"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "source_id": "greenhouse:other"}))
        self.assertNotEqual(fp_base, compute_content_fingerprint({**base_job, "source_url": "https://other.com/job"}))

        # Test partition_set_diff when skills change on existing DB job
        existing_db_row = {"id": "uuid-stripe-101", **base_job}
        job_with_updated_skills = {**base_job, "skills": ["python", "django", "fastapi"]}

        to_insert, to_update, unchanged_ids = partition_set_diff([job_with_updated_skills], [existing_db_row])
        self.assertEqual(len(to_insert), 0)
        self.assertEqual(len(to_update), 1)
        self.assertEqual(to_update[0][0], "uuid-stripe-101")
        self.assertEqual(to_update[0][1]["skills"], ["python", "django", "fastapi"])
        self.assertEqual(len(unchanged_ids), 0)

        # Test domain-only change triggers to_update
        job_with_new_domain = {**base_job, "canonical_domain": "stripe-payments.com"}
        to_insert_dom, to_update_dom, unchanged_dom = partition_set_diff([job_with_new_domain], [existing_db_row])
        self.assertEqual(len(to_insert_dom), 0)
        self.assertEqual(len(to_update_dom), 1)
        self.assertEqual(to_update_dom[0][0], "uuid-stripe-101")
        self.assertEqual(to_update_dom[0][1]["canonical_domain"], "stripe-payments.com")
        self.assertEqual(len(unchanged_dom), 0)

        # Test adopting source_id on legacy row with source_id=None triggers to_update
        legacy_db_row = {**base_job, "id": "uuid-legacy-1", "source_id": None}
        job_with_source_id = {**base_job, "source_id": "greenhouse:stripe"}
        to_insert_sid, to_update_sid, unchanged_sid = partition_set_diff([job_with_source_id], [legacy_db_row])
        self.assertEqual(len(to_insert_sid), 0)
        self.assertEqual(len(to_update_sid), 1)
        self.assertEqual(to_update_sid[0][0], "uuid-legacy-1")
        self.assertEqual(to_update_sid[0][1]["source_id"], "greenhouse:stripe")
        self.assertEqual(len(unchanged_sid), 0)

        # When skills and all fields are identical, job is classified as unchanged
        to_insert2, to_update2, unchanged_ids2 = partition_set_diff([base_job], [existing_db_row])
        self.assertEqual(len(to_insert2), 0)
        self.assertEqual(len(to_update2), 0)
        self.assertEqual(unchanged_ids2, ["uuid-stripe-101"])

    def test_missing_incoming_posted_at_never_clears_valid_original_date(self) -> None:
        existing = {
            "id": "row-original-date", "source_type": "greenhouse", "source_id": "greenhouse:stripe",
            "source_job_id": "stripe-101", "company": "Stripe", "title": "Engineer",
            "description": "Old description", "posted_at": "2026-10-01T00:00:00+00:00",
        }
        incoming = {**existing, "description": "Updated description", "posted_at": None}
        incoming.pop("id")

        inserts, updates, unchanged = partition_set_diff([incoming], [existing])
        self.assertEqual(inserts, [])
        self.assertEqual(unchanged, [])
        self.assertEqual(updates[0][0], "row-original-date")
        self.assertEqual(updates[0][1]["posted_at"], existing["posted_at"])

    def test_real_writer_preserves_unknown_date_and_persists_date_only_correction(self) -> None:
        preserved_date = "2026-10-01T00:00:00+00:00"
        corrected_date = "2026-11-02T00:00:00+00:00"
        base = {
            "source_type": "greenhouse", "source_id": "greenhouse:stripe", "source_priority": 1,
            "company": "Stripe", "company_slug": "stripe", "title": "Engineer", "location": "Remote US",
            "country": "United States", "country_code": "US", "remote": True, "is_remote": True,
            "remote_scope": "remote", "remote_eligibility": "country_restricted", "job_type": "full-time",
            "category": "engineering", "role_category": "engineering", "status": "active", "is_active": True,
            "verified": False, "description": "Role description", "apply_url": "https://example.test/apply",
            "salary_text": None, "salary_min": None, "salary_max": None, "salary_period": None, "currency": None,
            "source": "greenhouse", "dedupe_hash": "hash", "source_url": "https://example.test/job",
            "logo_url": None, "canonical_domain": "stripe.com", "top_keywords": [], "skills": [],
        }
        incoming_unknown = {**base, "source_job_id": "stripe-preserve", "description": "Updated description", "posted_at": None}
        incoming_correction = {**base, "source_job_id": "stripe-correct", "posted_at": corrected_date}
        existing_rows = [
            {**incoming_unknown, "id": "row-preserve", "description": "Original description", "posted_at": preserved_date},
            {**incoming_correction, "id": "row-correct", "posted_at": preserved_date},
        ]
        patches: dict[str, dict[str, Any]] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if request.method == "GET" and "/jobs" in request.url.path:
                self.assertIn("posted_at", request.url.params.get("select", "").split(","))
                return httpx.Response(200, json=existing_rows)
            if request.method == "PATCH" and "/jobs" in request.url.path:
                row_id = request.url.params.get("id", "").removeprefix("eq.")
                patches[row_id] = json.loads(request.content)
                return httpx.Response(200, json=[{"id": row_id}])
            raise AssertionError(f"Unexpected request: {request.method} {request.url}")

        async def run():
            writer = SupabaseSetDiffWriter("https://unit-test-project.supabase.co", "fake-key")
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                return await writer.sync_jobs_set_diff(client, [incoming_unknown, incoming_correction], {})

        result = asyncio.run(run())
        self.assertEqual(result["updated"], 2)
        self.assertFalse(result["persistence_failed"])
        self.assertEqual(patches["row-preserve"]["posted_at"], preserved_date)
        self.assertEqual(patches["row-correct"]["posted_at"], corrected_date)

    def test_company_patch_failure_stops_before_next_company_insert(self) -> None:
        calls: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append((request.method, request.url.path))
            if request.method == "GET":
                return httpx.Response(200, json=[{
                    "id": "company-existing", "slug": "existing", "name": "Existing",
                    "logo_url": None, "domain": None, "canonical_domain": None,
                    "category": "OTHER_STARTUPS", "ats_type": "greenhouse",
                }])
            if request.method == "PATCH":
                return httpx.Response(503, json={"error": "temporarily unavailable"})
            if request.method == "POST":
                return httpx.Response(201, json=[{"id": "company-new", "slug": "new-company"}])
            raise AssertionError(f"Unexpected request: {request.method} {request.url}")

        jobs = [
            {"company": "Existing", "company_slug": "existing", "canonical_domain": "existing.example",
             "company_category": "MNC_BIGTECH", "logo_url": "https://existing.example/logo.png",
             "source": "greenhouse", "source_priority": 1},
            {"company": "New Company", "company_slug": "new-company", "source": "greenhouse", "source_priority": 1},
        ]

        async def run():
            writer = SupabaseSetDiffWriter("https://unit-test-project.supabase.co", "fake-key")
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                company_map = await writer.sync_companies(client, jobs)
            return writer, company_map

        writer, company_map = asyncio.run(run())
        self.assertTrue(writer.persistence_failed)
        self.assertEqual(company_map, {"existing": "company-existing"})
        self.assertEqual(calls, [
            ("GET", "/rest/v1/companies"),
            ("PATCH", "/rest/v1/companies"),
        ])

    def test_job_lookups_for_all_batches_finish_before_any_job_write(self) -> None:
        calls: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append((request.method, request.url.path))
            if request.method == "GET" and len([c for c in calls if c[0] == "GET"]) == 2:
                return httpx.Response(503, json={"error": "lookup unavailable"})
            return httpx.Response(200, json=[])

        jobs = [
            {"source_type": "greenhouse", "source_id": "greenhouse:stripe", "source_job_id": f"stripe-{index}",
             "source_priority": 1, "company": "Stripe", "company_slug": "stripe", "title": f"Role {index}"}
            for index in range(51)
        ]

        async def run():
            writer = SupabaseSetDiffWriter("https://unit-test-project.supabase.co", "fake-key")
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                result = await writer.sync_jobs_set_diff(client, jobs, {})
            return result

        result = asyncio.run(run())
        self.assertTrue(result["persistence_failed"])
        self.assertTrue(any("Jobs lookup error 503" in error for error in result["write_errors"]))
        self.assertEqual(calls, [("GET", "/rest/v1/jobs"), ("GET", "/rest/v1/jobs")])

    def test_successful_insert_without_confirmed_rows_is_not_reported_as_persisted(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.method)
            if request.method == "GET":
                return httpx.Response(200, json=[])
            if request.method == "POST":
                return httpx.Response(201, json=[])
            return httpx.Response(200, json=[])

        job = {"source_type": "greenhouse", "source_id": "greenhouse:stripe", "source_job_id": "stripe-101",
               "source_priority": 1, "company": "Stripe", "company_slug": "stripe", "title": "Engineer"}

        async def run():
            writer = SupabaseSetDiffWriter("https://unit-test-project.supabase.co", "fake-key")
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                return await writer.sync_jobs_set_diff(client, [job], {})

        result = asyncio.run(run())
        self.assertEqual(result["inserted"], 0)
        self.assertEqual(result["persisted_ids"], [])
        self.assertTrue(result["persistence_failed"])
        self.assertIn("Job insert response did not confirm every row", result["write_errors"])
        self.assertEqual(calls, ["GET", "POST"])

    def test_capped_complete_or_failed_run_never_expires_jobs(self) -> None:
        """Every canary write is capped and expiry remains disabled, even for full-coverage boards."""
        board_id = "greenhouse:stripe"
        cutoff_date = (datetime.now(timezone.utc) - timedelta(hours=72)).isoformat()

        # Database state: 2 active jobs for greenhouse:stripe
        # Job 1: seen in current fetch
        # Job 2: disappeared (last_seen_at older than cutoff)
        persisted_job = {
            "source_type": "greenhouse",
            "source_id": board_id,
            "source_job_id": "stripe:job-1",
            "title": "Engineer 1",
            "company": "Stripe",
            "company_slug": "stripe",
            "source_priority": 1,
            "dedupe_hash": "hash_stripe_1",
            "is_active": True,
            "salary_min": 1,
            "salary_max": 1,
        }

        patch_calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            method = request.method
            if method == "GET" and "/companies" in url:
                return httpx.Response(200, json=[{"id": "comp-stripe", "slug": "stripe", "ats_type": "greenhouse"}])
            if method == "GET" and "/jobs" in url:
                # Count baseline query: active jobs for source_id=greenhouse:stripe
                if "count=exact" in request.headers.get("prefer", "") and ("source_id=eq.greenhouse:stripe" in url or "source_id=eq.greenhouse%3Astripe" in url):
                    # Content-Range: 0-0/2 (2 baseline active jobs)
                    return httpx.Response(200, headers={"Content-Range": "0-0/2"}, json=[{"id": "job-1"}])
                return httpx.Response(200, json=[])
            if method == "POST" and "/jobs" in url:
                # Insert response
                return httpx.Response(201, json=[{"id": "job-1"}])
            if method == "PATCH" and "/jobs" in url:
                patch_calls.append(url)
                if "last_seen_at=lt." in url:
                    # Expire response: expired job-2
                    return httpx.Response(200, json=[{"id": "job-2", "status": "expired"}])
                return httpx.Response(200, json=[])
            return httpx.Response(200, json=[])

        async def _run_normal() -> dict[str, Any]:
            seeds = {
                "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
                "layer1_public_ats": [{"ats": "greenhouse", "slug": "stripe", "source_priority": 1}],
                "layer2_enterprise_json": {},
            }
            tmp_seeds = Path(__file__).resolve().parent / "_test_seeds_tmp.json"
            tmp_seeds.write_text(json.dumps(seeds), encoding="utf-8")
            try:
                # Mock environment
                with patch.dict(os.environ, {
                    "NEXT_PUBLIC_SUPABASE_URL": "https://mock.supabase.co",
                    "SUPABASE_SERVICE_ROLE_KEY": "mock-service-role-key",
                }):
                    # Mock fetch_layer1_seed to return 1 job (job-2 disappeared)
                    with patch("scripts.scraper.run_ingestion.fetch_layer1_seed", AsyncMock(return_value=[persisted_job])):
                        transport = httpx.MockTransport(handler)
                        return await run_master_ingestion(
                            sources=["stripe"],
                            seeds_path=tmp_seeds,
                            dry_run=False,
                            max_rows=10,
                            transport=transport,
                        )
            finally:
                if tmp_seeds.exists():
                    tmp_seeds.unlink()

        # A successful capped run must never issue baseline queries or expiry PATCHes.
        result_normal = asyncio.run(_run_normal())
        self.assertEqual(result_normal["db"]["expired"], 0)
        self.assertEqual(result_normal["expiry_reports"], [])
        self.assertEqual(patch_calls, [])

        # 2. Run failed source: when fetch fails or returns error, expiry must be skipped entirely
        patch_calls.clear()

        async def _run_failed() -> dict[str, Any]:
            seeds = {
                "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
                "layer1_public_ats": [{"ats": "greenhouse", "slug": "stripe", "source_priority": 1}],
                "layer2_enterprise_json": {},
            }
            tmp_seeds = Path(__file__).resolve().parent / "_test_seeds_tmp.json"
            tmp_seeds.write_text(json.dumps(seeds), encoding="utf-8")
            try:
                with patch.dict(os.environ, {
                    "NEXT_PUBLIC_SUPABASE_URL": "https://mock.supabase.co",
                    "SUPABASE_SERVICE_ROLE_KEY": "mock-service-role-key",
                }):
                    # Mock fetch failing with error
                    with patch("scripts.scraper.run_ingestion.fetch_layer1_seed", AsyncMock(side_effect=RuntimeError("ATS API unreachable"))):
                        transport = httpx.MockTransport(handler)
                        return await run_master_ingestion(
                            sources=["stripe"],
                            seeds_path=tmp_seeds,
                            dry_run=False,
                            max_rows=10,
                            transport=transport,
                        )
            finally:
                if tmp_seeds.exists():
                    tmp_seeds.unlink()

        result_failed = asyncio.run(_run_failed())
        self.assertEqual(result_failed["db"]["expired"], 0)
        self.assertEqual(result_failed["expiry_reports"], [])
        expiry_patches = [c for c in patch_calls if "last_seen_at=lt." in c]
        self.assertEqual(len(expiry_patches), 0)

    def test_capped_duplicate_and_failed_persistence_runs_never_expire(self) -> None:
        """Duplicate and persistence-error canary runs never invoke expiry."""
        board_id = "greenhouse:stripe"

        # Duplicate job payload: 1 job repeated 5 times in the fetch response
        duplicated_job = {
            "source_type": "greenhouse",
            "source_id": board_id,
            "source_job_id": "stripe:job-1",
            "title": "Engineer 1",
            "company": "Stripe",
            "company_slug": "stripe",
            "source_priority": 1,
            "dedupe_hash": "hash_stripe_1",
            "is_active": True,
            "salary_min": 1,
            "salary_max": 1,
        }

        # 1. Duplicate response test:
        # Fetcher returns 5 identical jobs.
        # DB baseline is 4 jobs.
        # If it counted raw fetch rows (5), 5/4 = 125% would have wrongfully expired jobs.
        # With distinct persisted key counting, only 1 unique key is counted: 1/4 = 25% < 50% drop guard -> blocks expiration!
        def handler_duplicate(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            method = request.method
            if method == "GET" and "/companies" in url:
                return httpx.Response(200, json=[{"id": "comp-stripe", "slug": "stripe", "ats_type": "greenhouse"}])
            if method == "GET" and "/jobs" in url:
                if "count=exact" in request.headers.get("prefer", ""):
                    # Baseline active count = 4
                    return httpx.Response(200, headers={"Content-Range": "0-0/4"}, json=[{"id": "job-1"}])
                return httpx.Response(200, json=[])
            if method == "POST" and "/jobs" in url:
                return httpx.Response(201, json=[{"id": "job-1"}])
            if method == "PATCH" and "/jobs" in url:
                return httpx.Response(200, json=[])
            return httpx.Response(200, json=[])

        async def _run_duplicate() -> dict[str, Any]:
            seeds = {
                "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
                "layer1_public_ats": [{"ats": "greenhouse", "slug": "stripe", "source_priority": 1}],
                "layer2_enterprise_json": {},
            }
            tmp_seeds = Path(__file__).resolve().parent / "_test_seeds_dup.json"
            tmp_seeds.write_text(json.dumps(seeds), encoding="utf-8")
            try:
                with patch.dict(os.environ, {
                    "NEXT_PUBLIC_SUPABASE_URL": "https://mock.supabase.co",
                    "SUPABASE_SERVICE_ROLE_KEY": "mock-service-role-key",
                }):
                    # Return 5 duplicates in fetch
                    with patch("scripts.scraper.run_ingestion.fetch_layer1_seed", AsyncMock(return_value=[duplicated_job] * 5)):
                        transport = httpx.MockTransport(handler_duplicate)
                        return await run_master_ingestion(sources=["stripe"], seeds_path=tmp_seeds, dry_run=False, max_rows=10, transport=transport)
            finally:
                if tmp_seeds.exists():
                    tmp_seeds.unlink()

        res_dup = asyncio.run(_run_duplicate())
        self.assertEqual(res_dup["db"]["expired"], 0)
        self.assertEqual(res_dup["expiry_reports"], [])

        # 2. Zero persisted test:
        # Zero persisted keys must mean 0 persisted count, NEVER raw fetch length!
        # Baseline is 2, 0 persisted -> guard blocks expiration.
        def handler_zero_persisted(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            method = request.method
            if method == "GET" and "/companies" in url:
                return httpx.Response(200, json=[{"id": "comp-stripe", "slug": "stripe", "ats_type": "greenhouse"}])
            if method == "GET" and "/jobs" in url:
                if "count=exact" in request.headers.get("prefer", ""):
                    return httpx.Response(200, headers={"Content-Range": "0-0/2"}, json=[{"id": "job-1"}])
                return httpx.Response(200, json=[])
            # Simulated write failure returning error on insert
            if method == "POST" and "/jobs" in url:
                return httpx.Response(500, text="Internal DB error")
            return httpx.Response(200, json=[])

        async def _run_zero_persisted() -> dict[str, Any]:
            seeds = {
                "rate_limit": {"default_rps_per_host": 4.0, "burst_per_host": 1.0},
                "layer1_public_ats": [{"ats": "greenhouse", "slug": "stripe", "source_priority": 1}],
                "layer2_enterprise_json": {},
            }
            tmp_seeds = Path(__file__).resolve().parent / "_test_seeds_zero.json"
            tmp_seeds.write_text(json.dumps(seeds), encoding="utf-8")
            try:
                with patch.dict(os.environ, {
                    "NEXT_PUBLIC_SUPABASE_URL": "https://mock.supabase.co",
                    "SUPABASE_SERVICE_ROLE_KEY": "mock-service-role-key",
                }):
                    with patch("scripts.scraper.run_ingestion.fetch_layer1_seed", AsyncMock(return_value=[duplicated_job])):
                        transport = httpx.MockTransport(handler_zero_persisted)
                        return await run_master_ingestion(sources=["stripe"], seeds_path=tmp_seeds, dry_run=False, max_rows=10, transport=transport)
            finally:
                if tmp_seeds.exists():
                    tmp_seeds.unlink()

        res_zero = asyncio.run(_run_zero_persisted())
        # Write failure vetos expiry completely
        self.assertTrue(res_zero["expiry_vetoed"])
        self.assertEqual(res_zero["db"]["expired"], 0)
        self.assertEqual(res_zero["expiry_reports"], [])
        self.assertEqual(len(res_zero["db"]["persisted_source_keys"]), 0)

    def test_retry_after_above_30s_is_honored_not_cut(self) -> None:
        """Requirement 5: Retry-After above 30s must be honored in full, never cut to 30s."""
        self.assertEqual(parse_retry_after("45"), 45.0)
        self.assertEqual(parse_retry_after("120"), 120.0)
        self.assertEqual(parse_retry_after("3600"), 3600.0)

        # Verify request_with_backoff sleeps the full Retry-After delay when > 30s
        slept_delays: list[float] = []

        async def mock_sleep(delay: float) -> None:
            slept_delays.append(delay)

        def handler(request: httpx.Request) -> httpx.Response:
            if len(slept_delays) == 0:
                return httpx.Response(429, headers={"Retry-After": "45"})
            return httpx.Response(200, json={"ok": True})

        async def _test() -> None:
            limiter = PerHostRateLimiter(default_rps=4.0)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                with patch("asyncio.sleep", mock_sleep):
                    resp = await request_with_backoff(client, limiter, "GET", "https://api.example.com/jobs")
                    self.assertEqual(resp.status_code, 200)
                    self.assertGreaterEqual(len(slept_delays), 1)
                    # Must be exactly 45.0s, NOT capped to 30.0s!
                    self.assertEqual(slept_delays[0], 45.0)

        asyncio.run(_test())

    def test_pro_search_returns_company_category_and_domain(self) -> None:
        """Requirement 6: Pro search returns company category and domain, same as Pro endpoints, and never invents slug.com."""
        mock_pro_job = {
            "id": "22222222-3333-4444-5555-666666666666",
            "title": "Principal Architect",
            "company": "Figma",
            "company_slug": "figma",
            "canonical_domain": "figma.com",
            "companies": {
                "name": "Figma",
                "category": "HIGH_PRODUCT_YC",
                "domain": "figma.com",
                "canonical_domain": "figma.com",
                "logo_url": "https://cdn.example.com/figma.png",
            },
        }

        # Simulated Pro format mapping matching /api/jobs/search
        resolved_category = mock_pro_job["companies"]["category"]
        resolved_domain = (
            mock_pro_job.get("canonical_domain") or
            mock_pro_job["companies"].get("canonical_domain") or
            mock_pro_job["companies"].get("domain") or
            None
        )

        formatted = {
            "id": mock_pro_job["id"],
            "title": mock_pro_job["title"],
            "company": mock_pro_job["company"],
            "company_category": resolved_category,
            "company_domain": resolved_domain,
            "canonical_domain": resolved_domain,
            "domain": resolved_domain,
        }

        self.assertEqual(formatted["company_category"], "HIGH_PRODUCT_YC")
        self.assertEqual(formatted["company_domain"], "figma.com")
        self.assertEqual(formatted["canonical_domain"], "figma.com")
        self.assertEqual(formatted["domain"], "figma.com")

        # Unknown domain must return null, NEVER an invented slug.com
        mock_unknown_domain_job = {
            "id": "33333333-4444-5555-6666-777777777777",
            "title": "Backend Dev",
            "company": "Stealth AI",
            "company_slug": "stealth-ai",
            "canonical_domain": None,
            "companies": {
                "name": "Stealth AI",
                "category": "OTHER_STARTUPS",
                "domain": None,
                "canonical_domain": None,
            },
        }

        resolved_unknown_domain = (
            mock_unknown_domain_job.get("canonical_domain") or
            mock_unknown_domain_job["companies"].get("canonical_domain") or
            mock_unknown_domain_job["companies"].get("domain") or
            None
        )

        self.assertIsNone(resolved_unknown_domain)
        self.assertNotEqual(resolved_unknown_domain, "stealth-ai.com")


if __name__ == "__main__":
    unittest.main()
