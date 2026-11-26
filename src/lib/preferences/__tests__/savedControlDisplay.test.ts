import { describe, it, expect } from "vitest";
import { savedControlDisplay } from "../savedControlDisplay";

const base = (o: Record<string, unknown>) => o as never;

describe("savedControlDisplay", () => {
  it("keeps every multi-valued choice", () => {
    const d = savedControlDisplay(base({ employmentTypes: ["full-time", "contract", "part-time"], workModels: ["remote", "hybrid"], countryCode: "in" }));
    expect(d.jobType).toBe("full-time,contract,part-time");
    expect(d.workModel!.split(",").sort()).toEqual(["hybrid", "remote"]);
    expect(d.countryCode).toBe("IN");
  });
  it("falls back to the legacy single remote preference", () => {
    expect(savedControlDisplay(base({ remotePreference: "remote" })).workModel).toBe("remote");
  });
  it("shows nothing for any/empty/unknown values and never invents roles or skills", () => {
    const d = savedControlDisplay(base({ remotePreference: "any", employmentTypes: ["weird"], countryCode: "ZZ", roles: ["Data Analyst"], skills: ["sql"] }));
    expect(d).toEqual({});
    expect(savedControlDisplay(null)).toEqual({});
  });
});
