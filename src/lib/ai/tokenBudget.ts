/**
 * Token budget management and trimming utilities for CareerMonke AI operations.
 *
 * Provides accurate token counting and priority-based trimming using the pinned
 * js-tiktoken package (cl100k_base tokenizer).
 *
 * Guarantees that assembled prompts for bounded AI operations (cover letter,
 * resume extraction, match explanation) never exceed their designated context caps,
 * trimming lowest-priority fields first while never cutting system instructions,
 * worked examples, or output-format directives.
 */

import { getEncoding, Tiktoken } from "js-tiktoken";

let cachedEncoder: Tiktoken | null = null;

/**
 * Returns the singleton Tiktoken encoder instance for cl100k_base encoding.
 */
export function getTokenizer(): Tiktoken {
  if (!cachedEncoder) {
    cachedEncoder = getEncoding("cl100k_base");
  }
  return cachedEncoder;
}

/**
 * Accurately counts the number of tokens in a string using cl100k_base BPE.
 * Returns 0 for null, undefined, or empty strings.
 */
export function countTokens(text: string | null | undefined): number {
  if (!text || typeof text !== "string") return 0;
  return getTokenizer().encode(text).length;
}

/**
 * Trims text to fit within a maximum token allowance.
 *
 * - If maxTokens <= 0, returns an empty string.
 * - If text token count <= maxTokens, returns the original text untouched.
 * - Otherwise, encodes to BPE tokens, slices to maxTokens, and decodes back to string.
 */
export function trimTextToTokens(text: string | null | undefined, maxTokens: number): string {
  if (!text || typeof text !== "string" || maxTokens <= 0) return "";
  const encoder = getTokenizer();
  const tokens = encoder.encode(text);
  if (tokens.length <= maxTokens) return text;
  return encoder.decode(tokens.slice(0, maxTokens));
}

/**
 * Represents an individual prompt field with trimming priority and constraints.
 */
export interface PromptField {
  name: string;
  content: string;
  /**
   * Trimming priority. Lower values are trimmed first.
   * Priority 1 = lowest priority (trimmed first).
   * Priority >= 100 or protected = true is never cut.
   */
  priority: number;
  /**
   * Minimum tokens to retain when trimming (default: 0).
   */
  minTokens?: number;
  /**
   * If true, this field is completely protected from trimming
   * (e.g. system instructions, output format directives, schemas).
   */
  protected?: boolean;
}

export interface TrimFieldsOptions {
  fields: PromptField[];
  maxTotalTokens: number;
  fixedTokens?: number;
}

export interface TrimFieldsResult {
  fields: Record<string, string>;
  trimmedFields: string[];
  totalTokens: number;
  initialTokens: number;
  isTrimmed: boolean;
}

/**
 * Core multi-field trimming engine.
 *
 * Given a list of prompt fields and a maximum total token cap:
 * 1. Counts tokens across all fields + fixed overhead.
 * 2. If within budget, returns all fields untouched (isTrimmed = false).
 * 3. If over budget, sorts trimmable fields by priority ascending (lowest priority trimmed first).
 * 4. Trims each field up to its available reduction until total tokens <= maxTotalTokens.
 * 5. Protected fields and fields with priority >= 100 are NEVER trimmed or cut.
 */
export function trimPromptFields(options: TrimFieldsOptions): TrimFieldsResult {
  const { fields, maxTotalTokens, fixedTokens = 0 } = options;

  const fieldTokenCounts: Record<string, number> = {};
  let currentTotal = fixedTokens;

  for (const field of fields) {
    const tokens = countTokens(field.content);
    fieldTokenCounts[field.name] = tokens;
    currentTotal += tokens;
  }

  const initialTokens = currentTotal;

  // If already within budget, return fields untouched
  if (currentTotal <= maxTotalTokens) {
    const resultFields: Record<string, string> = {};
    for (const field of fields) {
      resultFields[field.name] = field.content;
    }
    return {
      fields: resultFields,
      trimmedFields: [],
      totalTokens: currentTotal,
      initialTokens,
      isTrimmed: false,
    };
  }

  let excess = currentTotal - maxTotalTokens;
  const resultFields: Record<string, string> = {};
  const trimmedFields: string[] = [];

  // Filter trimmable fields and sort by priority ascending (lowest priority trimmed first)
  const trimmableFields = fields
    .filter((f) => !f.protected && f.priority < 100)
    .sort((a, b) => a.priority - b.priority);

  // Initialize resultFields with current contents
  for (const field of fields) {
    resultFields[field.name] = field.content;
  }

  for (const field of trimmableFields) {
    if (excess <= 0) break;

    const currentTokens = fieldTokenCounts[field.name] || 0;
    const minTokens = field.minTokens ?? 0;
    const maxReduction = Math.max(0, currentTokens - minTokens);

    if (maxReduction <= 0) continue;

    const reduction = Math.min(excess, maxReduction);
    const targetTokens = currentTokens - reduction;

    const trimmedContent = trimTextToTokens(field.content, targetTokens);
    const newTokens = countTokens(trimmedContent);
    const actualReduction = currentTokens - newTokens;

    resultFields[field.name] = trimmedContent;
    fieldTokenCounts[field.name] = newTokens;
    trimmedFields.push(field.name);

    excess -= actualReduction;
  }

  // Recalculate final total
  let finalTotal = fixedTokens;
  for (const field of fields) {
    finalTotal += countTokens(resultFields[field.name]);
  }

  return {
    fields: resultFields,
    trimmedFields,
    totalTokens: finalTotal,
    initialTokens,
    isTrimmed: trimmedFields.length > 0,
  };
}

/**
 * Standard per-operation token caps (documented in docs/context-window-management.md).
 */
export const OPERATION_TOKEN_CAPS = {
  cover_letter: 3000,
  resume_extraction: 4000,
  job_fit: 3000,
  resume_tailor: 4000,
} as const;

/**
 * Documented field trimming priority order per operation.
 * Lower priority number = lower priority (trimmed first).
 */
export const FIELD_TRIM_PRIORITIES = {
  cover_letter: [
    { field: "jobDescription", priority: 1, label: "Job Description (trimmed first)" },
    { field: "candidateSummary", priority: 2, label: "Candidate Summary" },
    { field: "candidateExperience", priority: 3, label: "Candidate Work History" },
    { field: "candidateSkills", priority: 4, label: "Candidate Skills" },
    { field: "jobTitle", priority: 100, label: "Target Job Title (protected)" },
    { field: "jobCompany", priority: 100, label: "Target Company (protected)" },
    { field: "candidateName", priority: 100, label: "Candidate Name (protected)" },
    { field: "candidateHeadline", priority: 100, label: "Candidate Headline (protected)" },
  ],
  resume_extraction: [
    { field: "rawText", priority: 1, label: "Raw Resume Source Text (trimmed first)" },
  ],
  job_fit: [
    { field: "jobDescription", priority: 1, label: "Job Description (trimmed first)" },
    { field: "candidateHeadline", priority: 2, label: "Candidate Headline" },
    { field: "candidateSkills", priority: 3, label: "Candidate Skills" },
    { field: "jobTitle", priority: 100, label: "Target Job Title (protected)" },
    { field: "jobCompany", priority: 100, label: "Target Company (protected)" },
  ],
  resume_tailor: [
    { field: "jobDescription", priority: 1, label: "Job Description (trimmed first)" },
    { field: "candidateSummary", priority: 2, label: "Candidate Summary" },
    { field: "candidateExperience", priority: 3, label: "Candidate Work History" },
    { field: "candidateSkills", priority: 4, label: "Candidate Skills" },
  ],
} as const;
