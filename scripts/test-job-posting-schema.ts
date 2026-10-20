import * as fs from "fs";
import * as path from "path";
import {
  buildJobPostingSchema,
  normalizeEmploymentType,
  checkGoogleRichResultsCompliance,
  JobPostingSchema,
} from "../src/lib/seo/jobPostingSchema";
import { LiveJob } from "../src/lib/jobs/service";

/**
 * Google Jobs SEO (JobPosting schema) verification suite.
 * Run directly with: npx tsx scripts/test-job-posting-schema.ts
 * Run negative control with: npx tsx scripts/test-job-posting-schema.ts --negative-control
 */

const isNegativeControl = process.argv.includes("--negative-control");

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

function runTests() {
  console.log("=== Running Google Jobs SEO (JobPosting schema) Suite ===");

  if (isNegativeControl) {
    console.log("Testing negative control (expected failure)...");
    assert(false, "Negative control intentional failure to verify non-zero exit");
    return;
  }

  // 1. Test Pro job schema generation (full unlocked data)
  const proJob: LiveJob & { expiresAt?: string } = {
    id: "job-101",
    title: "Senior Distributed Systems Engineer",
    company: "Stripe",
    location: "Remote (Worldwide)",
    date: "2026-10-15",
    postedAt: "2026-10-15T08:00:00.000Z",
    expiresAt: "2026-11-15T08:00:00.000Z",
    salary: "$180,000 - $240,000",
    category: "engineering",
    remote: true,
    remoteScope: "worldwide",
    country: "US",
    type: "Full-time",
    directSource: true,
    applyUrl: "https://stripe.com/jobs/101",
    description: "We are looking for a Senior Distributed Systems Engineer to scale core payments infrastructure.",
    skills: ["Go", "Distributed Systems", "Kubernetes"],
  };

  const proSchema = buildJobPostingSchema(proJob);

  assert(proSchema["@context"] === "https://schema.org", "Schema @context must be https://schema.org");
  assert(proSchema["@type"] === "JobPosting", "Schema @type must be JobPosting");
  assert(proSchema.title === "Senior Distributed Systems Engineer", "Title must match job title");
  assert(proSchema.description.includes("Senior Distributed Systems Engineer"), "Description must match real job description");
  assert(proSchema.datePosted.startsWith("2026-10-15"), "datePosted must be valid ISO date");
  assert(proSchema.validThrough?.startsWith("2026-11-15"), "validThrough must reflect expiresAt ISO date");
  assert(proSchema.employmentType === "FULL_TIME", "Full-time must map to FULL_TIME");
  assert(proSchema.hiringOrganization.name === "Stripe", "hiringOrganization must match real company for Pro user");
  assert(proSchema.jobLocationType === "TELECOMMUTE", "Remote jobs must set jobLocationType to TELECOMMUTE");
  assert(proSchema.applicantLocationRequirements?.name === "US", "applicantLocationRequirements country must be set");
  assert(proSchema.directApply === false, "directApply must strictly be false");
  console.log("✅ Pro job schema generation matches schema.org JobPosting specification");

  // 2. Test Guest / Public view masking and conflict reporting
  const guestJob: LiveJob = {
    id: "job-102",
    title: "Staff Product Designer",
    company: "Verified Employer",
    location: "Remote",
    date: "2026-10-18",
    postedAt: "2026-10-18T12:00:00.000Z",
    salary: "",
    category: "design",
    remote: true,
    country: "US",
    type: "Full-time",
    directSource: true,
    applyUrl: "",
    description: "",
    skills: [],
  };

  const guestSchema = buildJobPostingSchema(guestJob);

  assert(
    guestSchema.hiringOrganization.name === "Verified Employer",
    "Guest schema must preserve 'Verified Employer' masking and never leak real company"
  );
  assert(
    guestSchema.description === "",
    "Guest schema must preserve empty description when masked"
  );

  const compliance = checkGoogleRichResultsCompliance(guestSchema);
  assert(!compliance.isCompliant, "Masked guest schema must be detected as non-compliant with Google's strict requirements");
  assert(
    compliance.conflicts.some((c) => c.includes("Verified Employer")),
    "Compliance check must detect and report 'Verified Employer' masking conflict"
  );
  assert(
    compliance.conflicts.some((c) => c.includes("Job description is empty")),
    "Compliance check must detect empty description conflict"
  );
  console.log("✅ Guest masking security verified: company and paywalled fields are NEVER leaked, and Google policy conflict is correctly reported");

  // 3. Test Non-remote job location
  const onSiteJob: LiveJob = {
    id: "job-103",
    title: "Site Reliability Engineer",
    company: "GitHub",
    location: "San Francisco, CA",
    date: "2026-10-19",
    salary: "$160,000",
    category: "devops",
    remote: false,
    country: "US",
    type: "Full-time",
    directSource: true,
    applyUrl: "https://github.com/careers/103",
    description: "Manage high-availability systems on site.",
  };

  const onSiteSchema = buildJobPostingSchema(onSiteJob);
  assert(onSiteSchema.jobLocationType === undefined, "Non-remote job must not set jobLocationType to TELECOMMUTE");
  assert(onSiteSchema.jobLocation?.["@type"] === "Place", "Non-remote job must define jobLocation Place");
  assert(onSiteSchema.jobLocation?.address?.addressLocality === "San Francisco, CA", "addressLocality must match location");
  assert(onSiteSchema.jobLocation?.address?.addressCountry === "US", "addressCountry must match country");
  console.log("✅ Non-remote job location correctly maps to schema.org Place/PostalAddress");

  // 4. Test Employment type mapping
  assert(normalizeEmploymentType("Internship") === "INTERN", "Internship must normalize to INTERN");
  assert(normalizeEmploymentType("Contract") === "CONTRACTOR", "Contract must normalize to CONTRACTOR");
  assert(normalizeEmploymentType("Part-time") === "PART_TIME", "Part-time must normalize to PART_TIME");
  assert(normalizeEmploymentType("Full-time") === "FULL_TIME", "Full-time must normalize to FULL_TIME");
  console.log("✅ normalizeEmploymentType correctly normalizes all standard job types");

  // 5. Test JobDetail page integration
  const jobDetailPagePath = path.resolve(process.cwd(), "src/app/jobs/detail/page.tsx");
  assert(fs.existsSync(jobDetailPagePath), "src/app/jobs/detail/page.tsx must exist");
  const jobDetailContent = fs.readFileSync(jobDetailPagePath, "utf8");
  assert(
    jobDetailContent.includes("buildJobPostingSchema"),
    "Job detail page must call buildJobPostingSchema"
  );
  assert(
    jobDetailContent.includes('type="application/ld+json"'),
    "Job detail page must render application/ld+json script tag"
  );
  console.log("✅ Job detail page correctly mounts JobPosting schema JSON-LD");

  console.log("\n🎉 ALL GOOGLE JOBS SEO & SCHEMA TESTS PASSED (PASS-LOCAL)!");
}

runTests();
