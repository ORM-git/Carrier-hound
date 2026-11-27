import { describe, expect, it } from "vitest";
import { CANONICAL_JOB_TYPES, mapEmploymentType } from "../employmentTypeMap";

describe("mapEmploymentType (offline, unwired)", () => {
  it("passes every canonical value through as exact", () => {
    for (const value of CANONICAL_JOB_TYPES) {
      expect(mapEmploymentType(value, "greenhouse")).toEqual({ job_type: value, source_value: value, confidence: "exact" });
    }
  });

  it("maps each unambiguous synonym group", () => {
    const groups: Array<[string, string[]]> = [
      ["full-time", ["full time", "fulltime", "permanent"]],
      ["part-time", ["part time"]],
      ["contract", ["contractor", "freelance"]],
      ["internship", ["intern", "co-op"]],
    ];
    for (const [job_type, values] of groups) {
      for (const value of values) {
        expect(mapEmploymentType(value, "lever")).toEqual({ job_type, source_value: value, confidence: "mapped" });
      }
    }
  });

  it("ignores case and whitespace but preserves the raw source value", () => {
    expect(mapEmploymentType("  Full-Time ", "x")).toEqual({ job_type: "full-time", source_value: "  Full-Time ", confidence: "exact" });
    expect(mapEmploymentType("CONTRACT", "x")).toMatchObject({ job_type: "contract", confidence: "exact" });
    expect(mapEmploymentType("Full   Time", "x")).toMatchObject({ job_type: "full-time", confidence: "mapped" });
    expect(mapEmploymentType("\tPart time\n", "x")).toMatchObject({ job_type: "part-time", confidence: "mapped" });
    expect(mapEmploymentType("Co-Op", "x")).toMatchObject({ job_type: "internship", confidence: "mapped" });
  });

  it("falls back to 'other' for compound, blank, unknown and non-string values", () => {
    for (const value of ["full-time;contract", "Full-time, Part-time", "", "   ", "temporary", "seasonal", "full_time", "fixed term"]) {
      expect(mapEmploymentType(value, "x")).toEqual({ job_type: "other", source_value: value, confidence: "fallback" });
    }
    for (const value of [null, undefined, 42, ["full-time"]]) {
      expect(mapEmploymentType(value, "x")).toEqual({ job_type: "other", source_value: null, confidence: "fallback" });
    }
  });

  it("negative control: 'full-time;contract' is NOT forced into full-time", () => {
    const result = mapEmploymentType("full-time;contract", "smartrecruiters");
    expect(result.job_type).not.toBe("full-time");
    expect(result.job_type).not.toBe("contract");
    expect(result).toEqual({ job_type: "other", source_value: "full-time;contract", confidence: "fallback" });
  });

  it("always returns a constrained job_type", () => {
    for (const value of ["full time", "???", "internship", "per diem", "Part-Time"]) {
      expect(CANONICAL_JOB_TYPES).toContain(mapEmploymentType(value, "x").job_type);
    }
  });

  it("never returns an inherited Object.prototype member for adversarial keys", () => {
    // "toString" is a control: same prototype-inheritance shape, must also fall back.
    for (const value of ["constructor", "__proto__", "hasOwnProperty", "valueOf", "toString", "  Constructor ", "__PROTO__"]) {
      expect(mapEmploymentType(value, "x")).toEqual({ job_type: "other", source_value: value, confidence: "fallback" });
    }
  });

  it("invariant: job_type is always a CANONICAL_JOB_TYPES member (adversarial + valid table)", () => {
    const table: unknown[] = [
      "constructor", "__proto__", "hasOwnProperty", "valueOf", "toString", "isPrototypeOf",
      "propertyIsEnumerable", "toLocaleString", "__defineGetter__", "__lookupSetter__",
      "full-time", "Full Time", "permanent", "contractor", "co-op", "internship", "job", "other",
      "full-time;contract", "", "   ", "temporary", null, undefined, 0, {}, ["contract"],
    ];
    for (const value of table) {
      const { job_type } = mapEmploymentType(value, "x");
      expect(typeof job_type).toBe("string");
      expect(CANONICAL_JOB_TYPES).toContain(job_type);
    }
  });
});
