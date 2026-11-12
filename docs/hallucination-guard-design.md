# Hallucination Guard Design: Source-Payload Faithfulness Verification

**Status**: Design Specification + Offline Pure Verifier Module (`v1`, unwired)  
**Scope**: Server and client AI output verification across `resume_extraction`, `cover_letter`, and `job_fit` (complementing existing `resume_tailor` deep validation)  
**Design Constraints**: Deterministic offline checks in `v1` — **zero extra LLM calls**, zero network requests, zero database lookups, pure functions only.

---

## 1. Background & Gap Summary

The backend audit marks hallucination guards as **PARTIAL**:

- **What already exists**:
  - Untrusted delimiter isolation (`<untrusted_candidate_data>`, `<untrusted_job_data>`) and input length/token caps in `src/lib/ai/security.ts` and `src/lib/ai/tokenBudget.ts`.
  - HTML/script stripping, prompt-leak detection, and JSON schema shape checks in `validateAndSanitizeAiOutput` (`src/lib/ai/security.ts`).
  - `resume_tailor` deep grounding via `validateTailoredResumeOutput` (`src/lib/ai/security.ts`): skill taxonomy containment (`SKILLS_TAXONOMY` + `GENUINE_SKILL_ALIASES`), per-bullet numeric fact equality (`numericFactsMatch`), and cross-employer fact transfer checks.
  - Cover letter heuristics via `validateCoverLetter` (`src/lib/resume/tailor.ts`): email/phone matching, URL rejection, fresher-years pattern, `worked at <Company>` check, and 3 platform/microservice phrases.
- **What is missing (no general faithfulness check)**:
  1. **`resume_extraction`**: `validateAndSanitizeAiOutput` validates only JSON shape/types and strips HTML. The model can fabricate employers, job titles, dates, bullet metrics, schools/degrees, certifications, or skills absent from the source `rawText`.
  2. **`cover_letter`**: Neither `validateAndSanitizeAiOutput("cover_letter", ...)` nor `validateCoverLetter` checks canonical skills/tools claimed in prose against `candidate`, general numeric metrics/percentages against `candidate` + `job`, or broader organization/institution claims beyond `"worked at <X>"`.
  3. **`job_fit` (Match Explanation)**: `validateAndSanitizeAiOutput("job_fit", ...)` only clamps `score` (`0–100`) and validates string array types. The model can put non-candidate skills in `matchedSkills`, contradict the resume by putting evidenced candidate skills in `missingSkills`, invent missing skills not present in `job`, or state fabricated metrics/companies/tools in `summary`.

---

## 2. Checkable Claims vs. Input Payloads (Per Operation)

### 2.1 `resume_extraction` (Source Payload: `rawText`)
All extracted fields represent factual claims derived exclusively from the uploaded resume text (`rawText`):

| Output Field | Checkable Claim | Source Containment Criterion |
| :--- | :--- | :--- |
| `name`, `email`, `phone` | Identity & contact info | Case-insensitive substring (`email`), digits-only match (`phone`), token containment (`name`) in `rawText`. |
| `skills[]` | Technical / domain skills | Canonical skill match (`areSkillsGenuineMatch` / alias boundary match) OR normalized phrase containment in `rawText`. |
| `experience[].company`, `.role` | Employer names & titles | Normalized phrase (or non-stopword core tokens) contained in `rawText`. |
| `experience[].startDate`, `.endDate` | Employment years & dates | Every extracted 4-digit year `(19\|20)\d{2}` and explicit date keyword must appear in `rawText`. |
| `experience[].bullets[]` | Quantitative metrics & tools | Numeric metrics (`%`, `$`, multipliers, counts, years) and canonical `SKILLS_TAXONOMY` mentions must appear in `rawText`. |
| `education[].institution`, `.degree`, `.year` | Academic history | Normalized institution, degree tokens, and graduation years must appear in `rawText`. |
| `certifications[]` | Credentials | Normalized credential phrase (or canonical identifier) must appear in `rawText`. |
| `headline`, `summary` | Profile overview | Numeric facts and canonical taxonomy skills mentioned in extracted overview must appear in `rawText`. |

### 2.2 `cover_letter` (Source Payload: `candidate` + `job`)
Prose generated for the target application must stay grounded in the verified `candidate` profile and target `job` (`title`, `company`, `description`):

| Claim Category | Source Containment Criterion | Notes / Boundaries |
| :--- | :--- | :--- |
| **Contacts & URLs** | Emails must match `candidate.email`; phone digits must match `candidate.phone`; URLs must appear in `candidate` or `job` text. | Prevents fabricated LinkedIn/portfolio URLs or wrong contact info. |
| **Candidate Skills / Tools in Prose** | Every `SKILLS_TAXONOMY` skill mentioned in letter prose (outside verbatim `job.title` / `job.company` mentions) must be evidenced in `candidate` (`skills`, `headline`, `summary`, `experience`, `education`, `certifications`). | Prevents copying required skills from `job.description` (e.g. Kubernetes) as the candidate's own experience. |
| **Numeric Facts & Years of Experience** | Every numeric metric in prose must be contained in `candidate` + `job` combined facts; tenure/years-of-experience phrases (`"N years of experience"`, `"my tenure"`, `"previous roles"`) require supporting `candidate` experience & year counts. | Deterministic check without guessing paraphrased adjectives (`"extensive"`). |
| **Named Employers & Institutions** | Organizations named after employment/study cues (`worked at`, `employed at`, `formerly at`, `engineer at`, `graduated from`, etc.) must match `candidate.experience[].company`, `candidate.education[].institution`, or `job.company`. | Complements existing regex in `validateCoverLetter` with broader preposition patterns. |

### 2.3 `job_fit` — Match Explanation (Source Payload: `candidate` + `job`)
Recall from `src/lib/ai/groq.ts` that `job_fit` receives `candidate` (`headline`, `skills`, and server-side optional full `CandidateProfile`) and `job` (`title`, `company`, `description`):

| Output Field | Checkable Claim | Source Containment Criterion |
| :--- | :--- | :--- |
| `matchedSkills[]` | Claimed candidate-job overlap | Must be genuinely evidenced in `candidate`; when `job` text (`title` + `description`) is non-empty, must also appear in `job`. Uses strict boundary rules (`React != React Native`, `Java != JavaScript`, `SQL != PostgreSQL`). |
| `missingSkills[]` | Claimed skill gaps | **No contradiction**: must **not** already be evidenced in `candidate`. When `job` text is non-empty, must actually appear in `job` (no invented job requirements). |
| `summary` | Natural-language rationale | Canonical taxonomy skills, numeric metrics/years, and employer/company mentions in `summary` must be evidenced in `candidate` or `job`. Explicit score restatements (e.g. `"82%"` matching `parsed.score`) are permitted if framed as fit score rather than years/experience. |

### 2.4 Explicit v1 Scope Limits (Uncheckable Without Semantic Inference)
To preserve a near-zero false-positive rate with deterministic offline logic:
- Subjective phrasing, tone, enthusiasm, and grammatical rewording of verified responsibilities are **not** rejected.
- Domain synonyms outside `GENUINE_SKILL_ALIASES` are flagged only when they collide with `SKILLS_TAXONOMY` or introduce unsupported numbers/entities.
- Semantic contradiction between non-numeric prose statements (e.g. `"led a small team"` vs `"solo contributor"`) is deferred unless a future optional judge tier is explicitly enabled.

---

## 3. Offline Verifier Design (`src/lib/ai/faithfulness.ts`)

`src/lib/ai/faithfulness.ts` provides standalone, side-effect-free pure functions with **no model calls, no network I/O, and no global state**:

- **Shared Containment Primitives**:
  - `normalizeContainmentText(text)` — case-folds, normalizes whitespace/punctuation while retaining tech symbols (`+`, `#`, `.`, `/`).
  - `extractNumericFactsFromText(text)` — extracts numbers, percentages, multipliers, `$` amounts, and 4-digit years with comma stripping (`10,000` -> `10000`) and `+` tolerance.
  - `extractTaxonomySkillsFromText(text)` — boundary-safe scan over `SKILLS_TAXONOMY` with explicit disambiguation (`react` vs `react native`, `java` vs `javascript`).
  - `isCanonicalSkillSupported(skill, corpusText, explicitSkills)` — delegates to `areSkillsGenuineMatch`, `getCanonicalSkillId`, and `GENUINE_SKILL_ALIASES` (`src/lib/matcher/scoring.ts`).
  - `isPhraseContained(sourceNormalized, candidatePhrase)` — handles minor hyphen/punctuation drift and multi-token overlap for company/role/degree names.
  - `extractOrganizationMentions(text)` — captures organization phrases following employment/academic prepositions.
- **Per-Operation Entrypoints & Dispatcher**:
  - `verifyResumeExtractionFaithfulness(extracted, rawText): FaithfulnessReport`
  - `verifyCoverLetterFaithfulness(letterText, candidate, job): FaithfulnessReport`
  - `verifyMatchExplanationFaithfulness(explanation, candidate, job): FaithfulnessReport`
  - `verifyAiOutputFaithfulness(operation, output, sourceInput): FaithfulnessReport`
- **Deterministic Verdict Shape (`FaithfulnessReport`)**:
  - `{ faithful: boolean, operation, violations: UnverifiedClaim[], checkedCount, supportedCount }` where each violation carries `{ kind, claim, field, reason, severity }`.

---

## 4. Planned Integration Into Output-Validation Path (Future PR)

This PR does **not** wire `faithfulness.ts` into any live request path. When enabled in follow-up PRs, integration attaches inside the single server boundary so both Cloudflare Pages (`/api/ai`, `/api/ai/stream`) and Netlify (`handleNetlifyAiRequest`) share identical enforcement:

```
executeAiCore (src/lib/ai/serviceHandler.ts)
  ├── 1. buildOperationPayload(...)
  ├── 2. Upstream completion (providerAdapter)
  └── 3. validateAndSanitizeAiOutput(operation, content, context)  <-- src/lib/ai/security.ts
           ├── System prompt leak & XSS markup stripping (existing)
           ├── JSON shape & schema sanitization (existing)
           ├── validateTailoredResumeOutput(...) for resume_tailor (existing)
           └── [PLUG-IN POINT] verifyAiOutputFaithfulness(...)
                 ├── Shadow mode: log structured warning + violation codes (no failure)
                 └── Enforced mode: return { ok: false, error } -> HTTP 502 + quota/budget rollback
```

**Prerequisite context propagation**:
1. Pass `{ rawText, candidate, job }` reliably through `validateAndSanitizeAiOutput(..., context)` inside `executeAiCore` (and keep `validateCoverLetter` / deterministic fallbacks in `src/lib/ai/groq.ts` aligned so client-side cover letter fallback still recovers cleanly on rejection).
2. Add a small structured observability event (`ai.faithfulness.violation`) recording only operation name, violation `kind`, and boolean `faithful` (never logging raw PII, resume text, or cover letter text).

---

## 5. Staged Rollout Order

1. **Stage 0 (This PR)**: Land `docs/hallucination-guard-design.md`, pure verifier `src/lib/ai/faithfulness.ts`, Vitest unit tests, and offline suite registration (`scripts/test-faithfulness.ts`) with zero runtime changes.
2. **Stage 1 — `job_fit` (Enforce First)**: Lowest regression risk because `job_fit` inputs (`candidate` skills/headline + `job`) are small, structured, and easy to verify deterministically. Wire `verifyMatchExplanationFaithfulness` in `validateAndSanitizeAiOutput("job_fit", ...)`.
3. **Stage 2 — `resume_extraction` (Shadow -> Enforce)**: Start in log-only shadow mode to measure OCR/punctuation edge cases (e.g. ligatures, `"Jan 2022"` vs `"01/2022"` formatting differences) against anonymized telemetry counts, expand golden eval cases in `scripts/eval-ai-output-golden.ts`, then flip to reject ungrounded entities with safe fallback to deterministic `parseResumeText`.
4. **Stage 3 — `cover_letter` (Shadow -> Enforce)**: Deploy alongside existing `validateCoverLetter` deterministic template fallback so any rejected generation seamlessly degrades to `fallbackGenerateCoverLetter` without failing user workflows.
5. **Stage 4 — Golden Eval Regression Gate**: Lock new adversarial fixtures into `scripts/eval-ai-output-golden.ts` across all three operations before removing legacy ad-hoc checks.
