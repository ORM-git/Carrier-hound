/**
 * Test runner for TypeScript detectSeniority implementation against
 * Prompt 12 and Prompt 14 fixtures (including Addendum).
 *
 * File: scripts/test-seniority-ts.ts
 * Run via: npx tsx scripts/test-seniority-ts.ts
 */

import { detectSeniority } from './utils/sanitizer';

export interface TestCase {
  title: string;
  expected: 'entry' | 'mid' | 'senior' | 'staff' | 'lead' | 'director' | 'unknown';
  category?: string;
}

export const TEST_FIXTURE: TestCase[] = [
  // ============================================================================
  // 1. PROMPT 12 MANDATORY ANOMALY & CALIBRATION CASES
  // ============================================================================
  { title: "Senior Enterprise Account Executive", expected: "senior", category: "Prompt 12 Core" },
  { title: "Strategic Account Executive, Tech", expected: "unknown", category: "Prompt 12 Core" },
  { title: "Lead Systems Designer", expected: "lead", category: "Prompt 12 Core" },
  { title: "Product Marketing Lead", expected: "lead", category: "Prompt 12 Core" },
  { title: "Global Alliance Lead", expected: "lead", category: "Prompt 12 Core" },
  { title: "M&A Lead, Corporate Development", expected: "lead", category: "Prompt 12 Core" },
  { title: "Lead Product Owner", expected: "lead", category: "Prompt 12 Core" },
  { title: "Shift Lead", expected: "lead", category: "Prompt 12 Core" },
  { title: "Engineering Manager", expected: "lead", category: "Prompt 12 Core" },
  { title: "Sales Manager, Mid-Market - APAC", expected: "lead", category: "Prompt 12 Core" },
  { title: "Events Program Manager", expected: "lead", category: "Prompt 12 Core" },
  { title: "Associate Manager", expected: "mid", category: "Prompt 12 Core" },
  { title: "Assistant Manager", expected: "mid", category: "Prompt 12 Core" },
  { title: "Staff Nurse", expected: "unknown", category: "Staff Rule Context" },
  { title: "Lead Generation Specialist", expected: "unknown", category: "Prompt 12 Core" },
  { title: "Lead Gen Representative", expected: "unknown", category: "Prompt 12 Core" },
  { title: "Market Research Leads Specialist", expected: "unknown", category: "Prompt 12 Core" },

  // ============================================================================
  // 2. DIRECTOR / EXECUTIVE LEVEL
  // ============================================================================
  { title: "Managing Director", expected: "director", category: "Director / Executive" },
  { title: "Executive Director, Non-Profit", expected: "director", category: "Director / Executive" },
  { title: "VP of Engineering", expected: "director", category: "Director / Executive" },
  { title: "Vice President, Product Management", expected: "director", category: "Director / Executive" },
  { title: "Head of Design", expected: "director", category: "Director / Executive" },
  { title: "Chief Technology Officer", expected: "director", category: "Director / Executive" },
  { title: "Chief Executive Officer", expected: "director", category: "Director / Executive" },
  { title: "Chief Operating Officer", expected: "director", category: "Director / Executive" },
  { title: "Chief Information Security Officer", expected: "director", category: "Director / Executive" },
  { title: "Senior Director of Operations", expected: "director", category: "Director / Executive" },
  { title: "Associate Director of Marketing", expected: "director", category: "Director / Executive" },

  // ============================================================================
  // 3. STAFF / PRINCIPAL LEVEL
  // ============================================================================
  { title: "Staff Software Engineer", expected: "staff", category: "Staff / Principal" },
  { title: "Principal Architect", expected: "staff", category: "Staff / Principal" },
  { title: "Distinguished Engineer", expected: "staff", category: "Staff / Principal" },

  // ============================================================================
  // 4. SENIOR LEVEL
  // ============================================================================
  { title: "Senior Account Executive", expected: "senior", category: "Senior" },
  { title: "Senior Backend Engineer", expected: "senior", category: "Senior" },
  { title: "Sr. Full Stack Developer", expected: "senior", category: "Senior" },
  { title: "Senior Data Scientist", expected: "senior", category: "Senior" },
  { title: "Software Engineer III", expected: "senior", category: "Senior" },
  { title: "SDE 3", expected: "senior", category: "Senior" },
  { title: "Level 3 Systems Engineer", expected: "senior", category: "Senior" },
  { title: "Senior Associate, Audit", expected: "senior", category: "Senior" },

  // ============================================================================
  // 5. MANAGER & LEAD LEVEL
  // ============================================================================
  { title: "General Manager, Retail", expected: "lead", category: "Manager & Lead" },
  { title: "Tech Lead, Core Infrastructure", expected: "lead", category: "Manager & Lead" },
  { title: "Team Lead - Customer Support", expected: "lead", category: "Manager & Lead" },
  { title: "Engineering Lead / Architect", expected: "lead", category: "Manager & Lead" },
  { title: "Product Lead", expected: "lead", category: "Manager & Lead" },

  // ============================================================================
  // 6. MID LEVEL
  // ============================================================================
  { title: "Mid-Level Software Engineer", expected: "mid", category: "Mid" },
  { title: "Intermediate Frontend Developer", expected: "mid", category: "Mid" },
  { title: "Software Engineer II", expected: "mid", category: "Mid" },
  { title: "SDE 2", expected: "mid", category: "Mid" },
  { title: "Level 2 Support Engineer", expected: "mid", category: "Mid" },
  { title: "Mid Java Developer", expected: "mid", category: "Mid" },

  // ============================================================================
  // 7. ENTRY LEVEL & INTERNSHIPS
  // ============================================================================
  { title: "Software Engineering Intern", expected: "entry", category: "Entry" },
  { title: "Summer Internship 2026", expected: "entry", category: "Entry" },
  { title: "Graduate Trainee Engineer", expected: "entry", category: "Entry" },
  { title: "Junior Web Developer", expected: "entry", category: "Entry" },
  { title: "Jr. QA Tester", expected: "entry", category: "Entry" },
  { title: "Fresher Support Associate", expected: "entry", category: "Entry" },
  { title: "Entry Level Business Analyst", expected: "entry", category: "Entry" },
  { title: "Apprentice Electrician", expected: "entry", category: "Entry" },
  { title: "Level 1 Helpdesk Technician", expected: "entry", category: "Entry" },
  { title: "SDE 1", expected: "entry", category: "Entry" },
  { title: "Software Engineer I", expected: "entry", category: "Entry" },
  { title: "Sales Associate", expected: "entry", category: "Entry" },
  { title: "Associate Product Specialist", expected: "entry", category: "Entry" },

  // ============================================================================
  // 8. UNKNOWN / UNRANKED ROLES
  // ============================================================================
  { title: "Account Executive", expected: "unknown", category: "Unknown" },
  { title: "Enterprise Account Executive", expected: "unknown", category: "Unknown" },
  { title: "Mid-Market Account Executive", expected: "unknown", category: "Unknown" },
  { title: "Software Engineer, Platform", expected: "unknown", category: "Unknown" },
  { title: "Data Analyst", expected: "unknown", category: "Unknown" },
  { title: "Operations Specialist", expected: "unknown", category: "Unknown" },
  { title: "Executive Assistant", expected: "unknown", category: "Unknown" },
  { title: "Product Designer", expected: "unknown", category: "Unknown" },
  { title: "Customer Success Specialist", expected: "unknown", category: "Unknown" },

  // ============================================================================
  // 9. PROMPT 14 SPECIFIC NEW CASES
  // ============================================================================
  { title: "Senior Engineering Manager", expected: "senior", category: "Prompt 14 New" },
  { title: "Customer Support Specialist", expected: "unknown", category: "Prompt 14 New" },
  { title: "Data Entry Clerk", expected: "unknown", category: "Prompt 14 New" },
  { title: "Associate Manager, Operations", expected: "mid", category: "Prompt 14 New" },
  { title: "Account Executive III (Farmer)", expected: "unknown", category: "Prompt 14 New" },

  // ============================================================================
  // 10. PROMPT 14 ADDENDUM CASES (STAFF EXCLUSIONS & RETENTIONS)
  // ============================================================================
  { title: "Chief of Staff", expected: "unknown", category: "Prompt 14 Addendum" },
  { title: "Member of Technical Staff", expected: "unknown", category: "Prompt 14 Addendum" },
  { title: "Senior Member of Technical Staff", expected: "senior", category: "Prompt 14 Addendum" },
  { title: "Staff Product Manager", expected: "staff", category: "Prompt 14 Addendum" },
  { title: "Senior / Staff Product Engineer", expected: "staff", category: "Prompt 14 Addendum" },

  // ============================================================================
  // 11. PROMPT 15 CALIBRATION CASES
  // ============================================================================
  { title: "CRO Specialist", expected: "unknown", category: "Prompt 15 Calibration" },
  { title: "Clinical Research Associate", expected: "entry", category: "Prompt 15 Calibration" },
  { title: "Research Fellow", expected: "unknown", category: "Staff Rule Context" },
  { title: "Lead Engineer", expected: "lead", category: "Prompt 15 Calibration" },

  // ============================================================================
  // 12. PROMPT 16 STAFF RULE CONTEXT (TECH VS NON-TECH)
  // ============================================================================
  // Positive: Staff / Principal with engineering/product/design/data/ML/software/SRE/security/architect context
  { title: "Staff Software Engineer", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Principal Engineer", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Staff Product Designer", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Principal Systems Architect", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Staff Data Scientist", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Staff ML Engineer", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Principal Security Architect", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Staff Site Reliability Engineer", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Staff SRE", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Staff Frontend Developer", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Staff Backend Programmer", expected: "staff", category: "Prompt 16 Staff Context" },
  { title: "Distinguished Software Engineer", expected: "staff", category: "Prompt 16 Staff Context" },

  // Negative: Non-engineering/non-tech titles must NOT be staff
  { title: "Staff Accountant", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "Staff Writer", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "Staff Attorney", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "Staff Recruiter", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "Principal (school)", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "School Principal", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "Principal Consultant", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "Fellow of the Royal Society", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "Teaching Fellow", expected: "unknown", category: "Prompt 16 Non-Staff" },
  { title: "Staff Operations Specialist", expected: "unknown", category: "Prompt 16 Non-Staff" }
];

export function runSuite() {
  console.log("================================================================================");
  console.log(`RUNNING SENIORITY TS TEST SUITE (${TEST_FIXTURE.length} TOTAL CASES)`);
  console.log("================================================================================\n");

  let passed = 0;
  let failed = 0;
  const failures: { title: string; expected: string; actual: string; category?: string }[] = [];

  for (const tc of TEST_FIXTURE) {
    const actual = detectSeniority(tc.title);
    if (actual === tc.expected) {
      passed++;
    } else {
      failed++;
      failures.push({
        title: tc.title,
        expected: tc.expected,
        actual,
        category: tc.category,
      });
    }
  }

  console.log(`Passed: ${passed} / ${TEST_FIXTURE.length} (${((passed / TEST_FIXTURE.length) * 100).toFixed(1)}%)`);
  console.log(`Failed: ${failed} / ${TEST_FIXTURE.length} (${((failed / TEST_FIXTURE.length) * 100).toFixed(1)}%)`);

  if (failures.length > 0) {
    console.log("\n❌ MISMATCHES OBSERVED:");
    console.table(failures);
  } else {
    console.log("\n✅ ALL TEST CASES PASSED WITH 100% CONFORMANCE!");
  }

  return { passed, failed, failures };
}

runSuite();
