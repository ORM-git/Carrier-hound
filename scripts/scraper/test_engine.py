"""Self-contained verification suite for the async Python high-volume ingestion engine."""

from __future__ import annotations

import asyncio
import json
import unittest

import httpx

from scripts.scraper.engine import (
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
    INDIA_TARGET_LOCATIONS,
    INDIA_TARGET_ROLES,
    JOBSPY_SITES,
    fetch_adzuna,
    fetch_arbeitnow,
    fetch_jobspy_india_batch,
)
from scripts.scraper.fetchers import (
    fetch_amazon_jobs,
    fetch_ashby,
    fetch_greenhouse,
    fetch_lever,
    fetch_microsoft_jobs,
    fetch_smartrecruiters,
    fetch_workday_cxs,
)
from scripts.scraper.rate_limiter import PerHostRateLimiter
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
        # Missing ATS logo and missing domain -> None so frontend CompanyLogo initial-avatar renders
        self.assertIsNone(resolve_logo_url(None, None))

    def test_dedupe_hash_normalization(self) -> None:
        h1 = compute_dedupe_hash("Stripe, Inc.", "Senior Software Engineer!", "US", "San Francisco, CA")
        h2 = compute_dedupe_hash("stripe", "senior software engineer", "us", "San Francisco, United States")
        self.assertEqual(len(h1), 64)
        self.assertEqual(h1, h2)

    def test_layer1_and_layer2_fetchers_and_429_backoff(self) -> None:
        attempts = {"gh": 0}
        captured_workday_body: dict = {}

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true" in url:
                attempts["gh"] += 1
                if attempts["gh"] == 1:
                    return httpx.Response(429, headers={"Retry-After": "0"})
                return httpx.Response(
                    200,
                    json={
                        "jobs": [
                            {
                                "id": 101,
                                "title": "Distributed Systems Engineer",
                                "absolute_url": "https://boards.greenhouse.io/stripe/jobs/101",
                                "location": {"name": "San Francisco, CA"},
                                "content": "Python, Go, AWS, Kubernetes, SQL, Kafka, Redis, Docker, Terraform",
                                "updated_at": "2026-11-15T10:00:00Z",
                            }
                        ]
                    },
                )
            if "api.lever.co/v0/postings/mistral?mode=json" in url:
                return httpx.Response(
                    200,
                    json=[
                        {
                            "id": "lev-1",
                            "text": "Machine Learning Scientist (LLM, RAG)",
                            "hostedUrl": "https://jobs.lever.co/mistral/lev-1",
                            "categories": {"location": "Paris, France", "department": "AI"},
                            "descriptionPlain": "PyTorch, LLM, RAG, LangChain, Python",
                            "createdAt": 1763200000000,
                        }
                    ],
                )
            if "api.ashbyhq.com/posting-api/job-board/openai?includeCompensation=true" in url:
                return httpx.Response(
                    200,
                    json={
                        "jobs": [
                            {
                                "id": "ash-1",
                                "title": "Research Engineer, Post-Training",
                                "jobUrl": "https://jobs.ashbyhq.com/openai/ash-1",
                                "location": "San Francisco, CA",
                                "isRemote": False,
                                "compensation": {"compensationTierSummary": "$300K - $450K"},
                                "descriptionHtml": "<p>Python, PyTorch, Distributed Systems, Kubernetes</p>",
                                "publishedAt": "2026-11-15T12:00:00Z",
                            }
                        ]
                    },
                )
            if "api.smartrecruiters.com/v1/companies/Wise/postings" in url:
                return httpx.Response(
                    200,
                    json={
                        "content": [
                            {
                                "id": "sr-1",
                                "name": "Senior Java Backend Engineer",
                                "location": {"city": "London", "country": "gb", "remote": True},
                                "releasedDate": "2026-11-15T08:00:00Z",
                            }
                        ]
                    },
                )
            if "nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs" in url:
                nonlocal captured_workday_body
                captured_workday_body = json.loads(request.content.decode("utf-8"))
                return httpx.Response(
                    200,
                    json={
                        "jobPostings": [
                            {
                                "title": "Senior Deep Learning Architect - CUDA & PyTorch",
                                "externalPath": "/job/Santa-Clara/DL-Arch_JR12345",
                                "locationsText": "Santa Clara, CA",
                                "bulletFields": ["JR12345", "Python, C++, PyTorch, Kubernetes"],
                            }
                        ]
                    },
                )
            if "www.amazon.jobs/en/search.json" in url:
                return httpx.Response(
                    200,
                    json={
                        "jobs": [
                            {
                                "id_icims": "amz-99",
                                "title": "Software Development Engineer II",
                                "job_path": "/en/jobs/amz-99",
                                "normalized_location": "Seattle, WA, USA",
                                "country_code": "US",
                                "basic_qualifications": "Java, AWS, Distributed Systems, React, TypeScript, SQL",
                                "posted_date": "November 15, 2026",
                            }
                        ]
                    },
                )
            if "gcsservices.careers.microsoft.com/search/api/v1/search" in url:
                return httpx.Response(
                    200,
                    json={
                        "operationResult": {
                            "result": {
                                "jobs": [
                                    {
                                        "jobId": "msft-77",
                                        "title": "Principal Cloud Engineer - Azure Kubernetes",
                                        "postingDate": "2026-11-15T09:00:00Z",
                                        "properties": {
                                            "primaryLocation": "Redmond, WA, USA",
                                            "description": "Azure, Kubernetes, Go, C#, Distributed Systems, Terraform",
                                            "workSiteFlexibility": "100% Remote",
                                        },
                                    }
                                ]
                            }
                        }
                    },
                )
            return httpx.Response(404)

        async def _run() -> None:
            transport = httpx.MockTransport(handler)
            limiter = PerHostRateLimiter(default_rps=5.0, burst=5.0)
            async with httpx.AsyncClient(transport=transport) as client:
                gh = await fetch_greenhouse(
                    client,
                    limiter,
                    {"slug": "stripe", "name": "Stripe", "token": "stripe", "canonical_domain": "stripe.com", "category": "HIGH_PRODUCT_YC"},
                )
                lv = await fetch_lever(
                    client,
                    limiter,
                    {"slug": "mistral", "name": "Mistral AI", "token": "mistral", "canonical_domain": "mistral.ai", "category": "HIGH_PRODUCT_YC"},
                )
                ash = await fetch_ashby(
                    client,
                    limiter,
                    {"slug": "openai", "name": "OpenAI", "token": "openai", "canonical_domain": "openai.com", "category": "HIGH_PRODUCT_YC"},
                )
                sr = await fetch_smartrecruiters(
                    client,
                    limiter,
                    {"slug": "wise", "name": "Wise", "token": "Wise", "canonical_domain": "wise.com", "category": "HIGH_PRODUCT_YC"},
                )
                wd = await fetch_workday_cxs(
                    client,
                    limiter,
                    {
                        "slug": "nvidia",
                        "name": "NVIDIA",
                        "tenant": "nvidia",
                        "wd_cluster": "wd5",
                        "site": "NVIDIAExternalCareerSite",
                        "canonical_domain": "nvidia.com",
                        "category": "MNC_BIGTECH",
                    },
                    max_pages=1,
                )
                amz = await fetch_amazon_jobs(
                    client,
                    limiter,
                    {"slug": "amazon", "name": "Amazon", "canonical_domain": "amazon.com", "category": "MNC_BIGTECH"},
                    max_pages=1,
                )
                msft = await fetch_microsoft_jobs(
                    client,
                    limiter,
                    {"slug": "microsoft", "name": "Microsoft", "canonical_domain": "microsoft.com", "category": "MNC_BIGTECH"},
                    max_pages=1,
                )

                self.assertEqual(attempts["gh"], 2)  # Retried once on 429
                self.assertEqual(captured_workday_body, {"limit": 20, "offset": 0, "searchText": ""})
                self.assertEqual(len(gh), 1)
                self.assertEqual(len(lv), 1)
                self.assertEqual(len(ash), 1)
                self.assertEqual(len(sr), 1)
                self.assertEqual(len(wd), 1)
                self.assertEqual(len(amz), 1)
                self.assertEqual(len(msft), 1)

                self.assertEqual(wd[0]["company_category"], "MNC_BIGTECH")
                self.assertEqual(amz[0]["company_category"], "MNC_BIGTECH")
                self.assertEqual(msft[0]["company_category"], "MNC_BIGTECH")
                self.assertTrue(msft[0]["is_remote"])
                self.assertIn("Kubernetes", msft[0]["top_keywords"])

        asyncio.run(_run())

    def test_set_diff_upserts_only_new_or_changed(self) -> None:
        base_job = {
            "company": "Stripe",
            "title": "Senior Backend Engineer",
            "location": "San Francisco, CA",
            "apply_url": "https://boards.greenhouse.io/stripe/jobs/1",
            "role_category": "SDE",
            "salary_text": "$200k",
            "salary_min": 200000,
            "salary_max": 250000,
            "is_active": True,
            "source_type": "ats",
            "source_job_id": "1",
            "source_priority": 1,
            "dedupe_hash": "hash_1",
            "top_keywords": ["Python", "SQL"],
        }
        existing_db_row = {"id": "uuid-existing-1", **base_job}

        # 1) Identical job -> skipped
        # 2) Changed salary/title on existing job -> updated
        # 3) Brand new job -> inserted
        changed_job = {**base_job, "source_job_id": "2", "dedupe_hash": "hash_2", "salary_text": "$220k"}
        existing_db_row_2 = {"id": "uuid-existing-2", **base_job, "source_job_id": "2", "dedupe_hash": "hash_2"}
        new_job = {**base_job, "source_job_id": "3", "dedupe_hash": "hash_3", "title": "AI Engineer"}

        to_insert, to_update, unchanged_ids = partition_set_diff(
            [base_job, changed_job, new_job],
            [existing_db_row, existing_db_row_2],
        )

        self.assertEqual(len(to_insert), 1)
        self.assertEqual(to_insert[0]["source_job_id"], "3")
        self.assertEqual(len(to_update), 1)
        self.assertEqual(to_update[0][0], "uuid-existing-2")
        self.assertEqual(unchanged_ids, ["uuid-existing-1"])

    def test_layer3_jobspy_arbeitnow_adzuna_and_alias_normalization(self) -> None:
        # Verify required India roles, locations (including Bhubaneswar & NCR), and sites
        self.assertEqual(
            INDIA_TARGET_ROLES,
            (
                "Software Engineer",
                "Fresher",
                "Graduate Engineer Trainee",
                "Data Analyst",
                "AI Engineer",
                "Cloud Engineer",
            ),
        )
        self.assertTrue(any("Bhubaneswar" in loc for loc in INDIA_TARGET_LOCATIONS))
        self.assertTrue(any("NCR" in loc for loc in INDIA_TARGET_LOCATIONS))
        self.assertEqual(JOBSPY_SITES, ("linkedin", "indeed", "naukri"))

        # Verify company alias normalizer & 4-category assignment
        self.assertEqual(normalize_company_alias("TCS")[0:2], ("Tata Consultancy Services", "INDIAN_IT_AND_OTHER"))
        self.assertEqual(normalize_company_alias("LTIMindtree Ltd.")[0:2], ("LTIMindtree", "INDIAN_IT_AND_OTHER"))
        self.assertEqual(normalize_company_alias("Tech Mahindra")[0:2], ("Tech Mahindra", "INDIAN_IT_AND_OTHER"))
        self.assertEqual(normalize_company_alias("Capgemini")[0:2], ("Capgemini", "INDIAN_IT_AND_OTHER"))
        self.assertEqual(normalize_company_alias("Accenture")[0:2], ("Accenture", "INDIAN_IT_AND_OTHER"))
        self.assertEqual(normalize_company_alias("Google LLC")[0:2], ("Google", "MNC_BIGTECH"))
        self.assertEqual(normalize_company_alias("Razorpay")[0:2], ("Razorpay", "HIGH_PRODUCT_YC"))
        self.assertEqual(
            assign_company_category(None, "Apex Infotech Solutions Pvt Ltd", country_code="IN"),
            "INDIAN_IT_AND_OTHER",
        )
        self.assertEqual(
            assign_company_category(None, "Nova Quantum Labs", country_code="US"),
            "OTHER_STARTUPS",
        )

        captured_jobspy_calls: list[dict] = []

        def fake_jobspy_scrape(**kwargs):
            captured_jobspy_calls.append(kwargs)
            return [
                {
                    "id": "nk-1",
                    "site": "naukri",
                    "title": "Graduate Engineer Trainee - Python & AWS",
                    "company": "TCS",
                    "location": "Bhubaneswar, India",
                    "job_url": "https://www.naukri.com/job-listings-tcs-get-1",
                    "description": "Python, AWS, SQL, Java, Linux",
                    "date_posted": "2026-11-16",
                }
            ]

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "arbeitnow.com/api/job-board-api" in url:
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "slug": "arb-1",
                                "title": "Cloud Engineer (Kubernetes, Terraform)",
                                "company_name": "Capgemini",
                                "location": "Berlin, Germany",
                                "remote": True,
                                "url": "https://www.arbeitnow.com/jobs/arb-1",
                                "description": "Kubernetes, Terraform, AWS, Docker, Python",
                                "tags": ["Cloud", "Kubernetes"],
                                "created_at": 1763250000,
                            }
                        ]
                    },
                )
            if "api.adzuna.com/v1/api/jobs/in/search/1" in url:
                return httpx.Response(
                    200,
                    json={
                        "results": [
                            {
                                "id": "adz-500",
                                "title": "Data Analyst (SQL, Python, Snowflake)",
                                "company": {"display_name": "LTIMindtree"},
                                "location": {"display_name": "Hyderabad, India"},
                                "redirect_url": "https://www.adzuna.in/details/adz-500",
                                "description": "SQL, Python, Snowflake, Airflow, dbt",
                                "salary_min": 800000,
                                "salary_max": 1400000,
                                "created": "2026-11-16T06:00:00Z",
                            }
                        ]
                    },
                )
            return httpx.Response(404)

        async def _run() -> None:
            js_jobs = await fetch_jobspy_india_batch(
                roles=("Graduate Engineer Trainee",),
                locations=("Bhubaneswar, India",),
                hours_old=24,
                scrape_fn=fake_jobspy_scrape,
            )
            self.assertEqual(len(captured_jobspy_calls), 1)
            self.assertEqual(captured_jobspy_calls[0]["hours_old"], 24)
            self.assertEqual(len(js_jobs), 1)
            self.assertEqual(js_jobs[0]["company"], "Tata Consultancy Services")
            self.assertEqual(js_jobs[0]["company_category"], "INDIAN_IT_AND_OTHER")
            self.assertEqual(js_jobs[0]["source_priority"], 2)

            limiter = PerHostRateLimiter(default_rps=5.0, burst=5.0)
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                arb_jobs = await fetch_arbeitnow(client, limiter, max_pages=1)
                adz_jobs = await fetch_adzuna(
                    client,
                    limiter,
                    app_id="test_id",
                    app_key="test_key",
                    countries=("in",),
                    roles=("Data Analyst",),
                )
                self.assertEqual(len(arb_jobs), 1)
                self.assertEqual(arb_jobs[0]["company_category"], "INDIAN_IT_AND_OTHER")
                self.assertEqual(arb_jobs[0]["role_category"], "CLOUD")
                self.assertEqual(len(adz_jobs), 1)
                self.assertEqual(adz_jobs[0]["company"], "LTIMindtree")
                self.assertEqual(adz_jobs[0]["role_category"], "DATA")

        asyncio.run(_run())

    def test_master_runner_error_isolation_and_50_percent_drop_guard(self) -> None:
        # 1) 50% count-drop guard tests
        blocked = evaluate_count_drop_guard(fetched_count=49, baseline_active_count=100, is_full_run=True)
        self.assertFalse(blocked["allowed"])
        self.assertIn("50% count-drop guard triggered", blocked["reason"])

        allowed = evaluate_count_drop_guard(fetched_count=55, baseline_active_count=100, is_full_run=True)
        self.assertTrue(allowed["allowed"])

        partial = evaluate_count_drop_guard(fetched_count=200, baseline_active_count=100, is_full_run=False)
        self.assertFalse(partial["allowed"])

        # 2) Per-source error isolation: one failing source never crashes the batch
        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            if "boards-api.greenhouse.io/v1/boards/stripe" in url:
                return httpx.Response(500, text="Internal Server Error")
            if "arbeitnow.com/api/job-board-api" in url:
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {
                                "slug": "arb-ok-1",
                                "title": "AI Engineer (Python, LangChain, RAG)",
                                "company_name": "Infosys",
                                "location": "Bangalore, India",
                                "remote": False,
                                "url": "https://www.arbeitnow.com/jobs/arb-ok-1",
                                "description": "Python, LangChain, RAG, AWS",
                                "tags": ["AI"],
                            }
                        ]
                    },
                )
            return httpx.Response(200, json={})

        async def _run() -> None:
            report = await run_master_ingestion(
                sources=["stripe", "arbeitnow"],
                dry_run=True,
                baseline_active_count=100,
                transport=httpx.MockTransport(handler),
            )
            self.assertEqual(report["total_fetched"], 1)
            self.assertEqual(len(report["failed_sources"]), 1)
            self.assertEqual(report["failed_sources"][0]["source"], "layer1:greenhouse:stripe")
            self.assertFalse(report["count_drop_guard"]["allowed"])

        asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
