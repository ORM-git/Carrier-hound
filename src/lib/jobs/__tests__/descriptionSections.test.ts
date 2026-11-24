import { describe, expect, it } from "vitest";
import { descriptionSections, structuredDescriptionList } from "../descriptionSections";

describe("conservative display-only description sections", () => {
  it("extracts only explicit headed bullets and preserves their wording", () => {
    const value = descriptionSections("About the team\nWe build tools.\nResponsibilities:\n- Build tools.\n- Review code.\nQualifications\n* TypeScript experience.\nPreferred Qualifications\n1. Accessibility experience.\nBenefits\n• Paid leave.\nEqual opportunity\n- This is not a benefit.");
    expect(value).toEqual({ responsibilities: ["Build tools.", "Review code."], requirements: ["TypeScript experience."], preferred: ["Accessibility experience."], benefits: ["Paid leave."] });
  });
  it("handles encoded HTML headings and lists without rendering markup", () => {
    const value = descriptionSections("&lt;h2&gt;What you'll do&lt;/h2&gt;&lt;ul&gt;&lt;li&gt;Build R&amp;amp;D tools.&lt;/li&gt;&lt;/ul&gt;&lt;h3&gt;Minimum Qualifications&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Go experience.&lt;/li&gt;&lt;/ul&gt;");
    expect(value.responsibilities).toEqual(["Build R&D tools."]);
    expect(value.requirements).toEqual(["Go experience."]);
  });
  it("never infers categories from prose, loose bullets or heading-like sentences", () => {
    for (const text of ["Benefits include paid leave.", "Responsibilities are varied.\n- Review code", "- Go experience", "Qualifications\nGo experience.\n- unrelated", "Benefits of working here\n- paid leave"]) {
      expect(descriptionSections(text)).toEqual({ responsibilities: [], requirements: [], preferred: [], benefits: [] });
    }
  });
  it("ignores executable containers before identifying headings", () => {
    expect(descriptionSections('<script>Benefits\n- Secret</script><h2>Benefits</h2><ul><li>Paid leave.</li></ul>').benefits).toEqual(["Paid leave."]);
  });
  it("deduplicates repeated bullets and ignores empty headings", () => {
    expect(descriptionSections("Benefits\n- Paid leave\n- Paid leave\nResponsibilities").benefits).toEqual(["Paid leave"]);
    expect(descriptionSections(null).requirements).toEqual([]);
  });
  it("cleans explicit source lists without object coercion", () => {
    expect(structuredDescriptionList(["<b>Paid leave</b>", {}, null, "Paid leave"])).toEqual(["Paid leave"]);
    expect(structuredDescriptionList("- R&amp;D\n• Go")).toEqual(["R&D", "Go"]);
  });
});
