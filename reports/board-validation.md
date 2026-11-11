# ATS Board Validation & Scaling Report

## 1. Executive Summary

This report documents the validation, deduplication, and scaling of CareerMonke scheduled ingestion from 52 seed boards to 438 verified employer boards, drawing from the 511 unique candidate boards present in the repository.

- **Total Candidate Entries in Repo**: 829 raw entries across `companies-seed.json` (52), `companies-phase2.json` (500), and `data/ats-company-registry.json` (277)
- **Unique Deduped Boards**: 511 unique boards (deduped by company and ATS / target slug)
- **Supported ATS Candidates Tested**: 452 boards across Greenhouse, Ashby, and Lever
- **Validated Active Boards**: 438 boards (100% verified HTTP 200 with active jobs, 0 duplicates, valid ATS type)
- **Total Live Active Jobs**: 26,473 real jobs across the 438 boards in active inventory
- **Total Dropped Boards**: 73 boards

## 2. Board Counts Breakdown

| Metric | Count |
| :--- | :--- |
| Raw repository entries | 829 |
| Unique deduped candidate boards | 511 |
| - Greenhouse candidates | 236 |
| - Ashby candidates | 174 |
| - Lever candidates | 42 |
| - SmartRecruiters candidates (not scheduled in this batch) | 33 |
| - Recruitee candidates (not scheduled in this batch) | 22 |
| - Workable candidates (not scheduled in this batch) | 4 |
| Supported candidates tested | 452 |
| **Validated active boards (Greenhouse, Ashby, Lever)** | **438** |
| **Dropped boards total** | **73** |
| - Not scheduled in this batch (SmartRecruiters, Recruitee, Workable; adapters exist) | 59 |
| - Zero active jobs | 12 |
| - HTTP 404 / retired board | 2 |

## 3. Validated Boards Distribution

| ATS Provider | Validated Boards | Total Active Jobs |
| :--- | :--- | :--- |
| Greenhouse | 227 | 15,082 |
| Ashby | 170 | 9,848 |
| Lever | 41 | 1,543 |
| **Total** | **438** | **26,473** |

## 4. Sharding & Scheduling Architecture

- **Schedule**: Every 4 hours (`0 */4 * * *`) via GitHub Actions (`.github/workflows/ingest.yml`).
- **Shards**: 6 balanced partitions (73 boards per shard).
- **Execution Isolation**: Runs via GitHub Actions matrix strategy (`include` 6 labeled shards) with `fail-fast: false` and `max-parallel: 2`.
- **Resilience**: A cancelled or failed shard does not affect any other shard; each completed shard persists its ingested jobs independently.
- **CI Headroom**: Measured execution time per shard (73 boards) is 95–98 seconds (~1.6 minutes) with 4 concurrent workers, well within the 30-minute timeout.

## 5. Dropped Boards Inventory

| # | Company | ATS | Target / Token | Status | Drop Reason |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Doctolib | greenhouse | `doctolib` | 404 | HTTP 404 Not Found (board retired or slug changed) |
| 2 | Sixt | greenhouse | `sixt` | 404 | HTTP 404 Not Found (board retired or slug changed) |
| 3 | Accenture | recruitee | `accenture` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 4 | Adzuna | recruitee | `adzuna` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 5 | bunq | recruitee | `bunq` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 6 | Convious | recruitee | `convious` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 7 | Funda | recruitee | `funda` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 8 | Gridscale | recruitee | `gridscale` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 9 | Intent | recruitee | `intent` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 10 | Jobtome | recruitee | `jobtome` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 11 | Kodify | recruitee | `kodify` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 12 | Madewithlove | recruitee | `madewithlove` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 13 | Mailerlite | recruitee | `mailerlite` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 14 | Meltwater | recruitee | `meltwater` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 15 | Multiplier | recruitee | `multiplier` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 16 | Namecheap | recruitee | `namecheap` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 17 | Nimble | recruitee | `nimble` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 18 | Nmbrs | recruitee | `nmbrs` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 19 | Personio | recruitee | `personio` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 20 | Ragnarson | recruitee | `ragnarson` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 21 | STRV | recruitee | `strv` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 22 | Swisscom | recruitee | `swisscom` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 23 | Tes | recruitee | `tes` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 24 | Vshn | recruitee | `vshn` | N/A | Not scheduled in this batch (recruitee - adapter exists in scripts/adapters/recruitee.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 25 | Adaface | smartrecruiters | `adaface` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 26 | Allegro | smartrecruiters | `allegro` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 27 | ASOS | smartrecruiters | `asos` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 28 | Auto1 | smartrecruiters | `auto1` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 29 | BigBinary | smartrecruiters | `bigbinary` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 30 | BigCommerce | smartrecruiters | `bigcommerce` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 31 | Canva | smartrecruiters | `canva` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 32 | Caravelo | smartrecruiters | `caravelo` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 33 | Cars24 | smartrecruiters | `cars24` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 34 | Clootrack | smartrecruiters | `clootrack` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 35 | DataChef | smartrecruiters | `datachef` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 36 | Delivery Hero | smartrecruiters | `deliveryhero` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 37 | Doit | smartrecruiters | `doit` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 38 | Dribbble | smartrecruiters | `dribbble` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 39 | Endava | smartrecruiters | `endava` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 40 | Fiverr | smartrecruiters | `fiverr` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 41 | Freshworks | smartrecruiters | `freshworks` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 42 | Gcore | smartrecruiters | `gcore` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 43 | Intevity | smartrecruiters | `intevity` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 44 | Jumio | smartrecruiters | `jumio` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 45 | Kata.ai | smartrecruiters | `kataai` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 46 | numberly | smartrecruiters | `numberly` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 47 | Remotive | smartrecruiters | `remotive` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 48 | Securiti | smartrecruiters | `securiti` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 49 | ServiceNow | smartrecruiters | `servicenow` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 50 | Splice | smartrecruiters | `splice` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 51 | Swiggy | smartrecruiters | `swiggy` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 52 | Together AI | smartrecruiters | `together` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 53 | Turtlemint | smartrecruiters | `turtlemint` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 54 | Wayfair | smartrecruiters | `wayfair` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 55 | Western Digital | smartrecruiters | `westerndigital` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 56 | Wise | smartrecruiters | `wise` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 57 | Xplor | smartrecruiters | `xplor` | N/A | Not scheduled in this batch (smartrecruiters - adapter exists in scripts/adapters/smartrecruiters.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 58 | Aha | workable | `aha` | N/A | Not scheduled in this batch (workable - adapter exists in scripts/adapters/workable.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 59 | Hugging Face | workable | `huggingface` | N/A | Not scheduled in this batch (workable - adapter exists in scripts/adapters/workable.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 60 | Kahoot! | workable | `kahoot` | N/A | Not scheduled in this batch (workable - adapter exists in scripts/adapters/workable.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 61 | Skillshare | workable | `skillshare` | N/A | Not scheduled in this batch (workable - adapter exists in scripts/adapters/workable.ts; scheduled batch restricted to Greenhouse, Ashby, Lever) |
| 62 | Axiom | ashby | `axiom` | 200 | 0 active postings returned |
| 63 | Confluent | ashby | `confluent` | 200 | 0 active postings returned |
| 64 | Kentik | greenhouse | `kentik` | 200 | 0 active postings returned |
| 65 | Liveperson | greenhouse | `liveperson` | 200 | 0 active postings returned |
| 66 | MasterClass | greenhouse | `masterclass` | 200 | 0 active postings returned |
| 67 | Melio | greenhouse | `melio` | 200 | 0 active postings returned |
| 68 | Noyo | ashby | `noyo` | 200 | 0 active postings returned |
| 69 | Signal AI | ashby | `signal-ai` | 200 | 0 active postings returned |
| 70 | Trade Republic | greenhouse | `traderepublic` | 200 | 0 active postings returned |
| 71 | Unbounce | greenhouse | `unbounce` | 200 | 0 active postings returned |
| 72 | Wealthsimple | lever | `wealthsimple` | 200 | 0 active postings returned |
| 73 | Webflow | greenhouse | `webflow` | 200 | 0 active postings returned |
