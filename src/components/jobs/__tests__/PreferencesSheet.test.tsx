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
  const utils = render(<PreferencesSheet isOpen onClose={onClose} committed={prefs} onSave={onSave} />);
  return { ...utils, onClose, onSave, prefs };
}
const openGroup = (name: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
const update = () => fireEvent.click(screen.getByRole("button", { name: /^(Update|Saving…)$/ }));
const lastSaved = (onSave: any): UserPreferences => onSave.mock.calls.at(-1)[0];

describe("PreferencesSheet", () => {
  it("is a labelled dialog with a top count, compact summaries and +N overflow", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Preferences" });
    // roles, work model, country
    expect(within(dialog).getByLabelText("3 active preferences")).toBeTruthy();
    expect(dialog.textContent).toContain("Frontend Developer, Backend Engineer");
    expect(within(dialog).getAllByText("+1").length).toBeGreaterThan(0);
  });

  it("nested job-function picker: search, select, back keeps the draft, remove chip", () => {
    const { onSave } = setup();
    openGroup("Basic");
    fireEvent.click(screen.getByRole("button", { name: /Frontend Developer, Backend Engineer/ }));
    fireEvent.change(screen.getByLabelText("Search job functions"), { target: { value: "data eng" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Data Engineer" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByLabelText("Search job functions")).toBeNull();
    expect(screen.getByRole("button", { name: /\+2/ })).toBeTruthy(); // 4 roles: 2 shown +2
    fireEvent.click(screen.getByRole("button", { name: /Frontend Developer, Backend Engineer/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Frontend Developer, Backend Engineer/ }));
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

  it("shows an include/exclude conflict and that exclusion wins", () => {
    setup();
    openGroup("Company");
    const only = screen.getByLabelText("Only show these companies");
    fireEvent.change(only, { target: { value: "Acme" } });
    fireEvent.keyDown(only, { key: "Enter" });
    const never = screen.getByLabelText("Never show these companies");
    fireEvent.change(never, { target: { value: "acme" } });
    fireEvent.keyDown(never, { key: "Enter" });
    expect(screen.getByRole("status").textContent).toMatch(/Acme is in both lists\. Never show wins/);
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
    const { rerender } = render(<PreferencesSheet isOpen onClose={onClose} committed={prefs} onSave={onSave} />);
    openGroup("Basic");
    fireEvent.click(screen.getByRole("checkbox", { name: "Onsite" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.getByLabelText("1 active preference")).toBeTruthy(); // country is a profile fact kept by Clear all
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    rerender(<PreferencesSheet isOpen={false} onClose={onClose} committed={prefs} onSave={onSave} />);
    rerender(<PreferencesSheet isOpen onClose={onClose} committed={prefs} onSave={onSave} />);
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
    await act(async () => update());
    expect(screen.getByRole("alert").textContent).toMatch(/not saved/);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole("checkbox", { name: "Onsite" }) as HTMLInputElement).checked).toBe(true);
    await act(async () => update());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(lastSaved(onSave).workModels).toEqual(["onsite", "remote"]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
