/**
 * Ingest-time columns for checklist #21 (annualized salary + estimate flags) and #27 (versioned skill
 * requirements). Columns come from docs/proposed/20261127_salary_normalization_and_skill_requirements.NOT_APPLIED.sql;
 * scripts/ingest.ts writes them only when they exist.
 */
import { normalizeSalary } from "../salary/normalize";
import { extractSkillRequirements, type SkillRequirements } from "./skillRequirements";

export interface IngestNormalizationInput {
  salary_min?: number | null;
  salary_max?: number | null;
  salary_period?: string | null;
  currency?: string | null;
  /** True only when the source itself stated the period. Adapters default salary_period to 'yearly'. */
  salary_period_stated?: boolean;
  description?: string | null;
  skills?: unknown;
}

export interface IngestNormalizationColumns {
  salary_annual_min: number | null;
  salary_annual_max: number | null;
  salary_period_inferred: boolean | null;
  salary_conversion_assumed: boolean | null;
  skill_requirements: SkillRequirements;
  skill_requirements_version: string;
}

export function ingestNormalizationColumns(job: IngestNormalizationInput): IngestNormalizationColumns {
  const hasSalary = job.salary_min != null || job.salary_max != null;
  // An unproven period is never annualized: the stored salary_period may be an adapter default.
  const stated = job.salary_period_stated === true;
  const n = normalizeSalary({ min: job.salary_min, max: job.salary_max, currency: job.currency, period: stated ? job.salary_period : null });
  const skill_requirements = extractSkillRequirements({ description: job.description, skills: job.skills });
  return {
    salary_annual_min: n.annualMin,
    salary_annual_max: n.annualMax,
    salary_period_inferred: hasSalary ? !stated : null,
    salary_conversion_assumed: n.annualMin !== null || n.annualMax !== null ? n.conversionAssumed : null,
    skill_requirements,
    skill_requirements_version: skill_requirements.extractorVersion,
  };
}
