import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  COMPANY_CATEGORIES,
  ROLE_CATEGORIES,
  detectCompanyCategory,
  detectRoleCategory,
  extractTopKeywords,
  computeDedupeHash,
  getSourcePriority,
} from "../jobs/highVolumeEnrichment";

describe("High-Volume Multi-Source Ingestion & Schema Enrichment", () => {
  it("classifies companies into the 4 canonical categories", () => {
    expect(COMPANY_CATEGORIES).toEqual([
      "MNC_BIGTECH",
      "HIGH_PRODUCT_YC",
      "OTHER_STARTUPS",
      "INDIAN_IT_AND_OTHER",
    ]);

    expect(detectCompanyCategory("Google", "google", "google.com")).toBe("MNC_BIGTECH");
    expect(detectCompanyCategory("Stripe", "stripe", "stripe.com")).toBe("HIGH_PRODUCT_YC");
    expect(detectCompanyCategory("Tata Consultancy Services", "tcs", "tcs.com", "IN")).toBe("INDIAN_IT_AND_OTHER");
    expect(detectCompanyCategory("Acme Robotics Lab", "acme-robotics", "acmerobotics.io", "US")).toBe("OTHER_STARTUPS");
  });

  it("classifies jobs into the 5 canonical role categories", () => {
    expect(ROLE_CATEGORIES).toEqual(["SDE", "AI_ML", "CLOUD", "DATA", "OTHER"]);

    expect(detectRoleCategory("Senior Machine Learning Engineer - LLMs")).toBe("AI_ML");
    expect(detectRoleCategory("Staff Cloud Infrastructure & Kubernetes Engineer")).toBe("CLOUD");
    expect(detectRoleCategory("Senior Data Engineer (Snowflake, dbt)")).toBe("DATA");
    expect(detectRoleCategory("Senior Full Stack Software Engineer (React / Node.js)")).toBe("SDE");
    expect(detectRoleCategory("Enterprise Account Executive", "sales")).toBe("OTHER");
  });

  it("extracts up to 8 deduplicated technical keywords from title, JD, and skills", () => {
    const jd = `
      We are hiring a Senior Backend & AI Engineer experienced in TypeScript, Node.js, Python,
      PostgreSQL, Redis, Docker, Kubernetes, AWS, GraphQL, PyTorch, and Kafka.
    `;
    const keywords = extractTopKeywords(
      "Senior TypeScript & Python Engineer",
      jd,
      ["TypeScript", "React"],
      8
    );

    expect(keywords.length).toBe(8);
    expect(keywords).toContain("TypeScript");
    expect(keywords).toContain("React");
    expect(keywords).toContain("Python");
    expect(new Set(keywords.map((k) => k.toLowerCase())).size).toBe(keywords.length);
  });

  it("computes deterministic 64-char SHA-256 dedupe_hash across company suffix & punctuation variations", () => {
    const hash1 = computeDedupeHash("Stripe, Inc.", "Senior Software Engineer!", "US", "San Francisco, CA");
    const hash2 = computeDedupeHash("stripe", "senior software engineer", "us", "San Francisco, United States");

    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(hash1).toBe(hash2);

    const hashDifferentCity = computeDedupeHash("Stripe", "Senior Software Engineer", "US", "New York, NY");
    expect(hashDifferentCity).not.toBe(hash1);
  });

  it("assigns priority 1 to Direct ATS boards and priority 2 to Aggregators", () => {
    expect(getSourcePriority("ats", "greenhouse")).toBe(1);
    expect(getSourcePriority("direct", "lever")).toBe(1);
    expect(getSourcePriority(undefined, "ashby")).toBe(1);
    expect(getSourcePriority("api", "adzuna")).toBe(2);
    expect(getSourcePriority("feed", "remotive")).toBe(2);
  });

  it("declares all required columns, partial indexes, and unique constraints in migration 20261116a", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../../supabase/migrations/20261116a_high_volume_ingestion_schema.sql"
    );
    expect(fs.existsSync(migrationPath)).toBe(true);
    const sql = fs.readFileSync(migrationPath, "utf8");

    // 1. companies columns & check
    expect(sql).toMatch(/ALTER TABLE public\.companies ADD COLUMN IF NOT EXISTS canonical_domain text/i);
    expect(sql).toMatch(/ALTER TABLE public\.companies ADD COLUMN IF NOT EXISTS category text/i);
    expect(sql).toMatch(/MNC_BIGTECH/);
    expect(sql).toMatch(/HIGH_PRODUCT_YC/);
    expect(sql).toMatch(/OTHER_STARTUPS/);
    expect(sql).toMatch(/INDIAN_IT_AND_OTHER/);

    // 2. jobs columns & check
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS role_category text/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS top_keywords text\[\]/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS dedupe_hash text/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS is_remote boolean/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS logo_url text/i);
    expect(sql).toMatch(/'SDE',\s*'AI_ML',\s*'CLOUD',\s*'DATA',\s*'OTHER'/);

    // Assert migration is non-destructive (no destructive row mutations or renames)
    expect(sql).not.toMatch(/UPDATE public\.jobs[\s\S]*?__dup_/i);

    // 3. Dedupe trigger handles both INSERT and UPDATE
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE OF is_active, dedupe_hash, source_priority ON public\.jobs/i);

    // 4. Partial indexes on is_active = TRUE and unique constraints
    expect(sql).toMatch(/idx_jobs_active_category[\s\S]*?WHERE is_active = TRUE/i);
    expect(sql).toMatch(/idx_jobs_active_country[\s\S]*?WHERE is_active = TRUE/i);
    expect(sql).toMatch(/idx_jobs_active_posted_at_desc[\s\S]*?WHERE is_active = TRUE/i);
    expect(sql).toMatch(/idx_jobs_source_type_source_job_id_uniq/i);
    expect(sql).toMatch(/jobs_source_type_source_job_id_key/i);
    expect(sql).toMatch(/idx_jobs_active_dedupe_hash_uniq[\s\S]*?WHERE is_active = TRUE AND dedupe_hash IS NOT NULL/i);
  });
});
