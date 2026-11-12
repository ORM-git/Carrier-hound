# AI Context Window Management & Token Budgeting

## 1. Overview & Context

A backend audit identified that context window management across CareerMonke AI operations was previously approximate:
- Untrusted user and job text fields were bounded by static character caps (`jobDescription: 6000`, `rawText: 12000`, `summary: 2000`, etc.).
- Token estimation relied on a naive character-based heuristic (`estimateTokens: Math.ceil(text.length / 3.5)`).
- Long candidate resumes, lengthy job descriptions (loaded with boilerplate company blurbs, perks, and EEO disclaimers), or dense technical text could push requests beyond LLM context windows, triggering `400 Context Window Exceeded` errors at inference time or failing early with unhandled budget exceptions.

To eliminate call-time failures while maintaining strict prompt reproducibility, CareerMonke uses deterministic, token-accurate prompt trimming implemented in `src/lib/ai/tokenBudget.ts`.

---

## 2. Tokenizer Architecture & Bundle Size Optimization

- **Package**: `js-tiktoken` (version pinned strictly to `1.0.21` in `package.json`).
- **Selective Modular Import**:
  - The top-level `js-tiktoken` import bundles all six vocabulary ranks (`cl100k_base`, `gpt2`, `o200k_base`, `p50k_base`, `p50k_edit`, `r50k_base`) totaling approximately **5.6 MB** uncompressed.
  - To minimize serverless bundle sizes and avoid bundling unused vocabularies, `src/lib/ai/tokenBudget.ts` imports only the lightweight engine and the isolated `cl100k_base` ranks:
    ```ts
    import { Tiktoken } from "js-tiktoken/lite";
    import cl100k_base from "js-tiktoken/ranks/cl100k_base";
    ```
  - **Resulting Bundle Size**: Only the `cl100k_base` dictionary (~1.09 MB) is loaded. This eliminates ~4.5 MB of dead vocabulary data, optimizing cold starts for Netlify functions and serverless runtimes.
- **Runtime Portability**: Pure JavaScript/TypeScript implementation with zero native dependencies or WebAssembly binaries, ensuring deterministic cross-platform execution across Node.js, Next.js serverless functions, Netlify Edge, and CI runners.
- **Approximation & Safety Margin vs Configured Models**:
  - The tokenizer uses the `cl100k_base` BPE vocabulary.
  - Configured models in production include `gpt-oss-120b` and `gpt-oss-20b` (or open-weights architectures).
  - Because BPE token boundaries differ across model families, `cl100k_base` token counts represent an **approximation with a safety margin**, not provider-exact token counts. The per-operation token caps are engineered with sufficient headroom (500–1,000 token buffers) to prevent any context window overrun regardless of tokenization differences.

### Core Capabilities:
- `countTokens(text)`: Accurately counts tokens using `cl100k_base` BPE. Treats special tokens (such as `<|endoftext|>`, `<|fim_prefix|>`, `<|im_start|>`) as plain text (`allowedSpecial: []`, `disallowedSpecial: []`) so untrusted user text never throws special-token runtime exceptions.
- `trimTextToTokens(text, maxTokens)`: Encodes text into BPE tokens, slices to the designated token limit, and decodes back to string.
  - **UTF-8 Character Boundary Guarantee**: Slicing tokens across multi-byte character boundaries (e.g. 4-byte emojis or complex Unicode symbols) could produce incomplete byte sequences that decode to the Unicode replacement character `\uFFFD`. `trimTextToTokens` automatically backs off token-by-token until the decoded string contains no `\uFFFD`, guaranteeing clean character boundaries.
- `trimPromptFields(options)`: Multi-field priority trimming engine that accepts ordered fields with explicit priority levels and trims lowest-priority fields first.

---

## 3. Two-Tier Defense: Static Character Caps + Token Trimming

CareerMonke enforces a **two-tier defense** for context window safety:

1. **Tier 1 — Static Character Length Caps (`AI_FIELD_LENGTH_CAPS`)**:
   - `src/lib/ai/security.ts` maintains its established character caps: `name: 120`, `headline: 200`, `summary: 2000`, `jobDescription: 6000`, `rawText: 12000`, etc.
   - These character limits act as the primary, coarse boundary guard before prompt assembly.
2. **Tier 2 — Token-Accurate Trimming Safety Net**:
   - Acts as the second, stricter safety net to ensure the combined, assembled prompt (including system prompt, worked examples, candidate facts, and delimiters) stays strictly under `maxInputTokens`.
   - **Honest Note on Trigger Rates**: For standard English text, 6,000 characters corresponds to ~1,200–1,500 tokens, and 12,000 characters corresponds to ~2,400–3,500 tokens. As a result, for operations with modest input sizes, the Tier 1 character caps alone keep total tokens comfortably within the 3,000–4,000 token caps during ordinary single-field usage. Tier 2 token trimming primarily activates when multiple long candidate fields accumulate simultaneously, when dense multi-byte Unicode or code snippets are present, or when small context windows converge.

---

## 4. Quota Accounting & Token Reservation Behavior

- In `src/lib/ai/serviceHandler.ts`, `payload.estimatedInputTokens` feeds:
  1. The upfront global token reservation: `Math.max(1, (payload.estimatedInputTokens || 0) + (payload.maxOutputTokens || 0))`
  2. The post-inference quota refund / reconciliation: `refundAiQuota(supabaseAdmin, user.id, config.operation, payload.estimatedInputTokens)`
- **Preservation of Established Accounting**:
  - `buildOperationPayload` continues to compute `payload.estimatedInputTokens` using the established baseline heuristic:
    ```ts
    const estimatedInputTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);
    ```
  - This ensures that quota reservations, token accounting, and usage metrics remain completely stable and drift-free against all existing billing and rate-limiting baselines.
  - Meanwhile, the authoritative gate verifies that true BPE tokens (`countTokens(systemPrompt) + countTokens(userPrompt)`) never exceed `config.maxInputTokens`.

---

## 5. Per-Operation Token Caps & Rationale

| Operation | Aliases | Model Tier | Max Input Tokens | Max Output Tokens | Total Context Bound | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `resume_extraction` | `extract_resume` | Fast Model | **4,000** | 2,500 | 6,500 | Zero-hallucination fact extraction from raw resumes |
| `cover_letter` | `cover-letter` | Smart Model | **3,000** | 1,000 | 4,000 | Factual tailored cover letter body paragraphs |
| `job_fit` | `match_score`, `fit_analysis` | Fast Model | **3,000** | 1,000 | 4,000 | Match explanation, gap analysis, and rubric score |
| `resume_tailor` | `tailor_resume` | Smart Model | **4,000** | 2,000 | 6,000 | Bullet point rewrite grounded in candidate facts |

### Rationale:
- **`resume_extraction` (4,000 input tokens)**:
  - Multi-page resumes (1–5 pages) typically range between 1,500 and 3,500 words.
  - System instructions, zero-hallucination rules, candidate JSON schema, and worked examples consume ~550 tokens.
  - Slices `rawText` to the remaining allowance so extraction never fails due to long resumes.
- **`cover_letter` (3,000 input tokens)**:
  - Generates 3–4 tailored body paragraphs (output ~350–500 tokens).
  - System prompt, critical grounding rules, and worked examples require ~480 tokens.
  - Slices `jobDescription` first, then `candidateSummary`, `candidateExperience`, and `candidateSkills`.
- **`job_fit` (Match Explanation) (3,000 input tokens)**:
  - System prompt, scoring rubric (0–100 integer), gap analysis instructions, and JSON schema consume ~460 tokens.
  - Trims `jobDescription` first, then `candidateHeadline`, then `candidateSkills`.
- **`resume_tailor` (4,000 input tokens)**:
  - Candidate work experience bullets, skills taxonomy, and target job description require a higher input budget.
  - Trims `jobDescription` first, then falls back to trimming `candidateSummary`, `candidateExperience`, and `candidateSkills` using real token counts.

---

## 6. Field Trimming Priority Order

### The Inviolable Rule: Protected Directives Are NEVER cut
Under no circumstances are system instructions, zero-hallucination constraints, JSON schema specifications, worked example pairs, or security boundary guards (`UNTRUSTED_DATA_SYSTEM_GUARD`) truncated or modified. These components ensure AI safety, schema compliance, and injection defense. System instructions and output-format directives are NEVER cut.

### Priority Hierarchy: Lowest Priority Trimmed First

#### 1. `cover_letter`
1. **`jobDescription` (Priority 1 - lowest, trimmed first)**: Job listings frequently contain extensive corporate boilerplate, equal opportunity statements, and generic benefits lists that add minimal value for letter personalization.
2. **`candidateSummary` (Priority 2)**: Candidate's self-written summary statement.
3. **`candidateExperience` (Priority 3)**: Work history details.
4. **`candidateSkills` (Priority 4)**: Verified skill keywords.
5. **Protected (Never Cut)**: `jobTitle`, `jobCompany`, `candidateName`, `candidateHeadline`, system prompt, worked examples, rules.

#### 2. `resume_extraction`
1. **`rawText` (Priority 1 - lowest, trimmed first)**: Sliced from the end to the exact remaining token allowance.
2. **Protected (Never Cut)**: System extraction engine instructions, JSON schema definition, worked example, zero-hallucination rules.

#### 3. `job_fit` (Match Explanation)
1. **`jobDescription` (Priority 1 - lowest, trimmed first)**: Trimmed to fit remaining allowance.
2. **`candidateHeadline` (Priority 2)**: Optional headline text.
3. **`candidateSkills` (Priority 3)**: Verified skill keywords.
4. **Protected (Never Cut)**: `jobTitle`, `jobCompany`, system prompt, scoring rules, JSON schema.

#### 4. `resume_tailor`
1. **`jobDescription` (Priority 1 - lowest, trimmed first)**: Trimmed to fit remaining allowance.
2. **`candidateSummary` (Priority 2)**: Trimmed if job description reduction is insufficient.
3. **`candidateExperience` (Priority 3)**: Work history bullets trimmed if summary reduction is insufficient.
4. **`candidateSkills` (Priority 4)**: Verified skills list trimmed if experience reduction is insufficient.
5. **Protected (Never Cut)**: `candName`, `candHeadline`, `jobTitle`, `jobCompany`, system prompt, worked examples, schema.

---

## 7. Behavior on Normal / Short Inputs (Prompt Reproducibility)

When inputs are within budget (which applies to normal user requests and all test fixtures in `scripts/test-prompt-template-versions.ts`):
- Trimming is completely bypassed.
- No string modifications, slices, or allocations occur.
- The assembled prompt is **100% byte-for-byte identical** to untrimmed templates.
- SHA-256 template fingerprints remain identical, ensuring zero regression across the prompt versioning registry.

---

## 8. How to Adjust Token Caps

To modify the context window budget for any operation:
1. **Update `OPERATION_CONFIGS` in `src/lib/ai/security.ts`**:
   ```ts
   export const OPERATION_CONFIGS: Record<AllowedAiOperation, OperationConfig> = {
     cover_letter: {
       ...
       maxInputTokens: 3500, // Updated cap
     },
   };
   ```
2. **Update `OPERATION_TOKEN_CAPS` in `src/lib/ai/tokenBudget.ts`**:
   ```ts
   export const OPERATION_TOKEN_CAPS = {
     cover_letter: 3500,
     ...
   };
   ```
3. **Update Documentation**:
   Reflect the updated cap and rationale in Section 5 of this document.
4. **Verify Offline Guard Suite**:
   Run `npx tsx scripts/test-token-budget.ts` and `npx tsx scripts/test-prompt-template-versions.ts` to ensure all tests pass.
