import { describe, expect, it } from "vitest";
import {
  applyFeedConstraints,
  appendFeedConstraintParams,
  datePostedCutoff,
  feedConstraintsFromParams,
  legacyRemotePreference,
  matchesFeedConstraints,
  normalizeFeedConstraints,
  normalizeTextList,
  parseDatePosted,
  stricterDatePosted,
  workModelsFromLegacy,
} from "../feedConstraints";
import { categoriesForRoles } from "@/lib/onboarding/roleCategories";
import { activeCount, companyConflicts, draftFromPreferences, groupCounts, preferencesFromDraft, summarize, validateDraft } from "../model";
import { emptyUserPreferences, DEFAULT_USER_PREFERENCES, type UserPreferences } from "@/lib/auth/types";

const NOW = Date.parse("2026-11-25T12:00:00.000Z");
const DAY = 24 * 3600e3;

describe("date posted windows", () => {
  it("parses canonical values and older labels; any/all/empty is no window", () => {
    expect(["24h", "3d", "7d", "30d"].map(parseDatePosted)).toEqual(["24h", "3d", "7d", "30d"]);
    expect(parseDatePosted("last3days")).toBe("3d");
    expect(parseDatePosted("last30days")).toBe("30d");
    expect(parseDatePosted("last7days")).toBe("7d");
    expect(parseDatePosted("Past week")).toBe("7d");
    expect([null, "", "all", "any", "bogus"].map(parseDatePosted)).toEqual([null, null, null, null, null]);
  });

  it("3d is a real three-day window, not seven", () => {
    expect(datePostedCutoff("3d", NOW)).toBe(new Date(NOW - 3 * DAY).toISOString());
    const c = normalizeFeedConstraints({ datePosted: "3d" });
    expect(matchesFeedConstraints({ postedAt: new Date(NOW - 3 * DAY + 1000).toISOString() }, c, NOW)).toBe(true);
    expect(matchesFeedConstraints({ postedAt: new Date(NOW - 3 * DAY - 1000).toISOString() }, c, NOW)).toBe(false);
    expect(matchesFeedConstraints({ postedAt: new Date(NOW - 5 * DAY).toISOString() }, normalizeFeedConstraints({ datePosted: "7d" }), NOW)).toBe(true);
  });

  it("an unknown posting date never passes an active window", () => {
    expect(matchesFeedConstraints({ postedAt: null }, normalizeFeedConstraints({ datePosted: "30d" }), NOW)).toBe(false);
    expect(matchesFeedConstraints({ postedAt: null }, normalizeFeedConstraints({}), NOW)).toBe(true);
  });

  it("saved and browsing windows AND together: the narrower wins", () => {
    expect(stricterDatePosted("7d", "3d")).toBe("3d");
    expect(stricterDatePosted("24h", "30d")).toBe("24h");
    expect(stricterDatePosted("", "3d")).toBe("3d");
    expect(stricterDatePosted(null, null)).toBeNull();
  });
});

describe("lists, include/exclude and query predicates", () => {
  it("normalizes text lists: trim, collapse spaces, case-insensitive de-dupe, drop non-strings", () => {
    expect(normalizeTextList(["  Sales ", "sales", "Account  Exec", "", 3, null])).toEqual(["Sales", "Account Exec"]);
  });

  it("exclusion wins an include/exclude conflict, deterministically", () => {
    const c = normalizeFeedConstraints({ includedCompanies: ["Acme", "Globex"], excludedCompanies: ["acme"] });
    expect(c.includedCompanies).toEqual(["Globex"]);
    expect(matchesFeedConstraints({ company: "Acme" }, c)).toBe(false);
    expect(matchesFeedConstraints({ company: "globex" }, c)).toBe(true);
    expect(matchesFeedConstraints({ company: "Initech" }, c)).toBe(false); // inclusion list limits
  });

  it("OR inside a list, AND across dimensions", () => {
    const c = normalizeFeedConstraints({ excludedTitles: ["intern", "sales"], includedCompanies: ["Acme", "Globex"] });
    expect(matchesFeedConstraints({ title: "Backend Engineer", company: "Globex" }, c)).toBe(true);
    expect(matchesFeedConstraints({ title: "Sales Engineer", company: "Globex" }, c)).toBe(false);
    expect(matchesFeedConstraints({ title: "Software Intern", company: "Acme" }, c)).toBe(false);
    expect(matchesFeedConstraints({ title: "Backend Engineer", company: "Initech" }, c)).toBe(false);
  });

  it("company matching is exact (case-insensitive), not substring", () => {
    const c = normalizeFeedConstraints({ excludedCompanies: ["Meta"] });
    expect(matchesFeedConstraints({ company: "Metabase" }, c)).toBe(true);
    expect(matchesFeedConstraints({ company: "META" }, c)).toBe(false);
  });

  it("request params round-trip, including names with commas", () => {
    const c = normalizeFeedConstraints({ excludedTitles: ["Sales"], includedCompanies: ["Acme, Inc."], excludedCompanies: ["Globex"] });
    const p = new URLSearchParams();
    appendFeedConstraintParams(p, c);
    expect(feedConstraintsFromParams(new URLSearchParams(p.toString()))).toEqual({ ...c, datePosted: null });
  });

  it("builds PostgREST predicates with no filter-breaking characters", () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const q: any = {
      not: (...a: unknown[]) => (calls.push(["not", ...a]), q),
      or: (...a: unknown[]) => (calls.push(["or", ...a]), q),
    };
    applyFeedConstraints(q, normalizeFeedConstraints({ excludedTitles: ["50% (remote)"], includedCompanies: ["O'Reilly", "Acme, Inc."], excludedCompanies: ["Globex"] }));
    expect(calls).toEqual([
      ["not", "title", "ilike", "%50_ _remote_%"],
      ["not", "company", "ilike", "Globex"],
      ["or", "company.ilike.O_Reilly,company.ilike.Acme_ Inc."],
    ]);
  });
});

describe("work model contract", () => {
  it("legacy single value reads as one selection; 'any' reads as none", () => {
    expect(workModelsFromLegacy("hybrid")).toEqual(["hybrid"]);
    expect(workModelsFromLegacy("any")).toEqual([]);
    expect(workModelsFromLegacy(undefined)).toEqual([]);
  });
  it("a combination is never written as remote-only", () => {
    expect(legacyRemotePreference(["hybrid", "remote"])).toBe("any");
    expect(legacyRemotePreference(["remote"])).toBe("remote");
    expect(legacyRemotePreference([])).toBe("any");
  });
});

describe("role -> job category mapping", () => {
  it("maps taxonomy roles to real job categories and never invents one for custom text", () => {
    expect(categoriesForRoles(["Frontend Developer", "QA / Test Engineer", "Data Engineer", "Machine Learning Engineer"])).toEqual([
      "engineering",
      "qa-testing",
      "data",
      "ai",
    ]);
    expect(categoriesForRoles(["Retail Wizard", "Lead Frontend Engineer"])).toEqual([]);
    // Taxonomy roles with no job-side category add none (no "supply chain" -> "ai" substring accidents).
    expect(categoriesForRoles(["Supply Chain Manager", "Registered Nurse"])).toEqual([]);
  });
});

describe("preferences sheet model", () => {
  const committed = (over: Partial<UserPreferences> = {}): UserPreferences => ({
    ...emptyUserPreferences(),
    feedConstraintsAvailable: true,
    dailyDigestOptIn: true,
    onboardingCompleted: true,
    eligibilityFilter: false,
    country: "India",
    countryCode: "IN",
    ...over,
  });

  it("saving carries every field the sheet does not edit", () => {
    const base = committed({ roles: ["Custom Role"], workAuth: "I need visa sponsorship." });
    const d = draftFromPreferences(base);
    d.excludedTitles = ["Sales"];
    const out = preferencesFromDraft(base, d);
    expect(out.dailyDigestOptIn).toBe(true);
    expect(out.onboardingCompleted).toBe(true);
    expect(out.eligibilityFilter).toBe(false);
    expect(out.country).toBe("India");
    expect(out.countryCode).toBe("IN");
    expect(out.roles).toEqual(["Custom Role"]); // custom legacy role preserved
    expect(out.categories).toEqual([]);
    expect(out.workAuth).toBe("I need visa sponsorship.");
    expect(out.excludedTitles).toEqual(["Sales"]);
  });

  it("does not write constraint fields when their storage is unavailable", () => {
    const base = committed({ feedConstraintsAvailable: false });
    const d = draftFromPreferences(base);
    d.excludedTitles = ["Sales"];
    const out = preferencesFromDraft(base, d);
    expect(out.excludedTitles).toBeUndefined();
    expect(activeCount(d, false)).toBe(1); // country only: the unavailable excluded-titles control never counts
    expect(activeCount(d, true)).toBe(2);
  });

  it("counts committed dimensions once; groups and top count agree", () => {
    const d = draftFromPreferences(
      committed({ roles: ["A", "B", "C"], workModels: ["hybrid", "remote"], excludedCompanies: ["X"], minSalary: 100000, salaryCurrency: "USD", workAuth: "I need visa sponsorship." })
    );
    const g = groupCounts(d, true);
    // roles, work model, country = 3; salary = 1; excluded companies = 1; work auth is saved but not counted.
    expect(g).toEqual({ basic: 3, compensation: 1, interests: 0, company: 1 });
    expect(activeCount(d, true)).toBe(5);
    expect(summarize(["A", "B", "C"])).toEqual({ shown: ["A", "B"], more: 1 });
  });

  it("blank salary is no minimum; a minimum needs a currency", () => {
    const d = draftFromPreferences(committed());
    expect(d.minSalary).toBeNull();
    expect(validateDraft({ ...d, minSalary: 50000, salaryCurrency: "" }).errors.salaryCurrency).toBeTruthy();
    expect(validateDraft({ ...d, minSalary: -1, salaryCurrency: "USD" }).errors.minSalary).toBeTruthy();
    expect(validateDraft({ ...d, minSalary: null }).ok).toBe(true);
    expect(preferencesFromDraft(committed(), { ...d, minSalary: null }).minSalary).toBeUndefined();
  });

  it("shows include/exclude conflicts", () => {
    const d = { ...draftFromPreferences(committed()), includedCompanies: ["Acme"], excludedCompanies: ["ACME"] };
    expect(companyConflicts(d)).toEqual(["Acme"]);
    // the overridden inclusion has no effect, so only the exclusion counts
    expect(groupCounts(d, true).company).toBe(1);
  });

  it("never starts from the legacy sample preferences", () => {
    const d = draftFromPreferences(emptyUserPreferences());
    expect(d.roles).not.toEqual(DEFAULT_USER_PREFERENCES.roles);
    expect(activeCount(d, true)).toBe(0);
  });
});
