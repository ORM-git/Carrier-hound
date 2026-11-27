import { describe, expect, it } from "vitest";
import { COMPANY_CATEGORIES, ROLE_CATEGORIES, detectCompanyCategory, detectRoleCategory } from "../highVolumeEnrichment";

// These are coarse product classifications, not a complete occupation/industry taxonomy.
describe("occupation and employer categories remain separate evidence", () => {
  it.each(["Registered Nurse", "Classroom Teacher", "Warehouse Associate", "Retail Cashier", "Accountant", "Legal Counsel"])("does not invent a technical occupation for %s", (title) => {
    expect(detectRoleCategory(title, null, [])).toBe("OTHER");
  });
  it("does not turn a known technology employer into a technical job title", () => {
    expect(detectCompanyCategory("Microsoft", "microsoft", null, "US")).toBe("MNC_BIGTECH");
    expect(detectRoleCategory("Accountant", "Finance", [])).toBe("OTHER");
    expect(detectRoleCategory("Software Engineer", null, [])).toBe("SDE");
  });
  it("does not reuse role codes as employer category or pretend employer categories are industry codes", () => {
    expect(COMPANY_CATEGORIES.filter(value => (ROLE_CATEGORIES as readonly string[]).includes(value))).toEqual([]);
    expect(detectRoleCategory(null, null, null)).toBe("OTHER");
  });
});
