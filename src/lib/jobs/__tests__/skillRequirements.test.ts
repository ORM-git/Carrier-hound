import { describe, expect, it } from "vitest";
import { extractSkillRequirements, extractorVersion } from "../skillRequirements";

const skills = (entries: { skill: string }[]) => entries.map((e) => e.skill);

describe("extractSkillRequirements (offline, unwired)", () => {
  it("splits required and preferred from explicit sections, keeping raw text and provenance", () => {
    const r = extractSkillRequirements({
      description: "Minimum Qualifications\n- 3+ years of TypeScript and React.js\n- Experience with PostgreSQL\nPreferred Qualifications\n- Kubernetes experience\n- GraphQL",
    });
    expect(r.extractorVersion).toBe(extractorVersion);
    expect(skills(r.required)).toEqual(["typescript", "react", "postgresql"]);
    expect(skills(r.preferred)).toEqual(["kubernetes", "graphql"]);
    expect(r.unspecified).toEqual([]);
    expect(r.required[1].evidence).toEqual([{ raw: "React.js", sourceText: "3+ years of TypeScript and React.js", provenance: "requirements_section" }]);
    expect(r.preferred[0].evidence[0].provenance).toBe("preferred_section");
  });

  it("treats a preferred cue inside a requirements list as preferred", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- Python\n- Docker experience is a plus" });
    expect(skills(r.required)).toEqual(["python"]);
    expect(skills(r.preferred)).toEqual(["docker"]);
  });

  it("puts an unqualified structured skills field in unspecified, never required", () => {
    const r = extractSkillRequirements({ description: "We build tools.", skills: ["React", "nodejs", "Figma"] });
    expect(r.required).toEqual([]);
    expect(r.preferred).toEqual([]);
    expect(skills(r.unspecified)).toEqual(["react", "node.js"]);
    expect(r.unspecified[1].evidence).toEqual([{ raw: "nodejs", sourceText: "nodejs", provenance: "structured_skills" }]);
    expect(r.unrecognizedStructured).toEqual(["Figma"]); // kept as evidence, not normalised or invented
  });

  it("returns empty lists when there are no qualified sections and no structured skills", () => {
    for (const description of [null, "", "We use Python, Java and AWS every day.", "Qualifications\nPython experience."]) {
      const r = extractSkillRequirements({ description });
      expect([r.required, r.preferred, r.unspecified, r.alternatives, r.negated, r.conflicts], String(description)).toEqual([[], [], [], [], [], []]);
    }
  });

  it("ignores benefits, EEO, company text and responsibilities", () => {
    const r = extractSkillRequirements({
      description: [
        "About us",
        "We are an AWS partner building Kubernetes tooling.",
        "Responsibilities",
        "- Write Python services",
        "Requirements",
        "- Java",
        "Benefits",
        "- Free Docker and Redis training",
        "Equal Opportunity Employer",
        "- We welcome Go developers of every background.",
      ].join("\n"),
    });
    expect(skills(r.required)).toEqual(["java"]);
    expect([r.preferred, r.unspecified]).toEqual([[], []]);
  });

  it("ignores incidental skill words outside qualified sections", () => {
    const r = extractSkillRequirements({ description: "Our Java team ships React apps.\nRequirements\n- Strong communication\nWe love SQL." });
    expect([r.required, r.preferred, r.unspecified]).toEqual([[], [], []]);
  });

  it("normalises aliases, deduplicates them and keeps every piece of source evidence", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- Postgres\n- PostgreSQL tuning\n- K8s", skills: ["postgres"] });
    expect(skills(r.required)).toEqual(["postgresql", "kubernetes"]);
    expect(r.required[0].evidence.map((e) => e.raw)).toEqual(["Postgres", "PostgreSQL"]);
    expect(r.required[1].evidence[0].raw).toBe("K8s");
    expect(r.unspecified[0]).toEqual({ skill: "postgresql", evidence: [{ raw: "postgres", sourceText: "postgres", provenance: "structured_skills" }] });
  });

  it("keeps distinct technologies apart", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- JavaScript\n- React Native\n- ASP.NET" });
    expect(skills(r.required)).toEqual(["javascript", "react native", "c#"]);
  });

  it("does not turn negated skills into requirements", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- Java not required; Python required\n- No Kubernetes experience needed\n- Willing to learn without prior Go experience" });
    expect(skills(r.required)).toEqual(["python"]);
    expect(skills(r.negated)).toEqual(["java", "kubernetes", "golang"]);
    expect(r.negated[0].evidence[0]).toEqual({ raw: "Java", sourceText: "Java not required; Python required", provenance: "requirements_section" });
  });

  it("keeps OR alternatives as one group, never two mandatory requirements", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- Java OR Python\n- Experience with AWS/GCP\n- Either Vue or React\nPreferred Qualifications\n- One of Redis, MongoDB" });
    expect(r.required).toEqual([]);
    expect(r.alternatives.map((a) => [a.bucket, a.options])).toEqual([
      ["required", ["java", "python"]],
      ["required", ["aws", "gcp"]],
      ["required", ["vue", "react"]],
      ["preferred", ["redis", "mongodb"]],
    ]);
    expect(r.alternatives[0].evidence.map((e) => e.raw)).toEqual(["Java", "Python"]);
  });

  it("leaves a mixed and/or clause unspecified and flags it", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- Java and Python or Go" });
    expect([r.required, r.alternatives]).toEqual([[], []]);
    expect(skills(r.unspecified)).toEqual(["java", "python", "golang"]);
    expect(r.ambiguous).toEqual([{ raw: "Java and Python or Go", sourceText: "Java and Python or Go", provenance: "requirements_section" }]);
  });

  it("leaves a single skill 'or similar' unspecified instead of required", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- Python or similar scripting language\n- BS in CS or equivalent" });
    expect([r.required, r.alternatives]).toEqual([[], []]);
    expect(skills(r.unspecified)).toEqual(["python"]);
    expect(r.ambiguous.map((a) => a.raw)).toEqual(["Python or similar scripting language"]);
  });

  it("scopes negation to its own sentence", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- Strong SQL. MongoDB knowledge not necessary." });
    expect(skills(r.required)).toEqual(["sql"]);
    expect(skills(r.negated)).toEqual(["mongodb"]);
  });

  it("keeps conflicting required/preferred mentions in both lists and flags them", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- Docker\nNice to have skills\n- Docker in production" });
    expect(skills(r.required)).toEqual(["docker"]);
    expect(skills(r.preferred)).toEqual(["docker"]);
    expect(r.conflicts).toEqual([
      {
        skill: "docker",
        required: [{ raw: "Docker", sourceText: "Docker", provenance: "requirements_section" }],
        preferred: [{ raw: "Docker", sourceText: "Docker in production", provenance: "preferred_section" }],
      },
    ]);
  });

  it("does not match ambiguous short aliases in prose", () => {
    const r = extractSkillRequirements({ description: "Requirements\n- A go-getter who can go above and beyond\n- Comfortable with rest days and node graphs\n- Familiar with TS and JS" });
    expect([r.required, r.alternatives, r.negated]).toEqual([[], [], []]);
    expect(skills(extractSkillRequirements({ description: "Requirements\n- Go and REST APIs" }).required)).toEqual(["golang", "rest api"]);
  });
});
