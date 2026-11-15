import { describe, it, expect, beforeEach } from "vitest";
import { validateAndSanitizeAiOutput } from "../security";
import { routeCompletion } from "../routing";
import {
  type AiTextCompletionProviderAdapter,
  _resetModelCooldownsForTesting,
} from "../providerAdapter";
import type { CandidateProfile } from "@/lib/resume/types";

describe("Issue 3: Cover Letter Grounding Validator", () => {
  beforeEach(() => {
    _resetModelCooldownsForTesting();
  });

  const testCandidate: CandidateProfile = {
    name: "Alex Taylor",
    email: "alex@example.com",
    phone: "555-0100",
    headline: "Frontend Engineer",
    summary: "Passionate developer building reliable client interfaces.",
    skills: ["TypeScript", "React", "Next.js", "CSS"],
    certifications: [],
    updatedAt: "2026-11-01T00:00:00Z",
    experience: [
      {
        id: "exp-1",
        company: "Acme Corp",
        role: "Frontend Engineer",
        startDate: "2022",
        endDate: "2024",
        bullets: [
          "Developed modular user interface components using React and TypeScript.",
          "Cut page load latency by 35% through bundle optimization.",
        ],
      },
    ],
    education: [
      {
        id: "edu-1",
        degree: "BSc in Computer Science",
        institution: "State University",
        year: "2021",
      },
    ],
  };

  const testJob = {
    title: "Senior Frontend Engineer",
    company: "Linear",
    description: "Looking for an engineer skilled in TypeScript, React, and performance optimization.",
  };

  const validCoverLetter = `I am excited to apply for the Senior Frontend Engineer role at Linear. Having followed Linear's relentless dedication to product craft, speed, and exceptional user experience, I am eager to contribute my background in web development to your engineering team. My core technical skills in TypeScript, React, and Next.js align directly with Linear's high engineering standards and thoughtful product design principles across modern web applications.

During my tenure as a Frontend Engineer at Acme Corp from 2022 to 2024, I developed customer-facing web applications and modular component interfaces using TypeScript, React, and Next.js. I concentrated on delivering reliable user interfaces, refactoring frontend workflows, and optimizing bundle delivery to improve overall client performance standards across production features.

Linear's commitment to building fast, high-quality software tools that creators and engineering teams love to use every day deeply resonates with me. I would welcome the opportunity to discuss how my proven experience in TypeScript and React development can support Linear's mission and engineering velocity. Thank you very much for your time and consideration; I look forward to speaking with you.`;

  it("accepts legitimate cover letter strictly grounded in candidate facts with 0 false positives", () => {
    const result = validateAndSanitizeAiOutput("cover_letter", validCoverLetter, {
      candidate: testCandidate,
      job: testJob,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sanitizedText).toBeDefined();
    }
  });

  it("rejects fabricated employment claim (inventing Google employment)", () => {
    const letterWithGoogle = validCoverLetter.replace(
      "During my tenure as a Frontend Engineer at Acme Corp from 2022 to 2024",
      "During my tenure as a Senior Engineer at Google from 2022 to 2024"
    );

    const result = validateAndSanitizeAiOutput("cover_letter", letterWithGoogle, {
      candidate: testCandidate,
      job: testJob,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Google");
    }
  });

  it("rejects fabricated metrics (inventing 900 percent revenue claim)", () => {
    const letterWith900Percent = validCoverLetter.replace(
      "to improve overall client performance standards",
      "to increase company revenue by 900 percent"
    );

    const result = validateAndSanitizeAiOutput("cover_letter", letterWith900Percent, {
      candidate: testCandidate,
      job: testJob,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/900/);
    }
  });

  it("rejects unevidenced skill from taxonomy (e.g. Kubernetes migration)", () => {
    const letterWithK8s = validCoverLetter.replace(
      "refactoring frontend workflows",
      "leading a complex Kubernetes migration"
    );

    const result = validateAndSanitizeAiOutput("cover_letter", letterWithK8s, {
      candidate: testCandidate,
      job: testJob,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.toLowerCase()).toContain("kubernetes");
    }
  });

  it("rejects exaggerated years of experience exceeding candidate end dates", () => {
    // Candidate worked 2022-2024 (2 years). Claiming 8 years must be rejected.
    const letterWith8Years = validCoverLetter.replace(
      "My core technical skills",
      "With over 8 years of experience, my core technical skills"
    );

    const result = validateAndSanitizeAiOutput("cover_letter", letterWith8Years, {
      candidate: testCandidate,
      job: testJob,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("years of experience");
    }
  });

  it("repairs fabricated claims via routing retry and produces valid grounded result", async () => {
    let callIndex = 0;
    const adapter: AiTextCompletionProviderAdapter = {
      provider: "test-grounding-repair",
      async completeText() {
        callIndex++;
        if (callIndex === 1) {
          // Attempt 1: Fabricates Google employment and 900%
          const badDraft = validCoverLetter
            .replace("Acme Corp", "Google")
            .replace("35%", "900 percent");
          return {
            choices: [{ message: { content: badDraft }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 180, total_tokens: 280 },
          };
        }
        // Attempt 2 (repair retry): Fixed grounded cover letter
        return {
          choices: [{ message: { content: validCoverLetter }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 },
        };
      },
    };

    const payload = {
      messages: [{ role: "user" as const, content: "draft cover letter" }],
      model: "openai/gpt-oss-120b",
      maxOutputTokens: 500,
      temperature: 0.3,
      jsonMode: false,
      estimatedInputTokens: 100,
    };

    const routed = await routeCompletion({
      adapter,
      payload,
      validate: (content) => {
        const val = validateAndSanitizeAiOutput("cover_letter", content, {
          candidate: testCandidate,
          job: testJob,
        });
        return val.ok ? { ok: true as const } : { ok: false as const, error: val.error };
      },
    });

    expect(callIndex).toBe(2);
    expect(routed.content).toBe(validCoverLetter);
    expect(routed.content).not.toContain("Google");
    expect(routed.content).not.toContain("900");
  });
});
