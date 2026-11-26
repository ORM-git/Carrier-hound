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
  it("is a labelled dialog with a top count, compact summaries and +N overflow", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    // roles, work model, country
    expect(within(dialog).getByLabelText("3 active preferences")).toBeTruthy();
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

  it("a multi work-model choice is saved in full but not counted, and says why", async () => {
    const { onSave } = setup();
    expect(screen.getByLabelText("3 active preferences")).toBeTruthy();
    openGroup("Basic");
    fireEvent.click(screen.getByRole("checkbox", { name: "Hybrid" }));
    expect(screen.getByLabelText("2 active preferences")).toBeTruthy();
    expect(screen.getByText(/isn.t counted as active/)).toBeTruthy();
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
    expect(screen.getByLabelText("3 active preferences")).toBeTruthy();
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
    expect(screen.getByLabelText("3 active preferences")).toBeTruthy();
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
  it("constraints unavailable: no excluded or posted chips, and the chip row is keyboard focusable", () => {
    setup({ ...over, feedConstraintsAvailable: false });
    expect(chipTexts("excluded")).toEqual([]);
    expect(chipTexts("posted")).toEqual([]);
    expect(screen.getByTestId("preferences-chips").getAttribute("tabindex")).toBe("0");
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
});
