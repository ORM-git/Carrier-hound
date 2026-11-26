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

describe("cue scope: each requirement, preference and negation applies to its own proposition", () => {
  const req = (bullet: string, section = "Requirements") => extractSkillRequirements({ description: `${section}\n- ${bullet}` });

  describe("regressions from review", () => {
    it("'Java is required, Python is preferred' splits required and preferred", () => {
      const r = req("Java is required, Python is preferred");
      expect(skills(r.required)).toEqual(["java"]);
      expect(skills(r.preferred)).toEqual(["python"]);
      expect(r.required[0].evidence[0]).toEqual({ raw: "Java", sourceText: "Java is required, Python is preferred", provenance: "requirements_section" });
    });

    it("'Java not required, but Python is mandatory' negates only Java", () => {
      const r = req("Java not required, but Python is mandatory");
      expect(skills(r.negated)).toEqual(["java"]);
      expect(skills(r.required)).toEqual(["python"]);
    });

    it("'Python required and Docker is a plus' keeps Python required", () => {
      const r = req("Python required and Docker is a plus");
      expect(skills(r.required)).toEqual(["python"]);
      expect(skills(r.preferred)).toEqual(["docker"]);
    });

    it("'We do need Java experience' is affirmative, not negated", () => {
      const r = req("We do need Java experience");
      expect(skills(r.required)).toEqual(["java"]);
      expect(r.negated).toEqual([]);
    });
  });

  it("distinguishes do/does need from do not/does not/don't/doesn't need", () => {
    for (const bullet of ["We do need Java", "The team does need Java", "You need Java", "Java is needed"]) {
      expect(skills(req(bullet).required), bullet).toEqual(["java"]);
      expect(req(bullet).negated, bullet).toEqual([]);
    }
    for (const bullet of ["We do not need Java", "The team does not need Java", "You don't need Java", "It doesn't need Java", "You don’t need Java", "No Java experience needed", "Java experience not needed", "No need for Java"]) {
      expect(skills(req(bullet).negated), bullet).toEqual(["java"]);
      expect(req(bullet).required, bullet).toEqual([]);
    }
  });

  it("does not read the noun 'needs' as a cue", () => {
    const r = req("Understanding of business needs, SQL");
    expect([skills(r.required), r.ambiguous]).toEqual([["sql"], []]);
  });

  it("handles reversed cue order", () => {
    const a = req("Python is preferred, Java is required");
    expect([skills(a.required), skills(a.preferred)]).toEqual([["java"], ["python"]]);
    const b = req("Docker is a plus, but Python is required");
    expect([skills(b.required), skills(b.preferred)]).toEqual([["python"], ["docker"]]);
    const c = req("Python is mandatory, Java is not required");
    expect([skills(c.required), skills(c.negated)]).toEqual([["python"], ["java"]]);
    const d = req("Python is preferred but not required");
    expect([skills(d.preferred), d.required, d.negated]).toEqual([["python"], [], []]);
  });

  it("keeps a plain required list together", () => {
    for (const bullet of ["Java, Python and Docker", "Java, Python and Docker required", "Required: Java, Python, Docker", "Experience with Java and Python"]) {
      expect(skills(req(bullet).required), bullet).toEqual(bullet.includes("Docker") ? ["java", "python", "docker"] : ["java", "python"]);
    }
    expect(skills(req("Java, Python and Docker are a plus").preferred)).toEqual(["java", "python", "docker"]);
  });

  it("keeps comma-separated alternatives as one group", () => {
    const r = req("Java, Python, or Go");
    expect(r.required).toEqual([]);
    expect(r.alternatives.map((a) => [a.bucket, a.options])).toEqual([["required", ["java", "python", "golang"]]]);
  });

  it("scopes AND/OR groups inside a multi-cue clause", () => {
    const r = req("Java or Python required, Docker and Kubernetes a plus");
    expect(r.alternatives.map((a) => [a.bucket, a.options])).toEqual([["required", ["java", "python"]]]);
    expect(skills(r.preferred)).toEqual(["docker", "kubernetes"]);
    expect(r.required).toEqual([]);
  });

  it("keeps semicolon and sentence scope", () => {
    const r = req("Java is required; Python preferred. Go is not required.");
    expect([skills(r.required), skills(r.preferred), skills(r.negated)]).toEqual([["java"], ["python"], ["golang"]]);
  });

  it("marks a skill with no cue of its own after several cued propositions as ambiguous", () => {
    const r = req("Java is required, Python is preferred, Go");
    expect([skills(r.required), skills(r.preferred)]).toEqual([["java"], ["python"]]);
    expect(skills(r.unspecified)).toEqual(["golang"]);
    expect(r.ambiguous.map((a) => a.raw)).toEqual(["Go"]);
  });

  it("does not let a required cue inside a preferred list pick a confident bucket", () => {
    const r = req("Java required", "Preferred Qualifications");
    expect([r.required, r.preferred]).toEqual([[], []]);
    expect(skills(r.unspecified)).toEqual(["java"]);
    expect(r.ambiguous[0]).toEqual({ raw: "Java required", sourceText: "Java required", provenance: "preferred_section" });
  });
});

describe("local cues: optional wording, combined qualifiers and '&' joins", () => {
  const req = (bullet: string, section = "Requirements") => extractSkillRequirements({ description: `${section}\n- ${bullet}` });

  describe("regressions from review", () => {
    it("'Java is optional' under Requirements is never required", () => {
      const r = req("Java is optional");
      expect([r.required, r.preferred, r.negated]).toEqual([[], [], []]);
      expect(r.unspecified).toEqual([{ skill: "java", evidence: [{ raw: "Java", sourceText: "Java is optional", provenance: "requirements_section" }] }]);
    });

    it("'Python is not required but preferred' keeps the preference", () => {
      const r = req("Python is not required but preferred");
      expect([skills(r.preferred), r.required, r.negated]).toEqual([["python"], [], []]);
      expect(r.preferred[0].evidence[0]).toEqual({ raw: "Python", sourceText: "Python is not required but preferred", provenance: "requirements_section" });
    });

    it("'Java is required & Python is preferred' splits at '&'", () => {
      const r = req("Java is required & Python is preferred");
      expect([skills(r.required), skills(r.preferred)]).toEqual([["java"], ["python"]]);
    });
  });

  it("optional wording overrides the section default in both sections and any case", () => {
    for (const [bullet, section] of [
      ["Java is optional", "Requirements"],
      ["JAVA IS OPTIONAL", "Minimum Qualifications"],
      ["Optional: Java", "Requirements"],
      ["Java (optional)", "Requirements"],
      ["Java is optional", "Preferred Qualifications"],
    ]) {
      const r = req(bullet, section);
      expect([r.required, r.preferred, r.negated], `${section}: ${bullet}`).toEqual([[], [], []]);
      expect(skills(r.unspecified), `${section}: ${bullet}`).toEqual(["java"]);
    }
  });

  it("scopes optional to its own proposition", () => {
    const a = req("Java is required, Python is optional");
    expect([skills(a.required), skills(a.unspecified), a.preferred]).toEqual([["java"], ["python"], []]);
    const b = req("Python is optional, but Java is required");
    expect([skills(b.required), skills(b.unspecified)]).toEqual([["java"], ["python"]]);
    const c = req("Java is optional but preferred");
    expect([skills(c.preferred), c.required, c.unspecified]).toEqual([["java"], [], []]);
  });

  it("keeps an explicit preference whichever order 'not required' and 'preferred' come in", () => {
    for (const bullet of ["Python is preferred but not required", "Python is not required but preferred", "Python: not required, but preferred", "PYTHON IS NOT REQUIRED BUT PREFERRED", "Python is not required, though nice to have"]) {
      for (const section of ["Requirements", "Preferred Qualifications"]) {
        const r = req(bullet, section);
        expect([skills(r.preferred), r.required, r.negated], `${section}: ${bullet}`).toEqual([["python"], [], []]);
      }
    }
  });

  it("leaves a self-contradicting qualifier unspecified, never required", () => {
    const r = req("Java is required but optional");
    expect([r.required, r.preferred]).toEqual([[], []]);
    expect(skills(r.unspecified)).toEqual(["java"]);
    expect(r.ambiguous[0].raw).toBe("Java is required but optional");
  });

  it("splits '&' only between cue-bearing propositions", () => {
    expect(skills(req("Java & Python").required)).toEqual(["java", "python"]);
    expect(skills(req("Java & Python are a plus").preferred)).toEqual(["java", "python"]);
    const rev = req("Python is preferred & Java is required");
    expect([skills(rev.required), skills(rev.preferred)]).toEqual([["java"], ["python"]]);
    const neg = req("Java is not required & Python is mandatory");
    expect([skills(neg.negated), skills(neg.required)]).toEqual([["java"], ["python"]]);
    const alt = req("Java or Python is required & Docker is a plus");
    expect(alt.alternatives.map((a) => [a.bucket, a.options])).toEqual([["required", ["java", "python"]]]);
    expect([skills(alt.preferred), alt.required]).toEqual([["docker"], []]);
    // A mixed & / or list with one cue is still ambiguous, not two requirements
    const mixed = req("Java & Python or Go");
    expect([mixed.required, mixed.alternatives, skills(mixed.unspecified)]).toEqual([[], [], ["java", "python", "golang"]]);
  });

  it("does not let a skill-less clause with other words act as a bare qualifier", () => {
    const r = req("Proficiency in SQL and Python is required, while Tableau is nice to have");
    expect([skills(r.required), r.ambiguous]).toEqual([["sql", "python"], []]);
  });
});
