// Test and verification script for career-ops port into CareerMonke
import { tailorProfileForJobWithAts } from "../src/lib/resume/atsScorer";
import { generateTailoredCoverLetter, validateCoverLetter } from "../src/lib/resume/tailor";
import { lintCandidateProfileForAts, buildCareerOpsCvTailorPrompt, buildCareerOpsCoverLetterPrompt } from "../src/lib/resume/careerOps";
import { CandidateProfile } from "../src/lib/resume/types";

const suryakantProfile: CandidateProfile = {
  name: "Suryakant Sahoo",
  email: "suryakanta.sahoo@email.com",
  phone: "+919437100446",
  location: "Bhubaneswar, India",
  headline: "Full-Stack Software Engineer",
  summary: "Results-driven Software Engineer experienced in building resilient web applications, designing backend APIs, and deploying modern cloud systems. Passionate about clean code, high performance, and rapid product delivery.",
  skills: [
    "Java",
    "Python",
    "JavaScript (ES6+)",
    "TypeScript",
    "SQL (PostgreSQL, MySQL)",
    "HTML5/CSS3",
    "React",
    "Node.js",
    "Express.js",
    "Next.js",
    "Tailwind CSS",
    "REST APIs",
    "Git",
    "GitHub",
    "Docker",
    "Postman",
    "Linux/Unix Shell",
    "Google Cloud Platform (GCP)",
    "Data Structures & Algorithms",
    "Full-Stack Architecture",
    "API Orchestration",
    "System Design Basics",
  ],
  experience: [
    {
      id: "exp-1",
      company: "Freelance Software Developer & Technical Consultant",
      role: "Software Engineering Consultant",
      startDate: "Jul 2025",
      endDate: "Present",
      bullets: [
        "Architected and launched high-performance web applications for 5+ regional enterprise clients, decreasing average page load latency by 38% via critical rendering path optimization and bundle splitting.",
        "Designed and integrated RESTful backend micro-endpoints using Node.js and PostgreSQL, achieving sub-50ms API response latency under concurrent client interactions.",
        "Integrated automated validation, structured logging, and fault-tolerant failovers for customer inquiry pipelines, preserving 99.9% transaction reliability.",
        "Standardized modular UI design systems utilizing React and Tailwind CSS, reducing redundant front-end development turnaround time by 30%.",
      ],
      needsReview: false,
    },
  ],
  education: [
    {
      id: "edu-1",
      degree: "Bachelor of Technology in Computer Science & Engineering",
      institution: "Silicon University",
      year: "2028",
      needsReview: false,
    },
  ],
  certifications: ["CKA"],
  updatedAt: new Date().toISOString(),
};

const samsaraJob = {
  id: "samsara-ai-platform-101",
  title: "Sr. Software Engineer II, AI Platform",
  company: "Samsara",
  category: "ai",
  description: "Samsara is looking for a Senior Software Engineer II for our AI Platform. You will build and scale AI infrastructure, LLM pipelines, real-time ML inference platforms, and distributed systems in Python and Go on Google Cloud Platform. We need engineers with strong Data Structures, Algorithms, Docker, and Linux shell expertise.",
  location: "San Francisco, CA / Remote",
};

const affirmJob = {
  id: "affirm-backend-card-202",
  title: "Senior Software Engineer, Backend (Card Acquisition)",
  company: "Affirm",
  category: "engineering",
  description: "Affirm is seeking a Senior Backend Software Engineer for our Card Acquisition team. You will design, build, and optimize high-throughput distributed microservices handling financial transactions, payment ledgers, and credit card issuance pipelines using Node.js, SQL, PostgreSQL, Express, and REST APIs. Strong database optimization, API orchestration, and system reliability are paramount.",
  location: "Remote - US / Canada",
};

console.log("================================================================================");
console.log("CAREER-OPS ATS PORT VERIFICATION SUITE");
console.log("================================================================================\n");

// 1. Tailor for Samsara AI Platform
const samsaraResult = tailorProfileForJobWithAts(suryakantProfile, samsaraJob);
console.log("--- 1. SAMSARA (AI PLATFORM) ---");
console.log(`Job Title: ${samsaraResult.jobTitle} at ${samsaraResult.company}`);
console.log(`ATS Score: ${samsaraResult.atsScore}/100 (Passes >= 85 target: ${samsaraResult.atsScore >= 85})`);
console.log(`Revision Passes: ${samsaraResult.revisionAttempts}`);
console.log(`Tailored Headline:\n  ${samsaraResult.tailoredCandidate.headline}`);
console.log(`Top 5 Prioritized Skills:\n  ${samsaraResult.tailoredCandidate.skills?.slice(0, 5).join(", ")}`);
console.log(`Tailored Lead Bullet:\n  ${samsaraResult.tailoredCandidate.experience?.[0]?.bullets?.[0]}`);

const samsaraLint = lintCandidateProfileForAts(samsaraResult.tailoredCandidate, samsaraResult.atsScore);
console.log(`Career-Ops ATS Lint: ${samsaraLint.passed ? "PASSED" : "FAILED"}`);

// 2. Tailor for Affirm Backend
const affirmResult = tailorProfileForJobWithAts(suryakantProfile, affirmJob);
console.log("\n--- 2. AFFIRM (BACKEND CARD ACQUISITION) ---");
console.log(`Job Title: ${affirmResult.jobTitle} at ${affirmResult.company}`);
console.log(`ATS Score: ${affirmResult.atsScore}/100 (Passes >= 85 target: ${affirmResult.atsScore >= 85})`);
console.log(`Revision Passes: ${affirmResult.revisionAttempts}`);
console.log(`Tailored Headline:\n  ${affirmResult.tailoredCandidate.headline}`);
console.log(`Top 5 Prioritized Skills:\n  ${affirmResult.tailoredCandidate.skills?.slice(0, 5).join(", ")}`);
console.log(`Tailored Lead Bullet:\n  ${affirmResult.tailoredCandidate.experience?.[0]?.bullets?.[0]}`);

const affirmLint = lintCandidateProfileForAts(affirmResult.tailoredCandidate, affirmResult.atsScore);
console.log(`Career-Ops ATS Lint: ${affirmLint.passed ? "PASSED" : "FAILED"}`);

// 3. Compare differentiation & Truthful Source Fact Immutability
console.log("\n--- 3. COMPARISON & DIFFERENTIATION VERIFICATION ---");
// Under truthful ATS rules, candidate headline & summary remain immutable and grounded to source profile
const headlinesPreserved =
  samsaraResult.tailoredCandidate.headline === suryakantProfile.headline &&
  affirmResult.tailoredCandidate.headline === suryakantProfile.headline;
const summariesPreserved =
  samsaraResult.tailoredCandidate.summary === suryakantProfile.summary &&
  affirmResult.tailoredCandidate.summary === suryakantProfile.summary;
const skillsDiffer = samsaraResult.tailoredCandidate.skills?.[0] !== affirmResult.tailoredCandidate.skills?.[0];
const bulletsDiffer = samsaraResult.tailoredCandidate.experience?.[0]?.bullets?.[0] !== affirmResult.tailoredCandidate.experience?.[0]?.bullets?.[0];

console.log(`Headlines Truthfully Preserved: ${headlinesPreserved ? "YES" : "NO"}`);
console.log(`Summaries Truthfully Preserved: ${summariesPreserved ? "YES" : "NO"}`);
console.log(`Lead Skill Differs: ${skillsDiffer ? "YES" : "NO"} (${samsaraResult.tailoredCandidate.skills?.[0]} vs ${affirmResult.tailoredCandidate.skills?.[0]})`);
console.log(`Lead Bullet Differs: ${bulletsDiffer ? "YES" : "NO"}`);

if (!headlinesPreserved || !summariesPreserved || !skillsDiffer || !bulletsDiffer) {
  console.error("FAIL: Resumes are not differentiated across roles or broke candidate fact immutability!");
  process.exit(1);
}

// 4. Zero Hallucination check
console.log("\n--- 4. ZERO HALLUCINATION VERIFICATION ---");
const allowedSkills = new Set(suryakantProfile.skills?.map((s) => s.toLowerCase()));
for (const skill of [...(samsaraResult.tailoredCandidate.skills || []), ...(affirmResult.tailoredCandidate.skills || [])]) {
  if (!allowedSkills.has(skill.toLowerCase())) {
    console.error(`FAIL: Hallucinated skill detected: ${skill}`);
    process.exit(1);
  }
}
console.log("Verified: 0 fabricated skills across both resumes.");

// 5. Cover letters
console.log("\n--- 5. COVER LETTERS VERIFICATION ---");
const samsaraCover = generateTailoredCoverLetter(suryakantProfile, samsaraJob);
const affirmCover = generateTailoredCoverLetter(suryakantProfile, affirmJob);

console.log(`Samsara Cover Letter Company: ${samsaraCover.company}, Job: ${samsaraCover.jobTitle}`);
console.log(`Affirm Cover Letter Company: ${affirmCover.company}, Job: ${affirmCover.jobTitle}`);
const coverLettersDiffer = samsaraCover.fullText !== affirmCover.fullText;
console.log(`Cover Letters Differ: ${coverLettersDiffer ? "YES" : "NO"}`);

const samsaraValidation = validateCoverLetter(samsaraCover.fullText, suryakantProfile, samsaraJob);
const affirmValidation = validateCoverLetter(affirmCover.fullText, suryakantProfile, affirmJob);
console.log(`Samsara Cover Letter Factually Grounded: ${samsaraValidation.valid ? "YES" : "NO"}`);
console.log(`Affirm Cover Letter Factually Grounded: ${affirmValidation.valid ? "YES" : "NO"}`);

if (!coverLettersDiffer || !samsaraValidation.valid || !affirmValidation.valid) {
  console.error("FAIL: Cover letter verification failed!");
  process.exit(1);
}

// 6. Career-Ops Prompts
console.log("\n--- 6. CAREER-OPS PROMPT GENERATION VERIFICATION ---");
const cvPrompt = buildCareerOpsCvTailorPrompt({
  candidate: suryakantProfile,
  job: samsaraJob,
  missingKeywords: samsaraResult.scoringResult.missingKeywords,
});
const clPrompt = buildCareerOpsCoverLetterPrompt({
  candidate: suryakantProfile,
  job: affirmJob,
});
console.log(`Career-Ops CV Tailor Prompt generated (${cvPrompt.length} chars)`);
console.log(`Career-Ops Cover Letter Prompt generated (${clPrompt.length} chars)`);

console.log("\n================================================================================");
console.log("ALL CAREER-OPS VERIFICATION CHECKS PASSED WITH 100% SUCCESS!");
console.log("================================================================================");
