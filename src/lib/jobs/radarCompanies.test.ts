import { describe, expect, it } from "vitest";
import { radarCompanyName } from "./radarCompanies";

describe("radarCompanyName", () => {
  it("keeps a real employer name", () => expect(radarCompanyName(" Acme ")).toBe("Acme"));
  it("drops the masked placeholder, blanks and non-strings", () => {
    for (const v of ["Verified Employer", "", "  ", null, undefined, 5]) expect(radarCompanyName(v)).toBeNull();
  });
});
