import { describe, it, expect } from "vitest";
import {
  isExactTechMatch,
  isKeywordInText,
  areSkillsGenuineMatch,
  getCanonicalSkillId,
} from "../scoring";
import { computeJobAtsScore } from "../../resume/atsScorer";
import type { CandidateProfile } from "../../resume/types";

describe("Issue 4: Token-Level Keyword Matching & Tech Boundary Segregation", () => {
  describe("1. Direct technology match & non-match (both directions)", () => {
    it("Java vs JavaScript: strictly separate in both directions", () => {
      expect(isExactTechMatch("Java", "JavaScript")).toBe(false);
      expect(isExactTechMatch("JavaScript", "Java")).toBe(false);

      expect(isKeywordInText("Java", "Expert in JavaScript and Node.js")).toBe(false);
      expect(isKeywordInText("JavaScript", "Proficient in Java, Spring Boot, and SQL")).toBe(false);

      expect(isKeywordInText("Java", "Developing backend services in Core Java 17")).toBe(true);
      expect(isKeywordInText("JavaScript", "Built interactive UI with JavaScript ES6")).toBe(true);
    });

    it("C vs C++ vs C#: strictly separate across all pairs and directions", () => {
      expect(isExactTechMatch("C", "C++")).toBe(false);
      expect(isExactTechMatch("C++", "C")).toBe(false);
      expect(isExactTechMatch("C", "C#")).toBe(false);
      expect(isExactTechMatch("C#", "C")).toBe(false);
      expect(isExactTechMatch("C++", "C#")).toBe(false);
      expect(isExactTechMatch("C#", "C++")).toBe(false);

      expect(isKeywordInText("C", "Senior C++ and C# developer")).toBe(false);
      expect(isKeywordInText("C++", "Low-level system programming in C and Assembly")).toBe(false);
      expect(isKeywordInText("C#", "Embedded firmware developed in C++")).toBe(false);

      expect(isKeywordInText("C", "Systems programmed in ANSI C and Linux kernel")).toBe(true);
      expect(isKeywordInText("C++", "High-performance game engine built with modern C++")).toBe(true);
      expect(isKeywordInText("C#", "Enterprise backend APIs using C# and .NET")).toBe(true);
    });

    it("Go vs Google / MongoDB: strictly separate in both directions", () => {
      expect(isExactTechMatch("Go", "Google")).toBe(false);
      expect(isExactTechMatch("Google", "Go")).toBe(false);
      expect(isExactTechMatch("Go", "MongoDB")).toBe(false);
      expect(isExactTechMatch("MongoDB", "Go")).toBe(false);

      expect(isKeywordInText("Go", "Experienced with MongoDB Atlas and Google Cloud Platform")).toBe(false);
      expect(isKeywordInText("Go", "High-throughput microservices engineered in Go")).toBe(true);
      expect(isKeywordInText("Golang", "Services written in Go language")).toBe(true);
    });

    it("R vs React: strictly separate in both directions", () => {
      expect(isExactTechMatch("R", "React")).toBe(false);
      expect(isExactTechMatch("React", "R")).toBe(false);

      expect(isKeywordInText("R", "Frontend web development using React and Tailwind CSS")).toBe(false);
      expect(isKeywordInText("R", "Statistical modeling conducted in R and Python")).toBe(true);
      expect(isKeywordInText("React", "Statistical modeling conducted in R programming")).toBe(false);
    });

    it("React vs React Native: documented behavior (segregated technologies)", () => {
      // Expected behavior: React (web UI) and React Native (mobile framework) are
      // distinct platforms with separate ecosystems. A React Native engineer does not
      // automatically fulfill web React criteria without web evidence, and vice-versa.
      expect(isExactTechMatch("React", "React Native")).toBe(false);
      expect(isExactTechMatch("React Native", "React")).toBe(false);

      expect(isKeywordInText("React", "Built cross-platform mobile apps in React Native")).toBe(false);
      expect(isKeywordInText("React Native", "Responsive web applications developed in React.js")).toBe(false);

      expect(isKeywordInText("React", "Single-page applications engineered with React and Redux")).toBe(true);
      expect(isKeywordInText("React Native", "iOS and Android mobile app written in React Native")).toBe(true);
    });

    it("Genuine tech aliases match symmetrically", () => {
      expect(isExactTechMatch("JS", "JavaScript")).toBe(true);
      expect(isExactTechMatch("JavaScript", "JS")).toBe(true);

      expect(isExactTechMatch("TS", "TypeScript")).toBe(true);
      expect(isExactTechMatch("TypeScript", "TS")).toBe(true);

      expect(isExactTechMatch("k8s", "Kubernetes")).toBe(true);
      expect(isExactTechMatch("Kubernetes", "k8s")).toBe(true);

      expect(isExactTechMatch("golang", "go")).toBe(true);
      expect(isExactTechMatch("go", "golang")).toBe(true);

      expect(isExactTechMatch("postgres", "PostgreSQL")).toBe(true);
      expect(isExactTechMatch("PostgreSQL", "postgres")).toBe(true);

      expect(isExactTechMatch(".NET", "C#")).toBe(true);
    });
  });

  describe("2. Integration with computeJobAtsScore", () => {
    const baseCandidate: CandidateProfile = {
      name: "Jordan Lee",
      email: "jordan@example.com",
      phone: "555-0100",
      headline: "JavaScript Developer",
      summary: "Web developer with JavaScript and CSS experience.",
      skills: ["JavaScript", "CSS", "HTML"],
      certifications: [],
      updatedAt: "2026-11-01T00:00:00Z",
      experience: [
        {
          id: "exp-1",
          company: "WebStudio",
          role: "JavaScript Developer",
          startDate: "2022",
          endDate: "2024",
          bullets: ["Engineered client-side features in vanilla JavaScript and CSS."],
        },
      ],
      education: [],
    };

    const javaJob = {
      title: "Senior Java Engineer",
      company: "Enterprise Corp",
      description: "Must have deep Java and Spring experience.",
      skills: ["Java", "Spring Boot"],
    };

    it("candidate with only JavaScript gets 0 matched skills on a Java job", () => {
      const scoring = computeJobAtsScore(baseCandidate, javaJob);
      expect(scoring.breakdown.skillsScore).toBe(0);
      expect(scoring.matchedKeywords).not.toContain("Java");
      expect(scoring.missingKeywords).toContain("Java");
    });
  });
});
