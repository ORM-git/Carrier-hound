# AI Context Window Management & Token Budgeting

## 1. Overview & Context

A backend audit identified that context window management across CareerMonke AI operations was previously approximate:
- Untrusted user and job text fields were bounded only by static character caps (e.g., `rawText: 12000`, `jobDescription: 6000`).
- Token estimation relied on a naive character-based heuristic (`text.length / 3.5`).
- Long candidate resumes, lengthy job descriptions (loaded with boilerplate company blurbs, perks, and EEO disclaimers), or dense technical text could push requests beyond the LLM context window, triggering `400 Context Window Exceeded` errors at inference time or failing early with unhandled budget exceptions.

To eliminate call-time failures while maintaining strict prompt reproducibility, CareerMonke uses deterministic, token-accurate prompt trimming implemented in `src/lib/ai/tokenBudget.ts`.

---

## 2. Tokenizer Architecture

- **Package**: `js-tiktoken` (version pinned to `1.0.21` in `package.json`).
- **Encoding**: `cl100k_base` (Byte Pair Encoding vocabulary used by GPT-4, GPT-3.5-turbo, and modern open models like Llama 3).
- **Runtime Portability**: Pure JavaScript/TypeScript implementation with zero native dependencies or WebAssembly binaries, ensuring deterministic cross-platform execution across Node.js, Next.js serverless functions, Netlify Edge, and CI runners.

### Core Capabilities:
- `countTokens(text)`: Accurately counts tokens in constant time without approximations.
- `trimTextToTokens(text, maxTokens)`: Encodes text into BPE tokens, slices to the exact token limit, and decodes back to valid UTF-8 string without breaking character encodings or surrogate pairs.
- `trimPromptFields(options)`: Multi-field priority trimming engine that accepts ordered fields with explicit priority levels and trims lowest-priority fields first.

---

## 3. Per-Operation Token Caps & Rationale

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
  - This leaves ~3,450 tokens dedicated strictly to source resume text (~2,600 English words), accommodating complex technical resumes while guaranteeing the entire payload stays comfortably within fast inference limits (8k/32k).
- **`cover_letter` (3,000 input tokens)**:
  - Generates 3–4 tailored body paragraphs (output ~350–500 tokens).
  - System prompt, critical grounding rules, and worked examples require ~480 tokens.
  - The remaining ~2,520 tokens easily fit candidate skills, work history, summary, and target job description.
- **`job_fit` (Match Explanation) (3,000 input tokens)**:
  - System prompt, scoring rubric (0–100 integer), gap analysis instructions, and JSON schema consume ~460 tokens.
  - Candidate headline/skills and target job title/company/description take up to ~2,540 tokens. Output requires up to 1,000 tokens for detailed rationale and missing skills.
- **`resume_tailor` (4,000 input tokens)**:
  - Candidate work experience bullets, skills taxonomy, and target job description require a higher input budget. Output allows up to 2,000 tokens for comprehensive bullet rewrites.

---

## 4. Field Trimming Priority Order

### The Inviolable Rule: Protected Directives Are NEVER cut
Under no circumstances are system instructions, zero-hallucination constraints, JSON schema specifications, worked example pairs, or security boundary guards (`UNTRUSTED_DATA_SYSTEM_GUARD`) truncated or modified. These components ensure AI safety, schema compliance, and injection defense. They are marked `protected: true` (or priority $\ge 100$) and are preserved in full. System instructions and output-format directives are NEVER cut.

### Priority Hierarchy: Lowest Priority Trimmed First

When an assembled request exceeds its `maxInputTokens` cap, fields are trimmed sequentially in documented priority order:

#### 1. `cover_letter`
1. **`jobDescription` (Priority 1 - lowest, trimmed first)**: Job listings frequently contain extensive corporate boilerplate, equal opportunity statements, and generic benefits lists that add minimal value for letter personalization.
2. **`candidateSummary` (Priority 2)**: Candidate's self-written summary statement. Optional narrative that can be trimmed if space is constrained.
3. **`candidateExperience` (Priority 3)**: Work history details. Trimmed only if job description and summary reductions are insufficient.
4. **`candidateSkills` (Priority 4)**: Verified skill keywords.
5. **Protected (Never Cut)**: `jobTitle`, `jobCompany`, `candidateName`, `candidateHeadline`, system prompt, worked examples, rules.

#### 2. `resume_extraction`
1. **`rawText` (Priority 1 - lowest, trimmed first)**: Sliced from the end to the exact remaining token allowance (`maxInputTokens - fixedTemplateTokens`).
2. **Protected (Never Cut)**: System extraction engine instructions, JSON schema definition, worked example, zero-hallucination rules.

#### 3. `job_fit` (Match Explanation)
1. **`jobDescription` (Priority 1 - lowest, trimmed first)**: Trimmed to fit remaining allowance.
2. **`candidateHeadline` (Priority 2)**: Optional headline text.
3. **`candidateSkills` (Priority 3)**: Verified skill keywords.
4. **Protected (Never Cut)**: `jobTitle`, `jobCompany`, system prompt, scoring rules, JSON schema.

#### 4. `resume_tailor`
1. **`jobDescription` (Priority 1 - lowest, trimmed first)**: Trimmed to fit remaining allowance.
2. **`candidateSummary` (Priority 2)**.
3. **`candidateExperience` (Priority 3)**.
4. **`candidateSkills` (Priority 4)**.

---

## 5. Behavior on Normal / Short Inputs (Prompt Reproducibility)

When inputs are within budget (which applies to normal user requests and all test fixtures in `scripts/test-prompt-template-versions.ts`):
- Trimming is completely bypassed.
- No string modifications, slices, or allocations occur.
- The assembled prompt is **100% byte-for-byte identical** to untrimmed templates.
- SHA-256 template fingerprints remain identical, ensuring zero regression across the prompt versioning registry.

---

## 6. How to Adjust Token Caps

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
   Reflect the updated cap and rationale in Section 3 of this document.
4. **Verify Offline Guard Suite**:
   Run `npx tsx scripts/test-token-budget.ts` and `npx tsx scripts/test-prompt-template-versions.ts` to ensure all tests pass.
