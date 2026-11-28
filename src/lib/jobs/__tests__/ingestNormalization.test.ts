import { describe, expect, it } from "vitest";
import { ingestNormalizationColumns } from "../ingestNormalization";
import { extractorVersion } from "../skillRequirements";

describe("ingestNormalizationColumns (checklist #21, #27)", () => {
  it("annualizes only a source-stated period and flags assumed conversions", () => {
    const monthly = ingestNormalizationColumns({ salary_min: 5000, salary_max: 6000, salary_period: "monthly", salary_period_stated: true });
    expect(monthly).toMatchObject({ salary_annual_min: 60000, salary_annual_max: 72000, salary_period_inferred: false, salary_conversion_assumed: false });
    const hourly = ingestNormalizationColumns({ salary_min: 50, salary_period: "hourly", salary_period_stated: true });
    expect(hourly).toMatchObject({ salary_annual_min: 104000, salary_annual_max: null, salary_conversion_assumed: true });
  });

  it("never annualizes an adapter-default period", () => {
    const c = ingestNormalizationColumns({ salary_min: 120000, salary_max: 160000, salary_period: "yearly" });
    expect(c).toMatchObject({ salary_annual_min: null, salary_annual_max: null, salary_period_inferred: true, salary_conversion_assumed: null });
  });

  it("leaves salary flags null when there is no salary", () => {
    expect(ingestNormalizationColumns({})).toMatchObject({ salary_annual_min: null, salary_period_inferred: null, salary_conversion_assumed: null });
  });

  it("stores versioned skill requirements and invents none from absent text", () => {
    const empty = ingestNormalizationColumns({ description: null });
    expect(empty.skill_requirements_version).toBe(extractorVersion);
    expect(empty.skill_requirements.required).toEqual([]);
    expect(empty.skill_requirements.preferred).toEqual([]);
    const c = ingestNormalizationColumns({ description: "Minimum Qualifications\n- Experience with Python\nPreferred Qualifications\n- Kubernetes experience" });
    expect(c.skill_requirements.required.map((e) => e.skill)).toContain("python");
    expect(c.skill_requirements.preferred.map((e) => e.skill)).toContain("kubernetes");
  });
});
