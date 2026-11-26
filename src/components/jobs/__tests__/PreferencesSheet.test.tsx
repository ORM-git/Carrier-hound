// @vitest-environment jsdom
// The real PreferencesSheet with the real model/serializer. onSave receives the exact UserPreferences
// that saveUserPreferences would persist (its storage round trip is covered in userPreferencesConstraints).
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import PreferencesSheet from "../PreferencesSheet";
import { emptyUserPreferences, type UserPreferences } from "@/lib/auth/types";

afterEach(cleanup);

const committed = (over: Partial<UserPreferences> = {}): UserPreferences => ({
  ...emptyUserPreferences(),
  roles: ["Frontend Developer", "Backend Engineer", "My Custom Role"],
  workModels: ["remote"],
  remotePreference: "remote",
  countryCode: "IN",
  country: "India",
  dailyDigestOptIn: true,
  onboardingCompleted: true,
  eligibilityFilter: false,
  feedConstraintsAvailable: true,
  excludedTitles: [],
  includedCompanies: [],
  excludedCompanies: [],
  datePosted: null,
  ...over,
});

function setup(over: Partial<UserPreferences> = {}, onSave = vi.fn(async () => {})) {
  const onClose = vi.fn();
  const prefs = committed(over);
  const utils = render(<PreferencesSheet isOpen ownerId="user-a" onClose={onClose} committed={prefs} onSave={onSave} />);
  return { ...utils, onClose, onSave, prefs };
}
const openGroup = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
const update = () => fireEvent.click(screen.getByRole("button", { name: /^(Update|Saving…)$/ }));
const lastSaved = (onSave: any): UserPreferences => onSave.mock.calls.at(-1)[0];

describe("PreferencesSheet", () => {

  it("per-field Clear resets job type, work model and date posted only, and Update saves it", () => {
    const { onSave } = setup({ employmentTypes: ["full-time"] as any, workModels: ["remote"], datePosted: "7d" });
    openGroup("Basic");
    for (const n of ["Job type", "Work model", "Date posted"]) expect(screen.getByRole("group", { name: n })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Clear date posted" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear date posted" }));
    expect(screen.queryByRole("button", { name: "Clear date posted" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear work model" }));
    expect(screen.queryByRole("button", { name: "Clear work model" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear job type" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear job type" }));
    update();
    const saved = lastSaved(onSave);
    expect(saved.datePosted).toBeNull();
    expect(saved.workModels).toEqual([]);
    expect(saved.employmentTypes).toEqual([]);
    expect(saved.roles).toContain("Frontend Developer");
  });
  it("experience level is a six-way multi-select; all six saves as no filter, Clear empties it", async () => {
    const { onSave } = setup({ experienceLevel: "senior" });
    openGroup("Basic");
    const boxes = () => screen.getAllByRole("checkbox").filter((b) => ["Intern / New Grad", "Entry Level", "Mid Level", "Senior Level", "Staff / Principal / Lead", "Director / Executive"].includes((b.closest("label")?.textContent || "").trim()));
    expect(boxes()).toHaveLength(6);
    expect((screen.getByRole("checkbox", { name: "Senior Level" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Director / Executive" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Entry Level" }));
    await act(async () => update());
    expect(lastSaved(onSave).experienceLevel).toBe("entry,senior,director");
    for (const n of ["Intern / New Grad", "Mid Level", "Staff / Principal / Lead"]) fireEvent.click(screen.getByRole("checkbox", { name: n }));
    await act(async () => update());
    expect(lastSaved(onSave).experienceLevel).toBe("intern,entry,mid,senior,lead,director");
    fireEvent.click(screen.getByRole("button", { name: "Clear level" }));
    expect(boxes().every((b) => !(b as HTMLInputElement).checked)).toBe(true);
    await act(async () => update());
    expect(lastSaved(onSave).experienceLevel).toBeUndefined();
  });
  it("years range is only enabled when advanced storage exists, saves max unbounded as null, and Clear all resets it", async () => {
    const off = setup();
    openGroup("Basic");
    expect(screen.queryByLabelText("Maximum years of experience")).toBeNull();
    expect(screen.getAllByText("This control isn't enabled yet.").length).toBeGreaterThan(0);
    cleanup();
    const keep = setup({ advancedPreferencesAvailable: true, requiredYearsMin: 2.5, requiredYearsMax: 15 } as any);
    openGroup("Basic");
    expect(screen.getByTestId("years-summary").textContent).toBe("2.5 to 15 years");
    await act(async () => update());
    expect([lastSaved(keep.onSave).requiredYearsMin, lastSaved(keep.onSave).requiredYearsMax]).toEqual([2.5, 15]);
    cleanup();
    const { onSave } = setup({ advancedPreferencesAvailable: true, requiredYearsMin: 2, requiredYearsMax: 4 } as any);
    openGroup("Basic");
    expect(screen.getByTestId("years-summary").textContent).toBe("2 to 4 years");
    fireEvent.change(screen.getByLabelText("Maximum years of experience"), { target: { value: "11" } });
    expect(screen.getByTestId("years-summary").textContent).toBe("2+ years");
    await act(async () => update());
    expect([lastSaved(onSave).requiredYearsMin, lastSaved(onSave).requiredYearsMax]).toEqual([2, null]);
    fireEvent.click(screen.getByRole("button", { name: "Clear years of experience" }));
    expect(screen.getByTestId("years-summary").textContent).toBe("Any");
    expect(screen.queryByRole("button", { name: "Clear years of experience" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Maximum years of experience"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByTestId("years-summary").textContent).toBe("Any");
    void off;
  });
  it("skills inputs need advanced storage, are tagged not-applied until the server says so, and Clear works", async () => {
    setup();
    openGroup("Interests");
    expect(screen.queryByLabelText("Excluded skills")).toBeNull();
    cleanup();
    const { onSave } = setup({ advancedPreferencesAvailable: true } as any);
    openGroup("Interests");
    for (const [label, v] of [["Excluded skills", "PHP"], ["Preferred skills", "React"]]) {
      const box = screen.getByLabelText(label);
      fireEvent.change(box, { target: { value: v } });
      fireEvent.keyDown(box, { key: "Enter" });
    }
    expect(screen.getByText(/Saved, but not applied to your feed yet\. Jobs with no skill data stay in\./)).toBeTruthy();
    expect(screen.getByText(/Saved, but not used to rank your feed yet/)).toBeTruthy();
    await act(async () => update());
    expect(lastSaved(onSave).excludedSkills).toEqual(["PHP"]);
    expect(lastSaved(onSave).preferredSkills).toEqual(["React"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear excluded skills" }));
    expect(screen.queryByRole("button", { name: "Clear excluded skills" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear preferred skills" })).toBeTruthy();
  });
  it("excluded skills lose the not-applied note when the server advertises the filter; a skill in both lists blocks Update", async () => {
    const onSave = vi.fn(async () => {});
    render(<PreferencesSheet isOpen ownerId="user-a" onClose={vi.fn()} committed={committed({ advancedPreferencesAvailable: true, preferredSkills: ["Go"], excludedSkills: ["go"] } as any)} onSave={onSave} capabilities={{ excludedSkillsFilter: true, preferredSkillsRanking: false }} />);
    openGroup("Interests");
    expect(screen.queryByText(/Saved, but not applied to your feed yet\. Jobs with no skill data/)).toBeNull();
    expect(screen.getByText(/Hides jobs that list one of these skills\. Jobs with no skill data stay in\./)).toBeTruthy();
    update();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert").some((a) => /can't be both preferred and excluded/.test(a.textContent || ""))).toBe(true);
  });
  describe("capabilities fetch", () => {
    const skillsOn = { advancedPreferencesAvailable: true } as any;
    const applied = () => !screen.queryByText(/Saved, but not applied to your feed yet\. Jobs with no skill data/);
    const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    afterEach(() => vi.unstubAllGlobals());
    it("a failed or non-ok fetch leaves excluded skills not applied", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
      render(<PreferencesSheet isOpen ownerId="user-a" onClose={vi.fn()} committed={committed(skillsOn)} onSave={vi.fn(async () => {})} />);
      await flush();
      openGroup("Interests");
      expect(applied()).toBe(false);
      cleanup();
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ excludedSkillsFilter: true }) })));
      render(<PreferencesSheet isOpen ownerId="user-a" onClose={vi.fn()} committed={committed(skillsOn)} onSave={vi.fn(async () => {})} />);
      await flush();
      openGroup("Interests");
      expect(applied()).toBe(false);
    });
    it("a ready answer applies only the advertised capability, and reopening does not reuse it", async () => {
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ excludedSkillsFilter: true, preferredSkillsRanking: false }) }));
      vi.stubGlobal("fetch", fetchMock);
      const props = { ownerId: "user-a", onClose: vi.fn(), committed: committed(skillsOn), onSave: vi.fn(async () => {}) };
      const { rerender } = render(<PreferencesSheet isOpen {...props} />);
      await flush();
      openGroup("Interests");
      expect(applied()).toBe(true);
      expect(screen.getByText(/Saved, but not used to rank your feed yet/)).toBeTruthy();
      rerender(<PreferencesSheet isOpen={false} {...props} />);
      fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ excludedSkillsFilter: false, preferredSkillsRanking: false }) }));
      rerender(<PreferencesSheet isOpen {...props} />);
      await flush();
      openGroup("Interests");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(applied()).toBe(false);
    });
    it("a response that arrives after unmount does not throw or set state", async () => {
      let resolve: (v: any) => void = () => {};
      vi.stubGlobal("fetch", vi.fn(() => new Promise((r) => { resolve = r; })));
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const { unmount } = render(<PreferencesSheet isOpen ownerId="user-a" onClose={vi.fn()} committed={committed(skillsOn)} onSave={vi.fn(async () => {})} />);
      unmount();
      await act(async () => { resolve({ ok: true, json: async () => ({ excludedSkillsFilter: true }) }); await new Promise((r) => setTimeout(r, 0)); });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });
  });
  it("skills inputs use the ASCII-only skill key: A-Z dedupe, a and umlaut stay distinct, NBSP variants stay distinct", async () => {
    const { onSave } = setup({ advancedPreferencesAvailable: true } as any);
    openGroup("Interests");
    const box = screen.getByLabelText("Preferred skills");
    for (const v of ["React", " react ", "Ä", "ä", "C\u00a0sharp", "C sharp"]) {
      fireEvent.change(box, { target: { value: v } });
      fireEvent.keyDown(box, { key: "Enter" });
    }
    await act(async () => update());
    expect(lastSaved(onSave).preferredSkills).toEqual(["React", "Ä", "ä", "C\u00a0sharp", "C sharp"]);
  });
  it("capabilities: true, then reopen with a rejected or late answer, then a prop switch, never keeps ready", async () => {
    const skillsOn = { advancedPreferencesAvailable: true } as any;
    const ready = () => !screen.queryByText(/Saved, but not applied to your feed yet\. Jobs with no skill data/);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => (++calls === 1 ? Promise.resolve({ ok: true, json: async () => ({ excludedSkillsFilter: true, preferredSkillsRanking: false }) }) : Promise.reject(new Error("x")))));
    const props = { ownerId: "user-a", onClose: vi.fn(), committed: committed(skillsOn), onSave: vi.fn(async () => {}) };
    const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const { rerender } = render(<PreferencesSheet isOpen {...props} />);
    await flush();
    openGroup("Interests");
    expect(ready()).toBe(true);
    rerender(<PreferencesSheet isOpen={false} {...props} />);
    rerender(<PreferencesSheet isOpen {...props} />);
    await flush();
    openGroup("Interests");
    expect(ready()).toBe(false);
    rerender(<PreferencesSheet isOpen {...props} capabilities={{ excludedSkillsFilter: true }} />);
    await flush();
    expect(ready()).toBe(true);
    rerender(<PreferencesSheet isOpen {...props} capabilities={{ excludedSkillsFilter: false }} />);
    expect(ready()).toBe(false);
    vi.unstubAllGlobals();
  });
  it("preferred skills copy follows global readiness AND the account plan", () => {
    const base = { ownerId: "user-a", onClose: vi.fn(), committed: committed({ advancedPreferencesAvailable: true, preferredSkills: ["React"] } as any), onSave: vi.fn(async () => {}) };
    const on = { excludedSkillsFilter: true, preferredSkillsRanking: true };
    const cases: Array<[any, any, RegExp, boolean]> = [
      [{ preferredSkillsRanking: false }, "pro", /Saved, but not used to rank your feed yet/, false],
      [on, "pro", /Used to order your recommended jobs\. Search sorting is not ranked by skills\./, true],
      [on, "free", /Preferred skills reorder recommendations for Pro accounts only/, false],
      [on, "unknown", /Your plan is still loading/, false],
      [on, undefined, /Your plan is still loading/, false],
    ];
    for (const [caps, plan, re, applied] of cases) {
      const { unmount } = render(<PreferencesSheet isOpen {...base} capabilities={caps} accountPlan={plan} />);
      openGroup("Interests");
      expect(screen.getByText(re)).toBeTruthy();
      expect(!!screen.queryAllByText(/Skill: React \(saved, not applied\)/).length || !!screen.queryByText(/Preferred skills \(saved, not applied\)/)).toBe(!applied);
      unmount();
    }
  });
  it("is a labelled dialog with a top count, compact summaries and +N overflow", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    // 3 roles + 1 work model + country: every selected value, same as the chips
    expect(within(dialog).getByLabelText("5 active preferences")).toBeTruthy();
    expect(chipTexts("function")).toEqual(["Frontend Developer", "Backend Engineer", "My Custom Role"]);
    expect(chipTexts("work-model")).toEqual(["Remote"]);
    expect(chipTexts("location")).toEqual(["India"]);
  });

  it("nested job-function picker: search, select, back keeps the draft, remove chip", () => {
    const { onSave } = setup();
    openGroup("Basic");
    fireEvent.click(screen.getByRole("button", { name: /Choose job functions|Add job function/ }));
    fireEvent.change(screen.getByLabelText("Search job functions"), { target: { value: "data eng" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Data Engineer" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByLabelText("Search job functions")).toBeNull();
    expect(screen.getByTestId("job-function-chips").querySelectorAll("button").length).toBe(4); // all 4 roles as chips, none collapsed
    fireEvent.click(screen.getByRole("button", { name: /Choose job functions|Add job function/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Backend Engineer" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    update();
    const saved = lastSaved(onSave);
    expect(saved.roles).toEqual(["Frontend Developer", "My Custom Role", "Data Engineer"]);
    expect(saved.categories).toEqual(["engineering", "data"]); // custom role adds no invented category
  });

  it("custom role from search, excluded titles de-duplicated, multi work model and job types", async () => {
    const { onSave } = setup();
    openGroup("Basic");
    fireEvent.click(screen.getByRole("button", { name: /Choose job functions|Add job function/ }));
    fireEvent.change(screen.getByLabelText("Search job functions"), { target: { value: "Prompt Whisperer" } });
    fireEvent.click(screen.getByRole("button", { name: /Add “Prompt Whisperer” as a custom role/ }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    const titles = screen.getByLabelText("Exclude job titles");
    for (const v of ["Sales", " sales ", "Intern"]) {
      fireEvent.change(titles, { target: { value: v } });
      fireEvent.keyDown(titles, { key: "Enter" });
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "Hybrid" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Contract" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Internship" }));
    fireEvent.click(screen.getByRole("radio", { name: "Past 3 days" }));
    await act(async () => update());
    const saved = lastSaved(onSave);
    expect(saved.roles).toContain("Prompt Whisperer");
    expect(saved.excludedTitles).toEqual(["Sales", "Intern"]);
    expect(saved.workModels).toEqual(["hybrid", "remote"]);
    expect(saved.remotePreference).toBe("any");
    expect(saved.employmentTypes).toEqual(["contract", "internship"]);
    expect(saved.datePosted).toBe("3d");
    // unrelated flags carried over
    expect(saved.dailyDigestOptIn).toBe(true);
    expect(saved.eligibilityFilter).toBe(false);
    expect(saved.onboardingCompleted).toBe(true);
  });

  it("salary slider and number stay in sync; a minimum without a currency blocks Update", async () => {
    const { onSave } = setup();
    openGroup("Compensation");
    const amount = screen.getByLabelText("Minimum annual salary amount") as HTMLInputElement;
    const slider = screen.getByRole("slider") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "120000" } });
    expect(slider.value).toBe("120000");
    fireEvent.change(slider, { target: { value: "150000" } });
    expect(amount.value).toBe("150000");
    expect(slider.getAttribute("aria-valuetext")).toBe("150000 per year");
    update();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Choose the currency for your minimum salary.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "INR" } });
    expect(slider.getAttribute("aria-valuetext")).toMatch(/₹.*per year/);
    await act(async () => update());
    expect(lastSaved(onSave)).toMatchObject({ minSalary: 150000, salaryCurrency: "INR" });
  });

  it("clearing the amount is 'no minimum', not zero", async () => {
    const { onSave } = setup({ minSalary: 90000, salaryCurrency: "USD" });
    openGroup("Compensation");
    fireEvent.change(screen.getByLabelText("Minimum annual salary amount"), { target: { value: "" } });
    await act(async () => update());
    expect(lastSaved(onSave).minSalary).toBeUndefined();
  });

  it("work authorization keeps the canonical 1 / 2 / 3 / 2+3 contract; H-1B wording only for the US", async () => {
    const { onSave } = setup();
    openGroup("Compensation");
    expect(screen.queryByText(/H-1B/)).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "I need visa sponsorship." }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I have another work permit or authorization." }));
    await act(async () => update());
    expect(lastSaved(onSave).workAuth).toBe("I need visa sponsorship. + I have another work permit or authorization.");
    cleanup();
    setup({ countryCode: "US", country: "United States" });
    openGroup("Compensation");
    expect(screen.getByRole("checkbox", { name: "I need visa sponsorship (e.g. H-1B)." })).toBeTruthy();
  });

  it("a multi work-model choice is saved in full and each choice counts, with the ranking note", async () => {
    const { onSave } = setup();
    expect(screen.getByLabelText("5 active preferences")).toBeTruthy();
    openGroup("Basic");
    fireEvent.click(screen.getByRole("checkbox", { name: "Hybrid" }));
    expect(screen.getByLabelText("6 active preferences")).toBeTruthy();
    expect(screen.getByText(/several rank as open to any setup/)).toBeTruthy();
    await act(async () => update());
    expect(lastSaved(onSave).workModels).toEqual(["hybrid", "remote"]);
    expect(lastSaved(onSave).remotePreference).toBe("any");
  });

  it("saved title/company/date constraints are labelled not applied and never counted (owner decision pending)", () => {
    setup();
    openGroup("Company");
    const never = screen.getByLabelText("Never show these companies");
    fireEvent.change(never, { target: { value: "Globex" } });
    fireEvent.keyDown(never, { key: "Enter" });
    expect(screen.getByLabelText("5 active preferences")).toBeTruthy();
    expect(screen.getAllByText(/Saved, but not applied to your feed yet/).length).toBeGreaterThan(0);
  });

  it("an include/exclude conflict blocks Update with a clear message", () => {
    const { onSave } = setup();
    openGroup("Company");
    const only = screen.getByLabelText("Only show these companies");
    fireEvent.change(only, { target: { value: "Acme" } });
    fireEvent.keyDown(only, { key: "Enter" });
    const never = screen.getByLabelText("Never show these companies");
    fireEvent.change(never, { target: { value: "acme" } });
    fireEvent.keyDown(never, { key: "Enter" });
    expect(screen.getByRole("status").textContent).toMatch(/Acme is in both lists/);
    update();
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Remove Acme from one of the company lists/).length).toBeGreaterThan(0);
  });

  it("an account switch while the sheet is open discards the draft and never saves it for the new account", () => {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    const a = committed({ roles: ["Account A Role"] });
    const b = committed({ roles: ["Account B Role"], countryCode: "US", country: "United States" });
    const { rerender } = render(<PreferencesSheet isOpen ownerId="user-a" onClose={onClose} committed={a} onSave={onSave} />);
    openGroup("Basic");
    fireEvent.click(screen.getByRole("checkbox", { name: "Onsite" }));
    rerender(<PreferencesSheet isOpen ownerId="user-b" onClose={onClose} committed={b} onSave={onSave} />);
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    rerender(<PreferencesSheet isOpen={false} ownerId="user-b" onClose={onClose} committed={b} onSave={onSave} />);
    rerender(<PreferencesSheet isOpen ownerId="user-b" onClose={onClose} committed={b} onSave={onSave} />);
    // reopened for B: B's committed values, none of A's draft
    expect(screen.getByRole("dialog").textContent).toContain("Account B Role");
    expect(screen.getByRole("dialog").textContent).not.toContain("Account A Role");
    openGroup("Basic");
    expect((screen.getByRole("checkbox", { name: "Onsite" }) as HTMLInputElement).checked).toBe(false);
  });

  it("unavailable controls are visible, labelled and never counted or saved", async () => {
    const { onSave } = setup({ feedConstraintsAvailable: false });
    openGroup("Interests");
    expect(screen.getByText("Industries to include / exclude")).toBeTruthy();
    expect(screen.getByText("Skills")).toBeTruthy();
    openGroup("Company");
    expect(screen.queryByLabelText("Only show these companies")).toBeNull(); // shown as pending, not an input
    expect(screen.getByText("Company stage (Early, Growth, Late, Public)")).toBeTruthy();
    openGroup("Basic");
    expect(screen.getByText("Search radius")).toBeTruthy();
    // without storage, work model is single-select
    fireEvent.click(screen.getByRole("checkbox", { name: "Hybrid" }));
    expect((screen.getByRole("checkbox", { name: "Remote" }) as HTMLInputElement).checked).toBe(false);
    await act(async () => update());
    const saved = lastSaved(onSave);
    expect(saved.workModels).toEqual(["hybrid"]);
    expect(saved.excludedTitles).toEqual([]); // the committed value, never the (uneditable) draft
    expect(saved.feedConstraintsAvailable).toBe(false); // so saveUserPreferences writes no constraint column
  });

  it("Escape cancels the draft without saving; reopening hydrates the committed values", () => {
    const onSave = vi.fn(async () => {});
    const onClose = vi.fn();
    const prefs = committed();
    const { rerender } = render(<PreferencesSheet isOpen ownerId="user-a" onClose={onClose} committed={prefs} onSave={onSave} />);
    openGroup("Basic");
    fireEvent.click(screen.getByRole("checkbox", { name: "Onsite" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByLabelText("1 active preference")).toBeTruthy(); // country is a profile fact kept by Clear all
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    rerender(<PreferencesSheet isOpen={false} ownerId="user-a" onClose={onClose} committed={prefs} onSave={onSave} />);
    rerender(<PreferencesSheet isOpen ownerId="user-a" onClose={onClose} committed={prefs} onSave={onSave} />);
    expect(screen.getByLabelText("5 active preferences")).toBeTruthy();
  });

  it("one save while pending (no double submit); close is blocked until it settles", async () => {
    let resolve!: () => void;
    const onSave = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const { onClose } = setup({}, onSave);
    update();
    update();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a failed save keeps the sheet open with the draft and a retryable error", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const { onClose } = setup({}, onSave);
    openGroup("Basic");
    fireEvent.click(screen.getByRole("checkbox", { name: "Onsite" }));
    screen.getByTestId("preferences-scroll-body").scrollTop = 21;
    await act(async () => update());
    expect(screen.getByRole("alert").textContent).toMatch(/not saved/);
    expect(screen.getByTestId("preferences-scroll-body").style.overflowAnchor).toBe("none");
    expect(screen.getByTestId("preferences-scroll-body").scrollTop).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("checkbox", { name: "Onsite" }) as HTMLInputElement).checked).toBe(true);
    await act(async () => update());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(lastSaved(onSave).workModels).toEqual(["onsite", "remote"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});


describe("Preferences focus lifecycle", () => {
  it("focuses committed picker nodes synchronously and never schedules stale focus", () => {
    setup();
    openGroup("Basic");
    fireEvent.click(screen.getByRole("button", { name: /Choose job functions|Add job function/ }));
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search job functions" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Choose job functions|Add job function/ }));
    fireEvent.click(document.activeElement!);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Choose job functions|Add job function/ }));
  });
});

// The collapsed Basic summary's "Location:" line (country first, then saved locations), display only.
const chipTexts = (kind: string) =>
  Array.from(screen.getByRole("dialog", { name: "Preferences" }).querySelectorAll(`[data-testid="preferences-chips"] [data-chip="${kind}"]`)).map((c) => c.textContent || "");
const locationLine = () => "Location: " + chipTexts("location").join(", ");

describe("PreferencesSheet Clear on salary and company lists", () => {
  it("clears minimum salary only, and each company list separately, then Update saves it", () => {
    const { onSave } = setup({ minSalary: 90000, salaryCurrency: "USD", includedCompanies: ["Acme"], excludedCompanies: ["Globex"] });
    openGroup("Compensation");
    fireEvent.click(screen.getByRole("button", { name: "Clear minimum salary" }));
    expect(screen.queryByRole("button", { name: "Clear minimum salary" })).toBeNull();
    openGroup("Company");
    fireEvent.click(screen.getByRole("button", { name: "Clear never-show companies" }));
    expect(screen.queryByRole("button", { name: "Clear never-show companies" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear only-show companies" })).toBeTruthy();
    update();
    const saved = lastSaved(onSave);
    expect(saved.minSalary).toBeUndefined(); // serializer omits a cleared minimum, as the existing salary test asserts
    expect(saved.excludedCompanies).toEqual([]);
    expect(saved.includedCompanies).toEqual(["Acme"]);
    expect(saved.salaryCurrency).toBe("USD");
  });
});

describe("PreferencesSheet chips are truthful about saved-but-not-applied constraints", () => {
  const over = { excludedTitles: ["Intern"], datePosted: "7d" as const };
  it("flag off: excluded and posted chips say saved, not applied", () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "false");
    setup(over);
    expect(chipTexts("excluded")).toEqual(["Not: Intern (saved, not applied)"]);
    expect(chipTexts("posted")).toEqual(["Past week (saved, not applied)"]);
    vi.unstubAllEnvs();
  });
  it("flag on: the same chips carry no not-applied tag", () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
    setup(over);
    expect(chipTexts("excluded")).toEqual(["Not: Intern"]);
    expect(chipTexts("posted")).toEqual(["Past week"]);
    vi.unstubAllEnvs();
  });
  it("constraints unavailable: no excluded or posted chips, and the chip row wraps instead of scrolling", () => {
    setup({ ...over, feedConstraintsAvailable: false });
    expect(chipTexts("excluded")).toEqual([]);
    expect(chipTexts("posted")).toEqual([]);
    expect(screen.getByTestId("preferences-chips").className).toContain("flex-wrap");
    expect(screen.getByTestId("preferences-chips").className).not.toContain("overflow-x-auto");
  });
  it("shows the first six selections then +N, and the +N button reveals the rest", () => {
    setup({ roles: ["A1","A2","A3","A4","A5","A6","A7","A8"], workModels: [], remotePreference: "any", countryCode: "", country: "" });
    expect(screen.getByTestId("preferences-chips").querySelectorAll("[role=listitem]").length).toBe(6);
    fireEvent.click(screen.getByRole("button", { name: "+2" }));
    expect(screen.getByTestId("preferences-chips").querySelectorAll("[role=listitem]").length).toBe(8);
    fireEvent.click(screen.getByRole("button", { name: "Less" }));
    expect(screen.getByTestId("preferences-chips").querySelectorAll("[role=listitem]").length).toBe(6);
  });
});

describe("PreferencesSheet Location summary de-duplication (display only)", () => {
  it("country plus an identical location shows once", () => {
    setup({ countryCode: "US", country: "United States", locations: ["United States"] });
    expect(locationLine()).toBe("Location: United States");
  });
  it("casing and spacing variants show once, keeping the first spelling", () => {
    setup({ countryCode: "US", country: "United States", locations: ["  united   states ", "UNITED STATES"] });
    expect(locationLine()).toBe("Location: United States");
  });
  it("country plus a city shows both, in order", () => {
    setup({ countryCode: "US", country: "United States", locations: ["Austin, TX"] });
    expect(locationLine()).toBe("Location: United States, Austin, TX");
  });
  it("locations without a country still show (empty entries dropped, duplicates once)", () => {
    setup({ countryCode: "", country: "", locations: ["Berlin", " ", "berlin", "Munich"] });
    expect(locationLine()).toBe("Location: Berlin, Munich");
  });
  it("Update sends the original location data unchanged", async () => {
    const { onSave } = setup({ countryCode: "US", country: "United States", locations: ["United States", "Austin, TX"] });
    expect(locationLine()).toBe("Location: United States, Austin, TX");
    await act(async () => update());
    const saved = lastSaved(onSave);
    expect(saved.locations).toEqual(["United States", "Austin, TX"]);
    expect(saved.countryCode).toBe("US");
  });
});

describe("Job function selected chips", () => {
  it("shows every selected role as a removable chip plus Add, no collapsed summary", () => {
    const { onSave } = setup({ roles: ["Growth Marketer", "Performance Marketer", "Copywriter"] });
    openGroup("Basic");
    const chips = screen.getByTestId("job-function-chips");
    for (const r of ["Growth Marketer", "Performance Marketer", "Copywriter"]) expect(chips.textContent).toContain(r);
    expect(screen.queryByText(/\+\d+$/, { selector: "span.truncate" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove Performance Marketer" }));
    expect(screen.getByTestId("job-function-chips").textContent).not.toContain("Performance Marketer");
    update();
    expect(lastSaved(onSave).roles).toEqual(["Growth Marketer", "Copywriter"]);
  });
  it("Add opens the existing picker and a picked role joins the chips", () => {
    setup({ roles: ["Copywriter"] });
    openGroup("Basic");
    fireEvent.click(screen.getByRole("button", { name: "Add job function" }));
    fireEvent.change(screen.getByLabelText("Search job functions"), { target: { value: "data eng" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Data Engineer" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("job-function-chips").textContent).toContain("Data Engineer");
    expect(screen.getByTestId("job-function-chips").textContent).toContain("Copywriter");
  });
  it("with no roles the control still reads Choose job functions", () => {
    setup({ roles: [] });
    openGroup("Basic");
    expect(screen.queryByTestId("job-function-chips")).toBeNull();
    expect(screen.getByRole("button", { name: "Choose job functions" })).toBeTruthy();
  });
  it("counter counts every selected value like the chip strip (8 roles = 8, group badge agrees)", () => {
    setup({ roles: ["A1","A2","A3","A4","A5","A6","A7","A8"], workModels: [], remotePreference: "any", countryCode: "", country: "" });
    expect(screen.getByLabelText("8 active preferences")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Basic/ }).textContent).toMatch(/8/);
  });
  it("multi-level selected chips and the Basic/top counters agree; all six count zero", () => {
    const first=setup({roles:[],employmentTypes:[],workModels:[],remotePreference:"any",countryCode:"",country:"",experienceLevel:"entry,senior"});
    expect(screen.getByLabelText("2 active preferences")).toBeTruthy();
    expect(screen.getByRole("button",{name:/^Basic/}).textContent).toMatch(/2/);
    first.unmount();
    setup({roles:[],employmentTypes:[],workModels:[],remotePreference:"any",countryCode:"",country:"",experienceLevel:"intern,entry,mid,senior,lead,director"});
    expect(screen.queryByLabelText(/active preferences/)).toBeNull();
  });

});
