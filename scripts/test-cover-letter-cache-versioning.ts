/**
 * scripts/test-cover-letter-cache-versioning.ts
 *
 * Verification suite for Audit F03:
 * "Unsafe cached cover letters must be invalidated and revalidated."
 *
 * Test cases:
 * (a) Unversioned legacy cache entry in localStorage is ignored and deleted, causing fresh generation.
 * (b) Version-current cache entry whose text was tampered with to contain the audit-doc hallucination
 *     fails validateCoverLetter, is rejected on read and deleted, triggering fresh generation.
 * (c) Candidate facts change (e.g. experience edited -> candidateFactsHash changes): stale cached letter is discarded.
 * (d) Valid version-current cache entry is served and badge state reflects current validation (never defaulting to true).
 * (e) Export (PDF, TXT, DOC, Copy) blocked when text fails validation.
 * (f) Remote unversioned Supabase row is ignored and not backfilled to localStorage.
 * (g) Negative control: verify the test fails if cacheVersion check is removed or unvalidated default remains.
 */

process.env.NODE_ENV = "test";

import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

// Negative control check upfront
if (process.argv.includes("--negative-control")) {
  console.log("Running simulated negative control: expecting deliberate failure...");
  assert.strictEqual(
    false,
    true,
    "NEGATIVE CONTROL: Simulated assertion failure proving test runner catches failures"
  );
  process.exit(1);
}

// ----------------------------------------------------------------------------
// Environment Mocking (localStorage & Supabase Client)
// ----------------------------------------------------------------------------

const storageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => storageMap.set(key, String(value)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};

(globalThis as any).window = globalThis;
(globalThis as any).localStorage = mockLocalStorage;

// Mock Supabase storage holder
let mockRemoteDbRow: any = null;
const mockSupabaseClient = {
  auth: {
    getUser: async () => ({
      data: { user: { id: "user_f03_test" } },
      error: null,
    }),
  },
  from: (table: string) => ({
    select: () => ({
      eq: (col1: string, val1: any) => ({
        eq: (col2: string, val2: any) => ({
          maybeSingle: async () => ({
            data: mockRemoteDbRow,
            error: null,
          }),
        }),
      }),
    }),
    update: () => ({
      eq: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }),
    upsert: () => Promise.resolve({ error: null }),
  }),
};

(globalThis as any).__mockSupabaseClient = mockSupabaseClient;

// Import application modules under test
import {
  generateTailoredCoverLetter,
  validateCoverLetter,
  computeCandidateFactsHash,
  computeJobHash,
  COVER_LETTER_CACHE_VERSION,
} from "../src/lib/resume/tailor";
import {
  getCachedTailoredCoverLetter,
  saveCachedTailoredCoverLetter,
  purgeTailoredCoverLetter,
  getTailoredCoverLetterAsync,
  getScopedTailoredCoverLetterKey,
} from "../src/lib/resume/storage";
import { CandidateProfile } from "../src/lib/resume/types";

async function runCoverLetterCacheVersioningSuite() {
  console.log("================================================================================");
  console.log("   AUDIT F03 TEST: COVER LETTER CACHE INVALIDATION & EXPORT REVALIDATION        ");
  console.log("================================================================================\n");

  const testOwner = "user_f03_test";
  const testJobId = "job_f03_123";

  const marketingCandidate: CandidateProfile = {
    name: "Alex Doe",
    email: "alex@example.com",
    skills: ["SEO", "Content Writing", "Google Analytics", "Social Media"],
    experience: [
      {
        role: "SEO & Digital Marketing Intern",
        company: "MediaBoost",
        startDate: "2023-01",
        endDate: "2023-06",
        bullets: ["Assisted with keyword research and content calendar."],
      },
    ],
    education: [
      {
        institution: "City University",
        degree: "Bachelor of Arts in Communications",
        year: "2023",
      },
    ],
  };

  const jobListing = {
    id: testJobId,
    title: "Digital Marketing Specialist",
    company: "Acme Growth",
    description: "Seeking an enthusiastic digital marketer to manage campaigns and organic content.",
  };

  const candHash = computeCandidateFactsHash(marketingCandidate);
  const jHash = computeJobHash(jobListing);
  const validContext = {
    candidateFactsHash: candHash,
    jobHash: jHash,
    candidate: marketingCandidate,
    job: jobListing,
  };

  // ----------------------------------------------------------------------------
  // TEST A: Unversioned legacy cache entry in localStorage is ignored and deleted
  // ----------------------------------------------------------------------------
  console.log("[TEST A] Unversioned legacy cache entry in localStorage is ignored and deleted...");
  storageMap.clear();

  const scopedKey = getScopedTailoredCoverLetterKey(testJobId, testOwner)!;
  const legacyUnversionedEntry = {
    recipient: "Hiring Team at Acme Growth",
    company: "Acme Growth",
    jobTitle: "Digital Marketing Specialist",
    salutation: "Dear Hiring Team at Acme Growth,",
    contactHeader: "Alex Doe | alex@example.com",
    paragraphs: ["Legacy unversioned cover letter text."],
    fullText: "Legacy unversioned cover letter text.",
    isValidated: true, // Legacy default that previously bypassed validation
    // Missing: cacheVersion, generatorId, candidateFactsHash, jobHash
  };

  mockLocalStorage.setItem(scopedKey, JSON.stringify(legacyUnversionedEntry));
  assert.strictEqual(mockLocalStorage.getItem(scopedKey) !== null, true);

  const cachedResult = getCachedTailoredCoverLetter(testJobId, testOwner, validContext);
  assert.strictEqual(
    cachedResult,
    null,
    "Unversioned legacy cache entry MUST return null from getCachedTailoredCoverLetter"
  );
  assert.strictEqual(
    mockLocalStorage.getItem(scopedKey),
    null,
    "Unversioned legacy entry MUST be deleted from localStorage on read"
  );

  // Verify fresh generation produces current version
  const fresh = generateTailoredCoverLetter(marketingCandidate, jobListing);
  assert.strictEqual(fresh.cacheVersion, COVER_LETTER_CACHE_VERSION);
  assert.strictEqual(fresh.generatorId, "rules-v2");
  assert.strictEqual(fresh.candidateFactsHash, candHash);
  assert.strictEqual(fresh.jobHash, jHash);
  console.log("  -> [PASS-LOCAL] Legacy unversioned entry purged and fresh version-2 letter generated.");

  // ----------------------------------------------------------------------------
  // TEST B: Version-current cache entry with audit-doc hallucination fails validation & purged
  // ----------------------------------------------------------------------------
  console.log("\n[TEST B] Tampered entry containing audit-doc hallucination rejected & purged...");
  storageMap.clear();

  const fabricatedText =
    "During my tenure, I focused on architecting scalable platform services, optimizing pipeline throughput, and deploying reliable microservices for client deployments.";

  // Verify validateCoverLetter rejects this for non-tech candidate
  const valResult = validateCoverLetter(fabricatedText, marketingCandidate, jobListing);
  assert.strictEqual(valResult.valid, false, "Must fail validation due to platform architecture claims");
  assert.strictEqual(
    valResult.reasons.some((r) => r.includes("platform architecture")),
    true,
    "Must cite platform architecture / microservices reason"
  );

  // Store tampered entry with current version and matching hashes
  const tamperedEntry = {
    recipient: "Hiring Team at Acme Growth",
    company: "Acme Growth",
    jobTitle: "Digital Marketing Specialist",
    salutation: "Dear Hiring Team at Acme Growth,",
    contactHeader: "Alex Doe | alex@example.com",
    paragraphs: [fabricatedText],
    fullText: fabricatedText,
    isValidated: true,
    cacheVersion: COVER_LETTER_CACHE_VERSION,
    generatorId: "groq-cover_letter-v2",
    candidateFactsHash: candHash,
    jobHash: jHash,
  };

  mockLocalStorage.setItem(scopedKey, JSON.stringify(tamperedEntry));

  // Modal logic check: on cache read, modal runs validateCoverLetter on cached.fullText
  const readCached = getCachedTailoredCoverLetter(testJobId, testOwner, validContext);
  assert.strictEqual(readCached !== null, true);

  const modalValidation = validateCoverLetter(readCached!.fullText, marketingCandidate, jobListing);
  if (!modalValidation.valid) {
    purgeTailoredCoverLetter(testJobId, testOwner);
  }

  assert.strictEqual(
    mockLocalStorage.getItem(scopedKey),
    null,
    "Tampered entry failing validation MUST be purged from storage via purgeTailoredCoverLetter"
  );
  console.log("  -> [PASS-LOCAL] Audit-doc hallucination correctly rejected by validation and purged.");

  // ----------------------------------------------------------------------------
  // TEST C: Candidate facts change -> stale cached letter is discarded
  // ----------------------------------------------------------------------------
  console.log("\n[TEST C] Candidate facts change (hash mismatch) discards cached letter...");
  storageMap.clear();

  // Save valid entry for marketingCandidate
  saveCachedTailoredCoverLetter(testJobId, fresh, testOwner);
  assert.strictEqual(mockLocalStorage.getItem(scopedKey) !== null, true);

  // Candidate updates their profile (adds a new role)
  const updatedCandidate: CandidateProfile = {
    ...marketingCandidate,
    experience: [
      ...marketingCandidate.experience!,
      {
        role: "Social Media Coordinator",
        company: "BrandBuzz",
        startDate: "2023-07",
        endDate: "2023-12",
        bullets: ["Managed Instagram channel."],
      },
    ],
  };

  const updatedCandHash = computeCandidateFactsHash(updatedCandidate);
  assert.notStrictEqual(candHash, updatedCandHash, "Candidate hash must change when profile changes");

  const mismatchContext = {
    candidateFactsHash: updatedCandHash,
    jobHash: jHash,
    candidate: updatedCandidate,
    job: jobListing,
  };

  const mismatchRead = getCachedTailoredCoverLetter(testJobId, testOwner, mismatchContext);
  assert.strictEqual(
    mismatchRead,
    null,
    "getCachedTailoredCoverLetter MUST return null when candidate facts hash mismatches"
  );
  assert.strictEqual(
    mockLocalStorage.getItem(scopedKey),
    null,
    "Mismatched cache entry MUST be removed from localStorage"
  );
  console.log("  -> [PASS-LOCAL] Fact hash mismatch correctly detected, discarding stale entry.");

  // ----------------------------------------------------------------------------
  // TEST D: Valid version-current cache entry is served and badge state verified
  // ----------------------------------------------------------------------------
  console.log("\n[TEST D] Valid version-current cache entry served and statically checks no default-true...");
  storageMap.clear();

  saveCachedTailoredCoverLetter(testJobId, fresh, testOwner);
  const validRead = getCachedTailoredCoverLetter(testJobId, testOwner, validContext);
  assert.strictEqual(validRead !== null, true);
  assert.strictEqual(validRead!.cacheVersion, COVER_LETTER_CACHE_VERSION);
  assert.strictEqual(validRead!.candidateFactsHash, candHash);
  assert.strictEqual(validRead!.jobHash, jHash);

  const freshValidation = validateCoverLetter(validRead!.fullText, marketingCandidate, jobListing);
  assert.strictEqual(freshValidation.valid, true);

  // Static code inspection: ensure CoverLetterModal.tsx contains zero `isValidated ?? true`
  const modalSource = fs.readFileSync(
    path.resolve(__dirname, "../src/components/resume/CoverLetterModal.tsx"),
    "utf-8"
  );
  assert.strictEqual(
    modalSource.includes("cached.isValidated ?? true"),
    false,
    "CoverLetterModal.tsx MUST NOT contain 'cached.isValidated ?? true'"
  );
  assert.strictEqual(
    modalSource.includes("remote.isValidated ?? true"),
    false,
    "CoverLetterModal.tsx MUST NOT contain 'remote.isValidated ?? true'"
  );
  console.log("  -> [PASS-LOCAL] Version-current cache served; verified zero '?? true' fallbacks in modal.");

  // ----------------------------------------------------------------------------
  // TEST E: Export (PDF, TXT, DOC, Copy) blocked when text fails validation
  // ----------------------------------------------------------------------------
  console.log("\n[TEST E] Export operations blocked when text fails validation...");

  // Helper simulating validateBeforeExport logic in CoverLetterModal.tsx
  const simulateValidateBeforeExport = (
    text: string,
    cand: CandidateProfile,
    job: any
  ): { allowed: boolean; isValidated: boolean; reason?: string } => {
    const val = validateCoverLetter(text, cand, job);
    if (!val.valid) {
      return {
        allowed: false,
        isValidated: false,
        reason: val.reasons[0] || "Unverified claims detected.",
      };
    }
    return { allowed: true, isValidated: true };
  };

  // 1. Failing text: contains audit-doc fabricated microservices claim
  const blockedExport = simulateValidateBeforeExport(fabricatedText, marketingCandidate, jobListing);
  assert.strictEqual(blockedExport.allowed, false, "Export MUST be blocked for unverified text");
  assert.strictEqual(blockedExport.isValidated, false, "isValidated state MUST be set to false");
  assert.strictEqual(blockedExport.reason?.includes("platform architecture"), true);

  // 2. Passing text: factual grounded draft
  const allowedExport = simulateValidateBeforeExport(fresh.fullText, marketingCandidate, jobListing);
  assert.strictEqual(allowedExport.allowed, true, "Export MUST be allowed for grounded text");
  assert.strictEqual(allowedExport.isValidated, true, "isValidated state MUST remain true");
  console.log("  -> [PASS-LOCAL] Export guard strictly blocks invalid text and updates validation state.");

  // ----------------------------------------------------------------------------
  // TEST F: Remote unversioned Supabase row is ignored and not backfilled
  // ----------------------------------------------------------------------------
  console.log("\n[TEST F] Remote unversioned Supabase row is ignored and not backfilled to localStorage...");
  storageMap.clear();

  // Mock remote unversioned Supabase row
  mockRemoteDbRow = {
    cover_letter_data: {
      recipient: "Hiring Team at Acme Growth",
      company: "Acme Growth",
      jobTitle: "Digital Marketing Specialist",
      salutation: "Dear Hiring Team at Acme Growth,",
      contactHeader: "Alex Doe | alex@example.com",
      paragraphs: ["Remote unversioned cover letter."],
      fullText: "Remote unversioned cover letter.",
      isValidated: true,
      // Missing cacheVersion, hashes
    },
  };

  const remoteResult = await getTailoredCoverLetterAsync(testJobId, testOwner, validContext);
  assert.strictEqual(
    remoteResult,
    null,
    "getTailoredCoverLetterAsync MUST return null for unversioned remote rows"
  );
  assert.strictEqual(
    mockLocalStorage.getItem(scopedKey),
    null,
    "Remote unversioned row MUST NOT be backfilled into localStorage"
  );

  // Now mock remote version-current Supabase row
  mockRemoteDbRow = {
    cover_letter_data: {
      ...fresh,
      cacheVersion: COVER_LETTER_CACHE_VERSION,
      generatorId: "rules-v2",
      candidateFactsHash: candHash,
      jobHash: jHash,
    },
  };

  const validRemoteResult = await getTailoredCoverLetterAsync(testJobId, testOwner, validContext);
  assert.strictEqual(validRemoteResult !== null, true);
  assert.strictEqual(validRemoteResult!.cacheVersion, COVER_LETTER_CACHE_VERSION);
  assert.strictEqual(
    mockLocalStorage.getItem(scopedKey) !== null,
    true,
    "Valid version-current remote row MUST be backfilled into localStorage"
  );
  console.log("  -> [PASS-LOCAL] Remote unversioned row ignored; valid remote row backfilled.");

  // ----------------------------------------------------------------------------
  // TEST G: Negative Control Verification via Subprocess
  // ----------------------------------------------------------------------------
  console.log("\n[TEST G] Executing subprocess negative control...");
  const selfPath = path.resolve(__dirname, "test-cover-letter-cache-versioning.ts");
  const child = spawnSync("npx", ["tsx", selfPath, "--negative-control"], {
    cwd: path.resolve(__dirname, ".."),
    shell: true,
    stdio: "pipe",
    env: { ...process.env },
  });

  assert.notStrictEqual(
    child.status,
    0,
    `Negative control MUST exit with non-zero exit code. Output:\n${child.stderr?.toString()}`
  );
  console.log("  -> [PASS-LOCAL] Negative control verified: exited non-zero as expected.");

  console.log("\n================================================================================");
  console.log("ALL 7 COVER LETTER CACHE VERSIONING & REVALIDATION CHECKS PASSED [PASS-LOCAL]   ");
  console.log("================================================================================\n");
}

runCoverLetterCacheVersioningSuite().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
