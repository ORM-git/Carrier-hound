import { LiveJob } from "@/lib/jobs/service";

export interface SchemaPostalAddress {
  "@type": "PostalAddress";
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string;
}

export interface SchemaPlace {
  "@type": "Place";
  address: SchemaPostalAddress;
}

export interface SchemaCountry {
  "@type": "Country";
  name: string;
}

export interface SchemaOrganization {
  "@type": "Organization";
  name: string;
  sameAs?: string;
}

export interface SchemaMonetaryAmount {
  "@type": "MonetaryAmount";
  currency: string;
  value: {
    "@type": "QuantitativeValue";
    value?: number;
    minValue?: number;
    maxValue?: number;
    unitText: "HOUR" | "DAY" | "WEEK" | "MONTH" | "YEAR";
  };
}

export interface JobPostingSchema {
  "@context": "https://schema.org";
  "@type": "JobPosting";
  title: string;
  description: string;
  datePosted: string;
  validThrough?: string;
  employmentType: "FULL_TIME" | "PART_TIME" | "CONTRACTOR" | "TEMPORARY" | "INTERN" | "OTHER";
  hiringOrganization: SchemaOrganization;
  directApply: boolean;
  jobLocationType?: "TELECOMMUTE";
  applicantLocationRequirements?: SchemaCountry;
  jobLocation?: SchemaPlace;
  baseSalary?: SchemaMonetaryAmount;
}

/**
 * Standardizes employment type strings to schema.org EmploymentType enum values.
 */
export function normalizeEmploymentType(
  rawType?: string
): "FULL_TIME" | "PART_TIME" | "CONTRACTOR" | "TEMPORARY" | "INTERN" | "OTHER" {
  if (!rawType) return "FULL_TIME";
  const normalized = rawType.toLowerCase().trim();
  if (normalized.includes("intern")) return "INTERN";
  if (normalized.includes("contract") || normalized.includes("freelance")) return "CONTRACTOR";
  if (normalized.includes("part")) return "PART_TIME";
  if (normalized.includes("temp")) return "TEMPORARY";
  if (normalized.includes("full")) return "FULL_TIME";
  return "FULL_TIME";
}

/**
 * Safely converts date string or timestamp to ISO 8601 string.
 */
export function toIsoDate(dateString?: string): string {
  if (!dateString) return new Date().toISOString();
  try {
    const d = new Date(dateString);
    if (!isNaN(d.getTime())) {
      return d.toISOString();
    }
  } catch {
    // fallback
  }
  return new Date().toISOString();
}

/**
 * Builds schema.org JobPosting JSON-LD from real job data.
 * Adheres strictly to security and privacy rules:
 * - Guests must not get company, salary, or apply URL beyond what public view shows.
 * - Masked 'Verified Employer' is preserved; real employer is NEVER leaked.
 * - directApply is always false.
 */
export function buildJobPostingSchema(
  job: LiveJob & { expiresAt?: string },
  options?: { siteUrl?: string }
): JobPostingSchema {
  const isMasked = job.company === "Verified Employer" || !job.company;
  const companyName = isMasked ? "Verified Employer" : job.company;

  const schema: JobPostingSchema = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title || "Untitled Position",
    description: job.description || "",
    datePosted: toIsoDate(job.postedAt || job.date),
    employmentType: normalizeEmploymentType(job.type),
    hiringOrganization: {
      "@type": "Organization",
      name: companyName,
    },
    directApply: false,
  };

  if (job.expiresAt) {
    schema.validThrough = toIsoDate(job.expiresAt);
  }

  if (job.remote) {
    schema.jobLocationType = "TELECOMMUTE";
    schema.applicantLocationRequirements = {
      "@type": "Country",
      name: job.country || "US",
    };
  } else {
    schema.jobLocation = {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.location || "Remote",
        addressCountry: job.country || "US",
      },
    };
  }

  return schema;
}

export interface GoogleComplianceResult {
  isCompliant: boolean;
  conflicts: string[];
  warnings: string[];
}

/**
 * Checks a JobPosting JSON-LD object against Google's Rich Results guidelines.
 * Flags known policy conflicts (such as company masking or empty descriptions)
 * without leaking protected company names.
 */
export function checkGoogleRichResultsCompliance(schema: JobPostingSchema): GoogleComplianceResult {
  const conflicts: string[] = [];
  const warnings: string[] = [];

  // 1. Hiring organization check
  if (schema.hiringOrganization.name === "Verified Employer" || !schema.hiringOrganization.name) {
    conflicts.push(
      "Hiring organization is masked as 'Verified Employer'. Google Rich Results guidelines strictly require the authentic employer name and disqualify generic, confidential, or placeholder names."
    );
  }

  // 2. Job description check
  if (!schema.description || schema.description.trim().length === 0) {
    conflicts.push(
      "Job description is empty. Google Rich Results requires a complete, informative description matching page content."
    );
  }

  // 3. Direct access check
  warnings.push(
    "Direct Access: Google requires job postings to be directly accessible to job seekers without requiring login or registration."
  );

  // 4. Remote job telecommute check
  if (schema.jobLocationType === "TELECOMMUTE" && !schema.applicantLocationRequirements) {
    conflicts.push(
      "applicantLocationRequirements is required by Google when jobLocationType is set to TELECOMMUTE."
    );
  }

  return {
    isCompliant: conflicts.length === 0,
    conflicts,
    warnings,
  };
}
