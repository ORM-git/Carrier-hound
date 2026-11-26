import { describe, expect, it } from "vitest";
import { descriptionSections, extendedDescriptionSections, structuredDescriptionList } from "../descriptionSections";

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

describe("education and languages sections (opt-in, headed bullets only)", () => {
  const empty = { responsibilities: [], requirements: [], preferred: [], benefits: [], education: [], languages: [] };
  it("captures headed education and languages bullet lists", () => {
    const text = "Education Requirements:\n- BS in Computer Science.\n- Or equivalent experience.\n## Languages\n* English (fluent).\n* Hindi.\nEducational Qualifications\n1. MBA preferred.\nLanguage Requirements\n• German B2.";
    expect(extendedDescriptionSections(text)).toEqual({ ...empty, education: ["BS in Computer Science.", "Or equivalent experience.", "MBA preferred."], languages: ["English (fluent).", "Hindi.", "German B2."] });
  });
  it("does not capture unheaded or inline education/language prose", () => {
    for (const text of ["A bachelor's degree in CS is required.\n- BS in CS", "Education is important to us.\n- Masters", "Education: BS in CS", "Languages spoken: English, Hindi", "- Fluent English"]) {
      expect(extendedDescriptionSections(text)).toEqual(empty);
    }
  });
  it("ends a languages list at the first paragraph", () => {
    expect(extendedDescriptionSections("Languages\n- English\nWe are a global team.\n- Spanish").languages).toEqual(["English"]);
  });
  it("still excludes EEO blocks after the new sections", () => {
    const value = extendedDescriptionSections("Education\n- BS degree\nEqual Opportunity Employer\n- We do not discriminate on any basis.\nLanguages\n- English\nWe are an equal opportunity employer.\n- Race, religion, gender.");
    expect(value.education).toEqual(["BS degree"]);
    expect(value.languages).toEqual(["English"]);
  });
  it("negative control: education mentioned inside a benefits paragraph is not captured", () => {
    const value = extendedDescriptionSections("Benefits\n- Paid leave.\nWe also fund continuing education and language classes.\n- Education stipend");
    expect(value).toEqual({ ...empty, benefits: ["Paid leave."] });
  });
  it("keeps the original four sections and shape identical when education/languages headings are present", () => {
    const text = "Responsibilities\n- Build tools.\nEducation\n- BS degree\n- Review code.\nQualifications\n- Go.\nLanguages\n- English\nBenefits\n- Paid leave.";
    const legacy = { responsibilities: ["Build tools."], requirements: ["Go."], preferred: [], benefits: ["Paid leave."] };
    expect(descriptionSections(text)).toStrictEqual(legacy);
    expect(Object.keys(descriptionSections(text))).toEqual(["responsibilities", "requirements", "preferred", "benefits"]);
    const { education, languages, ...rest } = extendedDescriptionSections(text);
    expect(rest).toStrictEqual(legacy);
    expect(education).toEqual(["BS degree", "Review code."]);
    expect(languages).toEqual(["English"]);
  });
});
