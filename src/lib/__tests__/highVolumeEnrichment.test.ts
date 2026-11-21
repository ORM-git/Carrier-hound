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
  sha256Hex,
} from "../jobs/highVolumeEnrichment";
import { createHash } from "node:crypto";

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
    const hash1 = computeDedupeHash("Stripe Inc.", "Senior Software Engineer", "US", "San Francisco, CA");
    const hash2 = computeDedupeHash("stripe", "senior software engineer", "us", "San Francisco, United States");

    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    expect(hash1).toBe(hash2);

    const hashDifferentCity = computeDedupeHash("Stripe", "Senior Software Engineer", "US", "New York, NY");
    expect(hashDifferentCity).not.toBe(hash1);

    // Title punctuation variations are preserved distinctly under the canonical v2 contract
    const hashSlash = computeDedupeHash("PayPay", "Backend Engineer / Go", "JP", "Tokyo");
    const hashDash = computeDedupeHash("PayPay", "Backend Engineer - Go", "JP", "Tokyo");
    expect(hashSlash).not.toBe(hashDash);
  });

  it("assigns priority 1 to Direct ATS boards and priority 2 to Aggregators", () => {
    expect(getSourcePriority("ats", "greenhouse")).toBe(1);
    expect(getSourcePriority("direct", "lever")).toBe(1);
    expect(getSourcePriority(undefined, "ashby")).toBe(1);
    expect(getSourcePriority("api", "adzuna")).toBe(2);
    expect(getSourcePriority("feed", "remotive")).toBe(2);
  });

  it("migration 20261116a is a repair-aware additive delta (columns only, owned objects untouched)", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../../supabase/migrations/20261116a_high_volume_ingestion_schema.sql"
    );
    expect(fs.existsSync(migrationPath)).toBe(true);
    const raw = fs.readFileSync(migrationPath, "utf8");
    const sql = raw.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

    // 1. Declares the columns the #642 ingestion code writes
    expect(sql).toMatch(/ALTER TABLE public\.companies ADD COLUMN IF NOT EXISTS canonical_domain text/i);
    expect(sql).toMatch(/ALTER TABLE public\.companies ADD COLUMN IF NOT EXISTS category text/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS role_category text/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS top_keywords text\[\]/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS source_id text/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS dedupe_hash text/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS is_remote boolean;/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS logo_url text/i);
    expect(sql).toMatch(/ALTER TABLE public\.jobs ADD COLUMN IF NOT EXISTS canonical_domain text/i);
    expect(sql).toMatch(/added by 20261116a/);

    // 2. Leaves every #645 / #643 owned object alone: no functions, views, grants, constraints, indexes, row writes
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|VIEW|TRIGGER)/i);
    expect(sql).not.toMatch(/\b(CREATE|DROP)\s+(UNIQUE\s+)?INDEX/i);
    expect(sql).not.toMatch(/\b(ADD|DROP)\s+CONSTRAINT/i);
    expect(sql).not.toMatch(/\bDROP\s+(VIEW|FUNCTION|TABLE|COLUMN)/i);
    expect(sql).not.toMatch(/\b(GRANT|REVOKE)\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+public\./i);
    expect(sql).not.toMatch(/merge_job_by_dedupe_priority|idx_jobs_active_dedupe_hash_uniq/i);
  });

  it("sha256Hex (Edge/browser-safe) matches node:crypto byte-for-byte", () => {
    const samples = ["", "a", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000),
      "v2|c:6:stripe|t:3:swe|co:2:us|loc:13:san francisco", "İstanbul ß ς 東京 \u{1F600} \uD800 lone"];
    let seed = 7;
    for (let i = 0; i < 200; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      samples.push(Array.from({ length: seed % 300 }, (_, j) => String.fromCodePoint(((seed >> (j % 16)) + j * 31) % 0x2fff)).join(""));
    }
    for (const s of samples) expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
  });
});
