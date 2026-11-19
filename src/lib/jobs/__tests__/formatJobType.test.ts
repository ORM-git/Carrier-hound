import { describe, it, expect } from "vitest";
import { formatJobType } from "../formatJobType";

describe("formatJobType", () => {
  it("returns null for missing, null, or undefined values to cleanly hide the field", () => {
    expect(formatJobType(null)).toBeNull();
    expect(formatJobType(undefined)).toBeNull();
    expect(formatJobType("")).toBeNull();
    expect(formatJobType("   ")).toBeNull();
  });

  it("never invents 'Full-time' for generic unknown/placeholder values", () => {
    expect(formatJobType("job")).toBeNull();
    expect(formatJobType("JOB")).toBeNull();
    expect(formatJobType("unknown")).toBeNull();
    expect(formatJobType("Unknown")).toBeNull();
    expect(formatJobType("other")).toBeNull();
    expect(formatJobType("OTHER")).toBeNull();
    expect(formatJobType("n/a")).toBeNull();
    expect(formatJobType("na")).toBeNull();
    expect(formatJobType("none")).toBeNull();
    expect(formatJobType("unlisted")).toBeNull();
  });

  it("formats genuine job types with canonical casing when present in source data", () => {
    expect(formatJobType("full-time")).toBe("Full-time");
    expect(formatJobType("full_time")).toBe("Full-time");
    expect(formatJobType("fulltime")).toBe("Full-time");
    expect(formatJobType("FULL-TIME")).toBe("Full-time");

    expect(formatJobType("internship")).toBe("Internship");
    expect(formatJobType("intern")).toBe("Internship");
    expect(formatJobType("INTERNSHIP")).toBe("Internship");

    expect(formatJobType("part-time")).toBe("Part-time");
    expect(formatJobType("part_time")).toBe("Part-time");
    expect(formatJobType("parttime")).toBe("Part-time");

    expect(formatJobType("contract")).toBe("Contract");
    expect(formatJobType("contractor")).toBe("Contract");

    expect(formatJobType("temporary")).toBe("Temporary");
    expect(formatJobType("temp")).toBe("Temporary");

    expect(formatJobType("volunteer")).toBe("Volunteer");
    expect(formatJobType("freelance")).toBe("Freelance");
    expect(formatJobType("per diem")).toBe("Per Diem");
  });

  it("capitalizes words for valid custom job types", () => {
    expect(formatJobType("apprenticeship")).toBe("Apprenticeship");
    expect(formatJobType("graduate program")).toBe("Graduate Program");
  });
});
