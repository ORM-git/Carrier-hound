import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

describe("jobs page saved preselection is display only", () => {
  it("passes savedDisplay to the filter bar and nowhere else", () => {
    const lines = src.split("\n").filter((l) => l.includes("savedDisplay"));
    // memo definition + its null return + prop only: never in filterValues, query params or the drawer
    for (const l of lines) {
      expect(l).toMatch(/const savedDisplay = useMemo|savedDisplay=\{savedDisplay\}|Onboarding choices|savedControlDisplay\(|display only/);
    }
    expect(src).toContain("savedDisplay={savedDisplay}");
  });
  it("wires the persistent note to bar and drawer, with edit opening Preferences", () => {
    expect(src).toContain('<SavedPrioritiesNote where="bar"');
    expect(src).toMatch(/savedPriorities=\{[\s\S]{0,200}setPreferencesOpen\(true\)/);
  });
  it("dismisses saved display on patch, reset and apply-all", () => {
    expect(src).toMatch(/handleFilterChange[\s\S]{0,120}dismissSaved\(/);
    expect(src).toMatch(/handleResetFilters = \(\) => \{\s*dismissSaved\(SAVED_CONTROL_KEYS\)/);
    expect(src).toMatch(/handleApplyAllFilters[\s\S]{0,120}dismissSaved\(SAVED_CONTROL_KEYS\)/);
  });
});
