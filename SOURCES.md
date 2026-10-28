# ATS Board Discovery: Sources & Licences

This document records the provenance, licenses, and collection methodologies for the Applicant Tracking System (ATS) board discovery pipeline in CareerMonke.

All sources adhere strictly to the project's operational locks:
- No scraping of third-party job boards (strictly zero requests to LinkedIn, Indeed, Naukri, Glassdoor, Jobright, Workday).
- No login-gated systems or bypass of terms of service.
- Respect for domain rate pacing (1 request per second per host) and automated `429` / `Retry-After` backoff.

---

## 1. Common Crawl Public URL Index

- **Provider**: Common Crawl Foundation (501(c)(3) registered non-profit)
- **Service**: Common Crawl Index Server (CDX API)
- **Endpoint**: `https://index.commoncrawl.org/` (Index: `CC-MAIN-2026-43`)
- **License / Terms**: Open Public Data (Creative Commons / Public Domain)
- **Methodology**: Queries line-delimited CDX records for authorized ATS public domains:
  - `boards.greenhouse.io/*`
  - `job-boards.greenhouse.io/*`
  - `jobs.lever.co/*`
  - `jobs.ashbyhq.com/*`
- **Data Extracted**: Organization path segment extracted as company board token (e.g. `boards.greenhouse.io/<token>/jobs`).

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
- **Usage**: Used as seed candidate tokens for automated public API verification.

### B. `AkshatBhat/find-companies-using-ashby-job-boards`
- **Author**: Akshat Bhat
- **Repository**: `https://github.com/AkshatBhat/find-companies-using-ashby-job-boards`
- **License**: MIT License (Copyright (c) 2026 Akshat Bhat)
- **Data Files**:
  - `examples/example_verified_ashby_slugs.csv`
- **Usage**: Provides verified Ashby board tokens and inferred organization names.

---

## 3. Direct Public Company Probing

- **Source**: CareerMonke public company index (`src/data/companies.json`, `scripts/config/companies-phase2.json`)
- **License**: Internal project seed dataset
- **Methodology**: Generates slug variants (e.g., lowercase, kebab-case, concatenated) from known tech employers and queries documented public ATS endpoints directly.

---

## 4. Verification Protocol

A candidate token is verified if and only if:
1. The request URL is verified by `isAuthorizedAtsUrl` against public endpoints:
   - Greenhouse: `https://boards-api.greenhouse.io/v1/boards/<token>/jobs`
   - Lever: `https://api.lever.co/v0/postings/<token>?mode=json`
   - Ashby: `https://api.ashbyhq.com/posting-api/job-board/<token>`
2. The endpoint responds with `HTTP 200 OK`.
3. The response payload parses to a non-empty list of active jobs (`job_count >= 1`).
4. Tokens returning `404 Not Found`, errors, or `0 jobs` are immediately rejected.
