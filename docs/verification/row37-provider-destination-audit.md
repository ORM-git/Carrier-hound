# Row 37: source and application destination

Reviewed on main a0f75cb9. Source/provider fields are ingestion provenance, not proof of employer ownership. `applyDestination` is an initial URL hint only. No requests follow redirects. A registered ATS token establishes a known board URL shape, not ownership of this particular job. All other company sites and unsupported ATS hosts stay unknown. No provider is disabled or reclassified in storage.

## Provider mappings inspected

All 16 entries of `scripts/adapters/index.ts` were inspected at their normalized return objects:

| Adapter | source_type | application URL selection |
|---|---|---|
| greenhouse | ats | absolute_url |
| lever | ats | applyUrl, else hostedUrl |
| ashby | ats | applyUrl, jobUrl, else jobs.ashbyhq.com/token/id |
| smartrecruiters | ats | detail applyUrl, postingUrl, else posting fallback |
| recruitee | ats | careers_url, else tenant.recruitee.com/o/id |
| workable | ats | applicationUrl, url, else apply.workable.com/token/j/id |
| breezy | ats | url, else tenant.breezy.hr/p/id |
| teamtailor | ats | RSS link, else guid |
| personio | ats | tenant.jobs.personio.de/job/id |
| bamboohr | ats | tenant.bamboohr.com/careers/id |
| join | ats | HTTPS url, else join.com/companies/token/id |
| adzuna | feed | redirect_url, never the source name |
| remotive | feed | url |
| arbeitnow | feed | url, else arbeitnow.com/jobs/slug |
| remoteok | feed | apply_url, url, else remoteok.com/remote-jobs/id |
| weworkremotely | feed | RSS link, else guid |

Python `scripts/scraper/fetchers.py`: Greenhouse absolute_url; Lever selected apply URL; Ashby jobUrl/applyUrl; SmartRecruiters constructed board URL; Workday tenant/site/externalPath; Amazon job_path/amazon.jobs; Microsoft positionUrl/relative host or legacy constructed careers URL. Each separately supplies source and source_type to build_normalized_job (lines 337-339 store all three independently).

Python `fetch_aggregators_and_india.py`: JobSpy job_url/job_url_direct, source=site and source_type=jobspy (already hidden by existing policy); Arbeitnow item.url and its own source/type; Adzuna selected redirect URL and its own source/type. No source field is used by the classifier. No policy change to hiding LinkedIn/Indeed/Naukri or keeping other providers.

`board-ingest.ts`: three board normalizers independently store source=ATS-board and source_type=ats with validated incoming Greenhouse absolute_url, Lever hostedUrl/applyUrl, Ashby jobUrl/applyUrl. `ingest.ts` persists source, source_type and apply_url separately. Legacy ingest-real-data.mjs and scrape-fast.mjs build static job data from Ashby jobUrl, Greenhouse absolute_url and Lever url, without destination verification.

## Consumer coverage

Next search list/detail, recommended list, Pro single/country/batch lean/full, top10, Netlify search list/detail and client fallback serializers carry the hint only on an entitled application URL. Guest/Free see unknown with no domain/token disclosure. UI recomputes from the actual current URL instead of trusting a stale serialized hint. Desktop and phone cards label registered ATS, aggregator or unverified links; detail makes the initial-URL limitation visible. Source Feed is explicitly separate. Existing External tab membership is unchanged, not relabeled as destination proof.

Tests cover actual Arbeitnow, Adzuna, Remotive and RemoteOK adapter output using local response fixtures, five feed-to-registered-ATS serializer cases, ATS-to-aggregator cases, masked entitlement cases and spoofed serialized-hint UI cases. These are offline tests, not live provider or redirect verification. Remaining unsupported ATS hosts deliberately stay unknown.
