# ATS Board Discovery: Sources & Licences

This document records the provenance, licenses, and collection methodologies for the Applicant Tracking System (ATS) board discovery and adapter pipeline in CareerMonke.

All sources adhere strictly to the project's operational locks:
- No scraping of third-party job boards (strictly zero requests to LinkedIn, Indeed, Naukri, Glassdoor, Jobright, ZipRecruiter, Workday, JobSpy).
- No login-gated systems or bypass of terms of service.
- Respect for domain rate pacing (1 request per second per host) and automated `429` / `Retry-After` backoff.
- User-Agent strictly `CareerMonkeBot/1.0`.

---

## 1. Common Crawl Public URL Index

- **Provider**: Common Crawl Foundation (501(c)(3) registered non-profit)
- **Service**: Common Crawl Index Server (CDX API)
- **Endpoint**: `https://index.commoncrawl.org/` (Index: `CC-MAIN-2026-43`)
- **License / Terms**: Common Crawl Terms of Use; only URL strings used
- **Methodology**: Queries line-delimited CDX records for authorized ATS public domains:
  - `boards.greenhouse.io/*`
  - `job-boards.greenhouse.io/*`
  - `jobs.lever.co/*`
  - `jobs.ashbyhq.com/*`
  - `apply.workable.com/*`
  - `*.recruitee.com/*`
  - `*.breezy.hr/*`
  - `*.bamboohr.com/careers/*`
  - `*.personio.de/*`
  - `*.personio.com/*`
  - `join.com/companies/*`
- **Data Extracted**: Organization path segment or subdomain extracted as company board token (e.g. `apply.workable.com/<token>`, `<token>.breezy.hr`).

---

## 2. Open-Source Community ATS Datasets (GitHub)

### A. `Feashliaa/job-board-aggregator`
- **Author**: Riley Dorrington
- **Repository**: `https://github.com/Feashliaa/job-board-aggregator`
- **License**: MIT License (Copyright (c) 2026 Riley Dorrington)
- **Data Files**:
  - `data/greenhouse_companies.json` (Public Greenhouse organization tokens)
  - `data/lever_companies.json` (Public Lever site identifiers)
  - `data/ashby_companies.json` (Public Ashby organization slugs)
  - `data/bamboohr_companies.json` (Public BambooHR subdomain slugs)
- **Usage**: Used as seed candidate tokens for automated public API verification.

### B. `AkshatBhat/find-companies-using-ashby-job-boards`
- **Author**: Akshat Bhat
- **Repository**: `https://github.com/AkshatBhat/find-companies-using-ashby-job-boards`
- **License**: MIT License (Copyright (c) 2026 Akshat Bhat)
- **Data Files**:
  - `examples/example_verified_ashby_slugs.csv`
- **Usage**: Provides verified Ashby board tokens and inferred organization names.

---

## 3. Guessed Candidates (Unverified, Expected Low Hit Rate)

- **Source / Method**: `company_probe` generated from known employer names (`src/data/companies.json`, `scripts/config/companies-phase2.json`, `data/ats-company-registry.json`).
- **Status & Classification**: Guessed candidates (unverified, expected low hit rate).
- **Default Policy**: Disabled by default in discovery (`--probe` flag required).
- **Scope Restriction**: Restricted strictly to established platforms (`greenhouse`, `lever`, `ashby`). For new ATS platforms, probing is disabled until verified.
- **Verification Requirement**: Guessed candidates are never ingested into the database without passing live verification (HTTP 200 and >= 1 active job on public API). All unverified probe cross-products are excluded from the candidate dataset.

---

## 4. Supported Adapters & Public Endpoints

The pipeline provides normalized adapters targeting legal, unauthenticated public feeds and endpoints:
- **Greenhouse**: `https://boards-api.greenhouse.io/v1/boards/<token>/jobs?content=true&pay_transparency=true`
- **Lever**: `https://api.lever.co/v0/postings/<token>?mode=json`
- **Ashby**: `https://api.ashbyhq.com/posting-api/job-board/<token>`
- **Workable**: `https://apply.workable.com/api/v1/widget/accounts/<token>`
- **SmartRecruiters**: `https://api.smartrecruiters.com/v1/companies/<token>/postings`
- **Recruitee**: `https://<token>.recruitee.com/api/offers/`
- **Breezy**: `https://<token>.breezy.hr/json`
- **Teamtailor**: `https://<token>.teamtailor.com/jobs.rss`
- **Personio**: `https://<token>.jobs.personio.de/xml` (fallback `.jobs.personio.com/xml`)

All adapters output the standard `NormalizedJob` shape and respect 1 req/s domain pacing and `CareerMonkeBot/1.0` User-Agent.
