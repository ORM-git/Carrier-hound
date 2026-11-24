import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { parseWorkAuth, toggleWorkAuth } from "@/lib/onboarding/workAuth";

// CM mobile item 8: Settings edits work authorization through the canonical toggle, never free text,
// so a value saved from Settings is always one the onboarding API accepts.
const settings = readFileSync("src/app/settings/page.tsx", "utf8");

describe("settings work authorization (item 8)", () => {
  it("uses the canonical toggle instead of a free-text input", () => {
    expect(settings).toContain("toggleWorkAuth(workAuth");
    expect(settings).not.toContain('aria-label="Work Authorization"');
  });

  it("settings toggles produce 1, 2, 3 and 2+3 values that the API parser accepts", () => {
    const one = toggleWorkAuth("", "authorized");
    const two = toggleWorkAuth(one, "requires_sponsorship"); // 2 clears 1
    const twoThree = toggleWorkAuth(two, "other");
    const three = toggleWorkAuth(twoThree, "requires_sponsorship");
    expect(parseWorkAuth(one)).toEqual(["authorized"]);
    expect(parseWorkAuth(two)).toEqual(["requires_sponsorship"]);
    expect(parseWorkAuth(twoThree)).toEqual(["requires_sponsorship", "other"]);
    expect(parseWorkAuth(three)).toEqual(["other"]);
    // A legacy saved value is shown as selected and re-saved unchanged unless toggled.
    expect(parseWorkAuth("Requires visa sponsorship (e.g. H1B) + Other / Work Permit")).toEqual(["requires_sponsorship", "other"]);
  });
});
