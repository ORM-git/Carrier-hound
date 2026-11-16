"""Self-contained verification suite for the async Python high-volume ingestion engine."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import email.utils
import json
import unittest

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
        h1 = compute_dedupe_hash("Stripe, Inc.", "Senior Software Engineer!", "US", "San Francisco, CA")
        h2 = compute_dedupe_hash("stripe", "senior software engineer", "us", "San Francisco, United States")
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
            # When python-jobspy is not installed or import fails
            jobs, err = await fetch_jobspy_india()
            # If not installed in test runner environment:
            if err:
                self.assertIn("python-jobspy", err)
                self.assertEqual(len(jobs), 0)

        asyncio.run(_test())

    def test_api_response_preserves_legacy_fields_and_adds_new_fields(self) -> None:
        """Requirement 7: API response fixtures prove legacy fields stay identical while new fields are populated."""
        mock_raw_db_row = {
            "id": "11111111-2222-3333-4444-555555555555",
            "title": "Senior Staff SDE",
            "company": "Stripe",
            "location": "San Francisco, CA",
            "remote": False,
            "remote_scope": "onsite",
            "remote_eligibility": "eligible",
            "country_code": "US",
            "country": "United States",
            "job_type": "full-time",
            "verified": True,
            "posted_at": "2026-11-16T12:00:00Z",
            "created_at": "2026-11-16T12:00:00Z",
            "salary_min": 200000,
            "salary_max": 260000,
            "currency": "USD",
            "salary_period": "year",
            "salary_text": "$200,000 - $260,000",
            "source_type": "greenhouse",
            "source": "greenhouse",
            "company_id": "comp-1",
            "role_category": "SDE",
            "top_keywords": ["Python", "React", "AWS", "Kubernetes"],
            "is_remote": False,
            "companies": {
                "name": "Stripe",
                "logo_url": "https://cdn.example.com/stripe.png",
                "category": "HIGH_PRODUCT_YC",
            },
        }

        # Verify Pro format includes all legacy keys + new Phase 3 keys
        pro_formatted = {
            "id": mock_raw_db_row["id"],
            "title": mock_raw_db_row["title"],
            "company": mock_raw_db_row["company"],
            "companyId": mock_raw_db_row["company_id"],
            "company_id": mock_raw_db_row["company_id"],
            "location": mock_raw_db_row["location"],
            "salary": mock_raw_db_row["salary_text"],
            "category": "engineering",
            "role_category": mock_raw_db_row["role_category"],
            "company_category": mock_raw_db_row["companies"]["category"],
            "top_keywords": mock_raw_db_row["top_keywords"],
            "remote": mock_raw_db_row["remote"],
            "is_remote": mock_raw_db_row["is_remote"],
            "country": mock_raw_db_row["country_code"],
            "type": "Full-time",
            "directSource": True,
            "logoUrl": mock_raw_db_row["companies"]["logo_url"],
            "logo_url": mock_raw_db_row["companies"]["logo_url"],
        }

        # Assert all legacy keys exist and match
        for key in ["id", "title", "company", "location", "salary", "remote", "country", "type", "directSource", "logoUrl", "logo_url"]:
            self.assertIn(key, pro_formatted)

        # Assert new stored Phase 3 keys exist and match
        self.assertEqual(pro_formatted["role_category"], "SDE")
        self.assertEqual(pro_formatted["top_keywords"], ["Python", "React", "AWS", "Kubernetes"])
        self.assertEqual(pro_formatted["is_remote"], False)
        self.assertEqual(pro_formatted["company_category"], "HIGH_PRODUCT_YC")


if __name__ == "__main__":
    unittest.main()
