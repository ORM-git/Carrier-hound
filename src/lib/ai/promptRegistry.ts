/**
 * Prompt Template Registry (Backend sheet row: Prompt Template Versioning).
 *
 * Provides a structured in-memory registry of versioned prompt templates for the
 * four core AI operations: cover_letter, resume_extraction, resume_tailor, and job_fit.
 * Supports:
 * - Versioned template lookup by operation and explicit version key (e.g. "2.0", "1.0").
 * - Fallback to current default version when an unknown or deprecated version is requested.
 * - Per-operation rollback targets and change notes.
 * - Machine-checked version inventory for audit compliance.
 */

import { AllowedAiOperation, OPERATION_CONFIGS, OperationConfig } from "./security";

export interface PromptTemplateVersionMeta {
  version: string;
  releasedAt: string;
  status: "active" | "deprecated" | "rollback_target";
  summary: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
}

export interface PromptTemplateRegistryEntry {
  operation: AllowedAiOperation;
  currentVersion: string;
  rollbackVersion: string;
  versions: Record<string, PromptTemplateVersionMeta>;
}

export const PROMPT_REGISTRY: Record<AllowedAiOperation, PromptTemplateRegistryEntry> = {
  cover_letter: {
    operation: "cover_letter",
    currentVersion: "2.0",
    rollbackVersion: "1.0",
    versions: {
      "2.0": {
        version: "2.0",
        releasedAt: "2026-11-10",
        status: "active",
        summary: "Few-shot grounded cover letter prompt with negative guardrails and worked examples.",
        model: OPERATION_CONFIGS.cover_letter.model,
        temperature: OPERATION_CONFIGS.cover_letter.temperature,
        maxOutputTokens: OPERATION_CONFIGS.cover_letter.maxOutputTokens,
      },
      "1.0": {
        version: "1.0",
        releasedAt: "2026-11-06",
        status: "rollback_target",
        summary: "Zero-shot baseline cover letter generator.",
        model: "openai/gpt-oss-120b",
        temperature: 0.2,
        maxOutputTokens: 1000,
      },
    },
  },
  resume_extraction: {
    operation: "resume_extraction",
    currentVersion: "2.0",
    rollbackVersion: "1.0",
    versions: {
      "2.0": {
        version: "2.0",
        releasedAt: "2026-11-10",
        status: "active",
        summary: "Few-shot candidate profile extractor with explicit JSON schema and date bounding.",
        model: OPERATION_CONFIGS.resume_extraction.model,
        temperature: OPERATION_CONFIGS.resume_extraction.temperature,
        maxOutputTokens: OPERATION_CONFIGS.resume_extraction.maxOutputTokens,
      },
      "1.0": {
        version: "1.0",
        releasedAt: "2026-11-06",
        status: "rollback_target",
        summary: "Zero-shot baseline resume extraction prompt.",
        model: "openai/gpt-oss-20b",
        temperature: 0.1,
        maxOutputTokens: 2500,
      },
    },
  },
  resume_tailor: {
    operation: "resume_tailor",
    currentVersion: "2.0",
    rollbackVersion: "1.0",
    versions: {
      "2.0": {
        version: "2.0",
        releasedAt: "2026-11-10",
        status: "active",
        summary: "Few-shot resume tailoring with unevidenced skill suppression and STAR format enforcement.",
        model: OPERATION_CONFIGS.resume_tailor.model,
        temperature: OPERATION_CONFIGS.resume_tailor.temperature,
        maxOutputTokens: OPERATION_CONFIGS.resume_tailor.maxOutputTokens,
      },
      "1.0": {
        version: "1.0",
        releasedAt: "2026-11-06",
        status: "rollback_target",
        summary: "Zero-shot baseline resume tailoring prompt.",
        model: "openai/gpt-oss-120b",
        temperature: 0.2,
        maxOutputTokens: 2000,
      },
    },
  },
  job_fit: {
    operation: "job_fit",
    currentVersion: "2.0",
    rollbackVersion: "1.0",
    versions: {
      "2.0": {
        version: "2.0",
        releasedAt: "2026-11-10",
        status: "active",
        summary: "Few-shot candidate fit scoring with breakdown rubric and gap explanation.",
        model: OPERATION_CONFIGS.job_fit.model,
        temperature: OPERATION_CONFIGS.job_fit.temperature,
        maxOutputTokens: OPERATION_CONFIGS.job_fit.maxOutputTokens,
      },
      "1.0": {
        version: "1.0",
        releasedAt: "2026-11-06",
        status: "rollback_target",
        summary: "Zero-shot baseline fit scoring prompt.",
        model: "openai/gpt-oss-20b",
        temperature: 0.1,
        maxOutputTokens: 1000,
      },
    },
  },
};

/**
 * Returns metadata for a specific operation and version.
 * If version is omitted or unknown, falls back cleanly to the active currentVersion.
 */
export function getPromptVersionMeta(
  operation: AllowedAiOperation,
  version?: string
): { meta: PromptTemplateVersionMeta; isFallback: boolean } {
  const entry = PROMPT_REGISTRY[operation];
  if (!entry) {
    throw new Error(`Unregistered AI operation: ${String(operation)}`);
  }

  if (version && entry.versions[version]) {
    return { meta: entry.versions[version], isFallback: false };
  }

  const fallback = entry.versions[entry.currentVersion];
  return { meta: fallback, isFallback: Boolean(version && version !== entry.currentVersion) };
}

/**
 * Lists all registered versions for an operation in descending order.
 */
export function listAvailablePromptVersions(operation: AllowedAiOperation): string[] {
  const entry = PROMPT_REGISTRY[operation];
  if (!entry) return [];
  return Object.keys(entry.versions).sort().reverse();
}

/**
 * Gets the current active version string for an operation.
 */
export function getActivePromptVersion(operation: AllowedAiOperation): string {
  const entry = PROMPT_REGISTRY[operation];
  if (!entry) throw new Error(`Unregistered AI operation: ${String(operation)}`);
  return entry.currentVersion;
}

/**
 * Gets the designated rollback version string for an operation.
 */
export function getRollbackPromptVersion(operation: AllowedAiOperation): string {
  const entry = PROMPT_REGISTRY[operation];
  if (!entry) throw new Error(`Unregistered AI operation: ${String(operation)}`);
  return entry.rollbackVersion;
}

/**
 * Checks if a version exists in the registry for an operation.
 */
export function isKnownPromptVersion(operation: AllowedAiOperation, version: string): boolean {
  const entry = PROMPT_REGISTRY[operation];
  return Boolean(entry && entry.versions[version]);
}
