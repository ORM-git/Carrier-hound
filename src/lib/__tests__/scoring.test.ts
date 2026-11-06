import { describe, it, expect } from "vitest";
import {
  getCanonicalSkillId,
  areSkillsGenuineMatch,
  normalizeSkillToTokens,
} from "@/lib/matcher/scoring";

describe("skill matching", () => {
  it("resolves known aliases to a canonical skill id", () => {
    expect(getCanonicalSkillId("React.js")).toBe(getCanonicalSkillId("react"));
    expect(getCanonicalSkillId("k8s")).toBe(getCanonicalSkillId("kubernetes"));
  });

  it("returns null for unknown skills", () => {
    expect(getCanonicalSkillId("not-a-real-skill-xyz")).toBeNull();
  });

  it("treats alias variants as genuine matches", () => {
    expect(areSkillsGenuineMatch("React", "React.js")).toBe(true);
    expect(areSkillsGenuineMatch("React", "Java")).toBe(false);
  });

  it("tokenizes multi-word skills", () => {
    const { tokens } = normalizeSkillToTokens("Amazon Web Services");
    expect(tokens.size).toBeGreaterThan(1);
    expect(tokens.has("amazon") || tokens.has("aws") || tokens.has("web")).toBe(true);
  });
});
