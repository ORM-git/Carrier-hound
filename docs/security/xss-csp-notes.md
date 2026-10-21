# Security PR 3: XSS, CSP, AI-Input Injection & Resume Upload Hardening Notes

## 1. XSS Audit & Remediation (`src/`)

### 1.1 Static Audit of DOM Sinks (`dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`)
- `dangerouslySetInnerHTML`: **0 occurrences** in `src/`.
- `insertAdjacentHTML`: **0 occurrences** in `src/`.
- `document.write`: **0 occurrences** in `src/`.
- `eval` / `new Function`: **0 occurrences** in `src/`.
- `innerHTML`: **1 benign occurrence** at [`src/components/JobRadarGlobe.tsx:575`](file:///d:/Carrer-hound/src/components/JobRadarGlobe.tsx#L575) (`container.innerHTML = ""` used only to clear the Three.js WebGL canvas mount node on cleanup).

### 1.2 Dynamic `href` / `window.open` & Export Sinks Audited and Hardened
All dynamic URLs and export templates built from user or job data were audited and hardened via [`src/lib/security/xss.ts`](file:///d:/Carrer-hound/src/lib/security/xss.ts):

| File & Line | Sink / Surface | Vulnerability Before Fix | Fix Applied |
| :--- | :--- | :--- | :--- |
| [`src/app/jobs/detail/page.tsx:232-238`](file:///d:/Carrer-hound/src/app/jobs/detail/page.tsx#L232-L238) | `window.open(job.applyUrl, "_blank", "noopener,noreferrer")` | Unvalidated `job.applyUrl` scheme allowed `javascript:` or `data:` URLs | Validated via `sanitizeExternalUrl(job.applyUrl)` (allows only `http:`, `https:`, `mailto:`) |
| [`src/app/jobs/detail/page.tsx:652`](file:///d:/Carrer-hound/src/app/jobs/detail/page.tsx#L652) | `{job.description}` in Role Overview | Raw HTML tags in scraped descriptions could display unstripped | Wrapped with `stripHtmlAndExecutableMarkup(job.description)` and rendered as plain text |
| [`src/app/tracker/page.tsx:448-458, 696-706, 798-808`](file:///d:/Carrer-hound/src/app/tracker/page.tsx#L448-L808) | `<a href={item.applyUrl}>` & `<a href={app.applyUrl}>` | User-entered or job-synced `applyUrl` was not scheme-validated | Guarded with `sanitizeExternalUrl(...)` and `rel="noopener noreferrer"` |
| [`src/lib/tracker/storage.ts:153-160`](file:///d:/Carrer-hound/src/lib/tracker/storage.ts#L153-L160) | `addApplicationToTracker` | Stored raw `title`, `company`, `notes`, and `applyUrl` without sanitization | Sanitized via `sanitizeTrackerApplicationRecord(app)` before local/Supabase persistence |
| [`src/components/JobPreview.tsx:76-80`](file:///d:/Carrer-hound/src/components/JobPreview.tsx#L76-L80) | `<a href={job.applyUrl}>` | Unvalidated scheme on preview apply link | Sanitized via `sanitizeExternalUrl(job.applyUrl) \|\| "#"` with `rel="noopener noreferrer"` |
| [`src/components/JobRadarGlobe.tsx:1666-1670`](file:///d:/Carrer-hound/src/components/JobRadarGlobe.tsx#L1666-L1670) | `<a href={job.applyUrl}>` | Unvalidated scheme on radar drawer apply link | Sanitized via `sanitizeExternalUrl(job.applyUrl) \|\| "#"` with `rel="noopener noreferrer"` |
| [`src/components/matcher/FitDiagnosticsModal.tsx:309-319`](file:///d:/Carrer-hound/src/components/matcher/FitDiagnosticsModal.tsx#L309-L319) | `<a href={job.apply_url}>` | Unvalidated scheme on modal apply link | Guarded with `sanitizeExternalUrl(job.apply_url)` and `rel="noopener noreferrer"` |
| [`src/app/admin/page.tsx:240-250`](file:///d:/Carrer-hound/src/app/admin/page.tsx#L240-L250) | `<a href={page.path} target="_blank">` | Analytics `page.path` lacked relative-path enforcement and `noopener` | Sanitized with `sanitizeInternalPath(page.path)` and `rel="noopener noreferrer"` |
| [`src/components/resume/CoverLetterModal.tsx:150-165`](file:///d:/Carrer-hound/src/components/resume/CoverLetterModal.tsx#L150-L165) | `handleDownloadDoc` HTML `.doc` export | Interpolated unescaped `${job.company}` in `<title>` and `${content}` in `<body>` | Replaced with `buildCoverLetterDocHtml(job.company, content)` (escapes `&`, `<`, `>`, `"`, `'`) and `sanitizeDownloadFilename` |
| [`src/lib/resume/tailor.ts:326, 517, 663`](file:///d:/Carrer-hound/src/lib/resume/tailor.ts#L326-L688) & [`src/lib/resume/atsPdfGenerator.ts:53, 222`](file:///d:/Carrer-hound/src/lib/resume/atsPdfGenerator.ts#L53-L350) | Resume/Cover Letter `.docx`, `.pdf`, `.txt` exports | Raw candidate/job fields and download filenames | Sanitized via `sanitizeCandidateProfile`, XML escaping (`escapeXml`), and `sanitizeDownloadFilename` |
| [`src/lib/api/jobs.ts:213-231`](file:///d:/Carrer-hound/src/lib/api/jobs.ts#L213-L231) & [`src/lib/jobs/service.ts:419-426, 525-540`](file:///d:/Carrer-hound/src/lib/jobs/service.ts#L419-L540) | Live job mapping | Raw database `title`, `company`, `description`, `apply_url` | Sanitized with `stripHtmlAndExecutableMarkup` and `sanitizeExternalUrl` |

---

## 2. Automated XSS Verification (`scripts/test-xss-csp-ai-uploads.ts`)

Automated tests in [`scripts/test-xss-csp-ai-uploads.ts`](file:///d:/Carrer-hound/scripts/test-xss-csp-ai-uploads.ts) verify that `<script>alert(1)</script>`, `<img src=x onerror=alert(1)>`, `"><svg onload=alert(1)>`, `javascript:alert(1)`, `data:text/html,<script>alert(1)</script>`, and HTML-formatted job titles/descriptions/companies are stripped or rendered as inert text across all 7 surfaces:
1. **Job Cards**
2. **Job Detail**
3. **Application Tracker**
4. **Resume Preview & Tailored Resume**
5. **Cover Letter Generation & Validation**
6. **PDF / DOC / DOCX Exports**
7. **Admin Pages**

Includes a negative control (`npx tsx scripts/test-xss-csp-ai-uploads.ts --negative-control`) that exits with code `1`.

---

## 3. Content Security Policy (CSP) Hardening

See [`docs/security/csp.md`](file:///d:/Carrer-hound/docs/security/csp.md) for full details:
- Removed `'unsafe-eval'` from `script-src` in [`public/_headers`](file:///d:/Carrer-hound/public/_headers) and [`netlify.toml`](file:///d:/Carrer-hound/netlify.toml).
- Enforced `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`, and `object-src 'none'`.
- Added `Content-Security-Policy-Report-Only` header for staged policy testing and documented why `'unsafe-inline'` in `script-src` is required by Next.js 14 `output: "export"` inline RSC hydration scripts.

---

## 4. AI-Input Injection & Output Validation (`src/lib/ai/security.ts`)

### Places Where User or Job Text Enters an LLM Call
All LLM calls are constructed exclusively server-side in [`src/lib/ai/security.ts:153-425`](file:///d:/Carrer-hound/src/lib/ai/security.ts#L153-L425) (`buildOperationPayload`) and executed in [`src/app/api/ai/route.ts`](file:///d:/Carrer-hound/src/app/api/ai/route.ts) and [`netlify/functions/ai.ts`](file:///d:/Carrer-hound/netlify/functions/ai.ts):
1. `cover_letter`: `candidate.name`, `candidate.headline`, `candidate.summary`, `candidate.skills`, `candidate.experience`, `job.title`, `job.company`, `job.description`.
2. `resume_extraction`: `params.rawText` (extracted resume text).
3. `resume_tailor`: `candidate.name`, `candidate.summary`, `candidate.skills`, `job.title`, `job.company`, `job.description`.
4. `job_fit`: `candidate.headline`, `candidate.skills`, `job.title`, `job.company`, `job.description`.

### Controls Implemented
- **Control Character Stripping & Secret Redaction**: `sanitizeAiInputText` strips ASCII control chars (`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`), redacts secret patterns (`gsk_`, `sk-`, `sb_secret_`, JWTs), and strips XML delimiter breakout tags (`</untrusted_candidate_data>`, `</untrusted_job_data>`).
- **Per-Field Length Caps (`AI_FIELD_LENGTH_CAPS`)**: Enforces strict character caps on `name` (120), `headline` (200), `summary` (2,000), `skill` (80), `jobTitle` (200), `jobCompany` (150), `jobDescription` (6,000), and `rawText` (12,000), in addition to overall `maxInputTokens` limits.
- **System-Level Untrusted Data Boundary (`UNTRUSTED_DATA_SYSTEM_GUARD`)**: Instructs the model that all content inside `<untrusted_candidate_data>` and `<untrusted_job_data>` is passive data only and never executable instructions.
- **Output Schema Validation & HTML Stripping (`validateAndSanitizeAiOutput`)**: Rejects system-prompt leaks, strips `<script>`/`<img>`/`<svg>`/event-handler markup from all string fields, and validates strict JSON schemas for `resume_extraction`, `resume_tailor`, and `job_fit`.

---

## 5. Resume Upload Path Hardening (`src/lib/resume/parser.ts` & `src/components/resume/ResumeUploadAndConfirm.tsx`)

- **Malicious Filenames (`<img src=x onerror=alert(1)>.pdf`)**: `validateResumeUploadFile` sanitizes filenames via `sanitizeDownloadFilename`, stripping all HTML tags and unsafe filesystem characters; filenames are never rendered as HTML.
- **Embedded PDF JavaScript**: `extractTextFromPdf` disables PDF.js `eval` (`isEvalSupported: false`) and runs `stripEmbeddedPdfJavaScript` on fallback stream decoding to strip `/JavaScript`, `/JS`, and `app.alert(...)` actions.
- **Size Limit (10 MB)**: `validateResumeUploadFile` rejects files `> 10 MB` (e.g., 50 MB test payload) and `0`-byte files before parsing.
- **Extension Allowlist (`.pdf`, `.docx`, `.txt`, `.md`)**: Rejects unsupported extensions (`.exe`, `.html`, `.svg`, `.js`) in both `ResumeUploadAndConfirm.tsx` and `extractTextFromFile`.
