import { describe, expect, it } from "vitest";
import { descriptionSections, structuredDescriptionList } from "../descriptionSections";

describe("optional benefits never infer recruiter or application capabilities", () => {
  it.each(["Why join us\n- Competitive salary", "Recruiter\n- Contact Jane", "Easy Apply\n- One click", "We offer benefits, ask our recruiter for details."])("leaves unsupported source prose unclassified: %s", text => {
    expect(descriptionSections(text).benefits).toEqual([]);
  });
  it("stops an explicit benefits list at recruiter/contact or application headings", () => {
    const value = descriptionSections("Benefits\n- Paid leave\nRecruiter\n- Jane Doe\nEasy Apply\n- Apply in one click\nWhy join us\n- Guaranteed promotion");
    expect(value.benefits).toEqual(["Paid leave"]);
    expect(Object.keys(value).sort()).toEqual(["benefits", "preferred", "requirements", "responsibilities"]);
  });
  it("does not synthesize a benefit from null, structured contacts or a count", () => {
    expect(structuredDescriptionList([{ name: "Jane", email: "jane@example.invalid" }, null, 250, false])).toEqual([]);
    expect(descriptionSections(null).benefits).toEqual([]);
  });
  it("preserves explicit qualifications and limitations instead of upgrading the offer", () => {
    expect(descriptionSections("Benefits\n- Health insurance subject to local eligibility\n- Discretionary bonus; not guaranteed").benefits).toEqual(["Health insurance subject to local eligibility", "Discretionary bonus; not guaranteed"]);
  });
});
