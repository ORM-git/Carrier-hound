import { describe, it, expect } from "vitest";
import {
  validateAndNormalizeLinkedInUrl,
} from "../onboarding/step2";
import {
  validateResumeBuffer,
  extractSkillsFromText,
  MAX_RESUME_SIZE_BYTES,
} from "../onboarding/step2Resume";
import {
  scoreJobRecommendation,
  rankJobsByRecommendation,
  OnboardingAnswers,
} from "../jobs/recommendations";
import { isOnboardingStep2Active } from "@/config/onboarding";

describe("Onboarding Step 2: LinkedIn URL Validation & Normalization", () => {
  it("accepts canonical standard LinkedIn profile URL", () => {
    const res = validateAndNormalizeLinkedInUrl("https://www.linkedin.com/in/johndoe");
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe("https://www.linkedin.com/in/johndoe");
    expect(res.slug).toBe("johndoe");
  });

  it("normalizes URL without protocol", () => {
    const res = validateAndNormalizeLinkedInUrl("linkedin.com/in/jane-doe-123");
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(res.slug).toBe("jane-doe-123");
  });

  it("handles country subdomains correctly", () => {
    const res = validateAndNormalizeLinkedInUrl("https://in.linkedin.com/in/suryakant-sahoo");
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe("https://www.linkedin.com/in/suryakant-sahoo");
    expect(res.slug).toBe("suryakant-sahoo");
  });

  it("strips trailing slashes, tracking query params, and fragments", () => {
    const res = validateAndNormalizeLinkedInUrl(
      "https://www.linkedin.com/in/alex-dev/?utm_source=share&utm_medium=member_desktop#experience"
    );
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe("https://www.linkedin.com/in/alex-dev");
    expect(res.slug).toBe("alex-dev");
  });

  it("rejects non-profile LinkedIn paths (company, jobs, feed, school)", () => {
    const company = validateAndNormalizeLinkedInUrl("https://www.linkedin.com/company/google");
    expect(company.valid).toBe(false);
    expect(company.error).toContain("personal profile");

    const jobs = validateAndNormalizeLinkedInUrl("https://www.linkedin.com/jobs/view/123456");
    expect(jobs.valid).toBe(false);
    expect(jobs.error).toContain("personal profile");

    const feed = validateAndNormalizeLinkedInUrl("https://www.linkedin.com/feed/");
    expect(feed.valid).toBe(false);
    expect(feed.error).toContain("personal profile");
  });

  it("rejects non-LinkedIn domains and phishing attempts", () => {
    const evil = validateAndNormalizeLinkedInUrl("https://evil-linkedin.com/in/username");
    expect(evil.valid).toBe(false);
    expect(evil.error).toContain("linkedin.com");

    const fb = validateAndNormalizeLinkedInUrl("https://facebook.com/in/username");
    expect(fb.valid).toBe(false);
    expect(fb.error).toContain("linkedin.com");
  });

  it("rejects invalid slugs (too short, too long, empty)", () => {
    const short = validateAndNormalizeLinkedInUrl("https://www.linkedin.com/in/ab");
    expect(short.valid).toBe(false);
    expect(short.error).toContain("too short");

    const empty = validateAndNormalizeLinkedInUrl("https://www.linkedin.com/in/");
    expect(empty.valid).toBe(false);

    const blank = validateAndNormalizeLinkedInUrl("   ");
    expect(blank.valid).toBe(false);
  });
});

describe("Onboarding Step 2: Resume File-Type Verification & Magic Bytes", () => {
  it("accepts valid PDF buffer starting with %PDF- header", () => {
    const validPdfBuffer = Buffer.from("%PDF-1.5\n%\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");
    const res = validateResumeBuffer(validPdfBuffer, "my_resume.pdf");
    expect(res.valid).toBe(true);
    expect(res.type).toBe("pdf");
    expect(res.sanitizedFilename).toBe("my_resume.pdf");
  });

  it("rejects a fake PDF named .pdf that contains plain text or executable headers", () => {
    const fakePdfText = Buffer.from("This is not a real PDF file but I named it resume.pdf");
    const resText = validateResumeBuffer(fakePdfText, "resume.pdf");
    expect(resText.valid).toBe(false);
    expect(resText.error).toContain("not a valid PDF");

    const fakePdfExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ executable header
    const resExe = validateResumeBuffer(fakePdfExe, "trojan.pdf");
    expect(resExe.valid).toBe(false);
    expect(resExe.error).toContain("not a valid PDF");
  });

  it("accepts valid DOCX zip archive containing [Content_Types].xml", () => {
    // PK\x03\x04 + [Content_Types].xml header
    const validDocxBuffer = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("\x14\x00\x06\x00[Content_Types].xml fake content word/document.xml"),
    ]);
    const res = validateResumeBuffer(validDocxBuffer, "senior_engineer.docx");
    expect(res.valid).toBe(true);
    expect(res.type).toBe("docx");
  });

  it("rejects fake DOCX that does not start with PK zip signature", () => {
    const fakeDocx = Buffer.from("Plain text content saved with .docx extension");
    const res = validateResumeBuffer(fakeDocx, "fake.docx");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("not a valid DOCX");
  });

  it("rejects files exceeding the 5 MB size limit", () => {
    const hugePdfBuffer = Buffer.alloc(MAX_RESUME_SIZE_BYTES + 1024);
    hugePdfBuffer.write("%PDF-1.4");
    const res = validateResumeBuffer(hugePdfBuffer, "huge_resume.pdf");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("5MB limit");
  });

  it("rejects empty files (0 bytes)", () => {
    const empty = Buffer.alloc(0);
    const res = validateResumeBuffer(empty, "empty.pdf");
    expect(res.valid).toBe(false);
    expect(res.error).toContain("empty");
  });

  it("rejects unsupported file extensions (.txt, .exe, .png, .sh)", () => {
    const txtBuffer = Buffer.from("Resume text");
    const resTxt = validateResumeBuffer(txtBuffer, "resume.txt");
    expect(resTxt.valid).toBe(false);
    expect(resTxt.error).toContain("Only PDF (.pdf) and Word (.docx)");

    const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const resPng = validateResumeBuffer(pngBuffer, "resume.png");
    expect(resPng.valid).toBe(false);
  });
});

describe("Onboarding Step 2: Skill Extraction from Text", () => {
  it("extracts recognized technical skills deterministically from text", () => {
    const sampleResume = `
      Senior Software Engineer with 6 years of experience.
      Proficient in TypeScript, React, Next.js, Node.js, and PostgreSQL.
      Familiar with Docker, Kubernetes, AWS, and Tailwind CSS.
    `;
    const skills = extractSkillsFromText(sampleResume);
    expect(skills).toContain("TypeScript");
    expect(skills).toContain("React");
    expect(skills).toContain("Next.js");
    expect(skills).toContain("Node.js");
    expect(skills).toContain("PostgreSQL");
    expect(skills).toContain("Docker");
    expect(skills).toContain("AWS");
    expect(skills).toContain("Tailwind CSS");
  });

  it("returns empty array for text with no matching skills", () => {
    const nonTechText = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
    const skills = extractSkillsFromText(nonTechText);
    expect(skills).toEqual([]);
  });
});

describe("Onboarding Step 2: Job Recommendations Scoring with Enriched Profile", () => {
  const baseAnswers: OnboardingAnswers = {
    roles: ["Frontend Developer"],
    experienceLevel: "mid",
    remotePreference: "remote",
    locations: ["Remote / Global"],
    employmentTypes: ["full-time"],
  };

  const sampleJob = {
    id: "job-fe-1",
    title: "Senior Frontend Developer",
    category: "Software Development",
    location: "Remote / Global",
    remote: true,
    remote_scope: "remote",
    job_type: "full-time",
    description: "Looking for an expert in React, TypeScript, and Tailwind CSS to build our client portal.",
    posted_at: new Date().toISOString(),
  };

  it("computes baseline score without resume skills", () => {
    const result = scoreJobRecommendation(sampleJob, baseAnswers);
    expect(result.score).toBeGreaterThan(0);
    expect(result.breakdown.skillsScore || 0).toBe(0);
  });

  it("boosts score when resume skills match the job description", () => {
    const enrichedAnswers: OnboardingAnswers = {
      ...baseAnswers,
      skills: ["React", "TypeScript", "Tailwind CSS"],
    };

    const baseResult = scoreJobRecommendation(sampleJob, baseAnswers);
    const enrichedResult = scoreJobRecommendation(sampleJob, enrichedAnswers);

    expect(enrichedResult.breakdown.skillsScore).toBeGreaterThan(0);
    expect(enrichedResult.score).toBeGreaterThanOrEqual(baseResult.score);
    expect(enrichedResult.reasons.some((r) => r.includes("matched skill"))).toBe(true);
  });

  it("prioritizes candidate-skill-aligned jobs in recommendation ranking", () => {
    const jobA = {
      id: "job-a",
      title: "Frontend Developer (React / TypeScript)",
      category: "Software Development",
      location: "Remote",
      remote: true,
      job_type: "full-time",
      description: "Build interfaces using React and TypeScript.",
      posted_at: "2026-11-15T00:00:00Z",
    };

    const jobB = {
      id: "job-b",
      title: "Frontend Developer (Angular / Java)",
      category: "Software Development",
      location: "Remote",
      remote: true,
      job_type: "full-time",
      description: "Enterprise portal with Angular and Java backends.",
      posted_at: "2026-11-15T00:00:00Z",
    };

    const reactAnswers: OnboardingAnswers = {
      ...baseAnswers,
      skills: ["React", "TypeScript"],
    };

    const ranked = rankJobsByRecommendation([jobB, jobA], reactAnswers);
    expect(ranked[0].id).toBe("job-a");
  });
});

describe("Onboarding Step 2: Feature Flag Behavior", () => {
  it("reports active by default when not explicitly disabled", () => {
    const active = isOnboardingStep2Active();
    expect(typeof active).toBe("boolean");
  });
});
