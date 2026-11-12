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
  1. **`resume_extraction`**: `validateAndSanitizeAiOutput` validates only JSON shape/types and strips HTML. The model can fabricate employers, job titles, dates/keywords, bullet metrics, schools/degrees, certifications, or skills absent from the source `rawText`, or reassign roles/dates/metrics across employers.
  2. **`cover_letter`**: Neither `validateAndSanitizeAiOutput("cover_letter", ...)` nor `validateCoverLetter` separates candidate facts from job-description facts (e.g. laundering target company employment or JD numbers into candidate achievements) or checks general taxonomy skills cleanly without breaking honest disclaimers.
  3. **`job_fit` (Match Explanation)**: `validateAndSanitizeAiOutput("job_fit", ...)` only clamps `score` (`0–100`) and validates string array types. The model can put non-candidate skills in `matchedSkills`, contradict the resume by putting evidenced candidate skills in `missingSkills`, invent missing skills not present in `job`, or attribute JD requirements to the candidate in `summary`.

---

## 2. Checkable Claims vs. Input Payloads (Per Operation)

### 2.1 `resume_extraction` (Source Payload: `rawText`)
All extracted fields represent factual claims derived exclusively from the uploaded resume text (`rawText`):

| Output Field | Checkable Claim | Source Containment Criterion |
| :--- | :--- | :--- |
| `name`, `email`, `phone` | Identity & contact info | Case-insensitive substring (`email`), digits-only match (`phone`), token containment (`name`) in `rawText`. |
| `skills[]` | Technical / domain skills | Canonical skill match (`areSkillsGenuineMatch` / alias boundary match) OR normalized phrase containment in `rawText`. |
| `experience[].company`, `.role` | Employer names & titles | Company must appear in `rawText`; when an employer segment can be isolated in `rawText`, `.role`, dates, and bullets are checked within that employer's segment to catch cross-employer reassignment. |
| `experience[].startDate`, `.endDate` | Employment years & date keywords | Extracted 4-digit years `(19\|20)\d{2}`, ongoing/current keywords (`Present`, `Current`, `Ongoing`, `Now`, `Till Date`, `To Date`), and month names (`Jan`–`Dec` / `January`–`December` + `MM/YYYY`) must appear in the employer segment (or `rawText`). |
| `experience[].bullets[]` | Quantitative metrics & tools | Numeric metrics (`%`, `$`, multipliers, counts, years) and canonical `SKILLS_TAXONOMY` mentions must appear in the employer segment (or `rawText`). |
| `education[].institution`, `.degree`, `.year` | Academic history | Normalized institution, degree tokens, and graduation years/date keywords must appear in `rawText`. |
| `certifications[]` | Credentials | Normalized credential phrase (or canonical identifier) must appear in `rawText`. |
| `headline`, `summary` | Profile overview | Numeric facts and canonical taxonomy skills mentioned in extracted overview must appear in `rawText`. |

### 2.2 `cover_letter` (Source Payload: `candidate` + `job`, Separate Pools)
Prose generated for the target application must keep **candidate evidence** and **target job context** in strictly separate pools:

| Claim Category | Source Containment Criterion | Notes / Boundaries |
| :--- | :--- | :--- |
| **Contacts & URLs** | Emails must match `candidate.email`; phone digits must match `candidate.phone`; URLs must appear in `candidate` or `job` text. | Prevents fabricated LinkedIn/portfolio URLs or wrong contact info. |
| **Candidate Skills / Tools in Prose** | `job.title` is exempted **only inside explicit greeting, header (`Re:`/`Position:`), or application-intent spans** (never globally). Every positive `SKILLS_TAXONOMY` mention outside those spans must be evidenced in `candidate`. Honest negated/aspirational clauses (e.g. `"have not used Kubernetes yet, and want to learn it"`) are skipped rather than counted as capability claims. | Prevents `"I am a Kubernetes Engineer"` or JD body skills from passing, while avoiding false errors on honest learning disclaimers. |
| **Numeric Facts & Years of Experience** | Numeric metrics and tenure/years phrases in prose are verified strictly against `candidate` numbers only — `job.description` numbers sit in a **separate pool** and cannot validate achievements (e.g. `"I increased revenue by 80%"`). | Prevents JD growth targets or experience minimums from being laundered into candidate achievements. |
| **Named Employers & Institutions** | Strict employment/study cues (`worked at`, `employed at`, `formerly at`, `graduated from`, etc.) check `candidate` organizations **only** (`experience[].company` + `education[].institution`). `job.company` is allowed **only** for role-at cues explicitly preceded by an application-target phrase (`"apply for Senior Engineer at <Company>"`). | Prevents `"I worked at <TargetCompany>"` from passing as candidate employment. |

### 2.3 `job_fit` — Match Explanation (Source Payload: `candidate` + `job`)
Recall from `src/lib/ai/groq.ts` that `job_fit` receives `candidate` (`headline`, `skills`, and server-side optional full `CandidateProfile`) and `job` (`title`, `company`, `description`):

| Output Field | Checkable Claim | Source Containment Criterion |
| :--- | :--- | :--- |
| `matchedSkills[]` | Claimed candidate-job overlap | Must be genuinely evidenced in `candidate`; when `job` text (`title` + `description`) is non-empty, must also appear in `job`. Uses strict boundary rules (`React != React Native`, `Java != JavaScript`, `SQL != PostgreSQL`). |
| `missingSkills[]` | Claimed skill gaps | **No contradiction**: must **not** already be evidenced in `candidate`. When `job` text is non-empty, must actually appear in `job` (no invented job requirements). |
| `summary` | Natural-language rationale with subject ownership | Summary prose is split into clauses and classified by **subject ownership**: candidate-attributed / default clauses (e.g. `"Candidate has Kubernetes expertise"`) require evidence in `candidate` only; explicit gap clauses (`"lacks ..."`) must be absent from `candidate` and present in `job`; explicit job-requirement clauses (`"role requires ..."`) check `job`; strict employment org cues require `candidate` organizations; numeric facts follow the attributed pool (except echoed `score` percentages). |

### 2.4 Explicit v1 Scope Limits & Semantic Boundaries
- **Lexical support is NOT semantic entailment**: Deterministic offline checks test lexical token, alias, numeric, and segmented entity containment. A response passing these checks is **not** logically guaranteed to entail its source — prose can invert causality, exaggerate ownership, or paraphrase inaccurately while sharing surface tokens.
- **No silent pass on empty or uncheckable inputs (`inconclusive`, never `faithful`)**: Missing/invalid input or output shapes (`{}`, non-object payloads, empty strings) and outputs yielding `checkedCount === 0` (including standalone negated/aspirational text with zero verified positive claims) MUST return `verdict: "inconclusive"` and `faithful: false`.
- **Relation verification limits**: In `resume_extraction`, cross-employer relation checks (`role`, `startDate`/`endDate`, bullet metrics/skills paired to `.company`) use heuristic line and comma/semicolon clause segmentation (`relationsVerified: "verified_segmented"` vs `"unverified_unsegmented"`). In multi-company prose paragraphs without clear entry boundaries, relations fall back to document-level checking and are explicitly reported as `"unverified_unsegmented"` in `FaithfulnessReport`.
- **Date normalization limits**: Checks validate 4-digit years, ongoing keywords (`Present`, `Current`, `Ongoing`, `Now`, `Till Date`, `To Date`), and month names (`Jan`–`Dec` / numeric `MM/YYYY` or `YYYY-MM`). Relative timeframes (`"last year"`, `"over two summers"`, quarters `"Q3"`) are not resolved semantically.
- **Attribution & negation heuristic limits**: Application-context spans, clause subject ownership, and negated/aspirational detection use bounded syntactic regexes. Complex nested clauses, sarcasm, or multi-sentence pronoun coreference outside a clause can still misclassify edge cases or yield `inconclusive`.
- **Subjective prose**: Tone, enthusiasm, and paraphrased non-numeric narrative without taxonomy or entity claims are outside offline verification scope unless a future curated LLM judge tier is added.

---

## 3. Offline Verifier Design (`src/lib/ai/faithfulness.ts`)

`src/lib/ai/faithfulness.ts` provides standalone, side-effect-free pure functions with **no model calls, no network I/O, and no global state**:

- **Shared Containment & Attribution Primitives**:
  - `normalizeContainmentText(text)` — case-folds, normalizes whitespace/punctuation while retaining tech symbols (`+`, `#`, `.`, `/`).
  - `extractNumericFactsFromText(text)` — extracts numbers, percentages, multipliers, `$` amounts, and 4-digit years with comma stripping (`10,000` -> `10000`) and `+` tolerance.
  - `extractTaxonomySkillsFromText(text)` — boundary-safe scan over `SKILLS_TAXONOMY` with explicit disambiguation (`react` vs `react native`, `java` vs `javascript`, uppercase `Go`/`REST`/`Shell`).
  - `isCanonicalSkillSupported(skill, corpusText, explicitSkills)` — delegates to `areSkillsGenuineMatch`, `getCanonicalSkillId`, and `GENUINE_SKILL_ALIASES` (`src/lib/matcher/scoring.ts`).
  - `isPhraseContained(sourceNormalized, candidatePhrase)` — handles minor hyphen/punctuation drift and multi-token overlap for company/role/degree names.
  - `extractOrganizationMentionsWithContext(text)` / `extractOrganizationMentions(text)` — separates strict prior-employment/study cues from application-target role cues (`apply for <role> at <company>`).
  - `maskJobTitleInApplicationSpans(text, job)` — strips `job.title` strictly inside headers, salutations, or application-intent phrases.
- **Per-Operation Entrypoints & Dispatcher**:
  - `verifyResumeExtractionFaithfulness(extracted, rawText): FaithfulnessReport`
  - `verifyCoverLetterFaithfulness(letterText, candidate, job): FaithfulnessReport`
  - `verifyMatchExplanationFaithfulness(explanation, candidate, job): FaithfulnessReport`
  - `verifyAiOutputFaithfulness(operation, output, sourceInput): FaithfulnessReport`
- **Deterministic Verdict Shape (`FaithfulnessReport`)**:
  - `{ faithful: boolean, verdict: "faithful" | "unfaithful" | "inconclusive", operation, violations, inconclusiveReasons, relationsVerified, limitations, checkedCount, supportedCount }` where `faithful` is `true` **only** when `verdict === "faithful"`.

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
                 ├── Shadow mode: log structured warning + violation/inconclusive codes (no failure)
                 └── Enforced mode (post-golden-eval only): reject unfaithful -> HTTP 502 + quota/budget rollback
```

**Prerequisite context propagation**:
1. Pass `{ rawText, candidate, job }` reliably through `validateAndSanitizeAiOutput(..., context)` inside `executeAiCore` (and keep `validateCoverLetter` / deterministic fallbacks in `src/lib/ai/groq.ts` aligned so client-side cover letter fallback still recovers cleanly on rejection).
2. Add a small structured observability event (`ai.faithfulness.verdict`) recording only operation name, `verdict`, violation `kind`, and `relationsVerified` status (never logging raw PII, resume text, or cover letter text).

---

## 5. Staged Rollout Order (Shadow + Golden Evals Before Any Enforcement)

1. **Stage 0 (This PR)**: Land `docs/hallucination-guard-design.md`, pure verifier `src/lib/ai/faithfulness.ts`, Vitest unit & adversarial tests, and offline suite registration (`scripts/test-faithfulness.ts`) with zero runtime changes.
2. **Stage 1 — Golden Eval Dataset + Shadow-Only Rollout (`job_fit`, `resume_extraction`, `cover_letter`)**: **Do not enforce-first on any operation before golden eval tests exist.** First expand `scripts/eval-ai-output-golden.ts` with labeled positive, fabricated, negated/aspirational, cross-employer, and `inconclusive` fixtures across all three operations, and wire `verifyAiOutputFaithfulness` in **log-only shadow mode** (`warn` telemetry, zero request rejection) to measure precision, OCR/punctuation false positives, and `inconclusive` rates against anonymized traffic counts.
3. **Stage 2 — Gate Blocking Enforcement Per Operation After Golden + Shadow Sign-Off**: Only after golden eval regression gates pass and shadow telemetry shows acceptable false-positive margins, promote operations one by one from shadow to enforcement, rejecting hard `verdict === "unfaithful"` outputs with deterministic safe fallbacks (`parseResumeText`, `fallbackGenerateCoverLetter`, or HTTP 502 + quota/budget rollback) and an explicit per-operation policy for `verdict === "inconclusive"`.
