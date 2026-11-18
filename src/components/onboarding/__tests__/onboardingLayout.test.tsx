// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OnboardingStep1 from "../OnboardingStep1";
import OnboardingStep2 from "../OnboardingStep2";

vi.mock("@/config/onboarding", () => ({ isOnboardingStep2EnabledClient: () => true }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn() } }));

afterEach(cleanup);

const step1Props = {
  roles: [],
  onToggleRole: () => {},
  onRemoveRole: () => {},
  employmentTypes: [],
  onToggleEmploymentType: () => {},
  country: "",
  onSelectCountry: () => {},
  openToRemote: false,
  onToggleOpenToRemote: vi.fn(),
  workAuth: "",
  onSelectWorkAuth: () => {},
  onNext: () => {},
};

describe("OnboardingStep1 help controls", () => {
  it.each(["Info about remote preference", "Info about work authorization"])(
    "%s is a focusable button that toggles its help text",
    (label) => {
      render(<OnboardingStep1 {...step1Props} />);
      for (const btn of screen.getAllByRole("button", { name: label })) {
        expect(btn.tagName).toBe("BUTTON");
        expect(btn.getAttribute("type")).toBe("button");
        expect(btn.className).toContain("focus-visible:ring-2");
        btn.focus();
        expect(document.activeElement).toBe(btn);
      }
      const [btn] = screen.getAllByRole("button", { name: label });
      expect(btn.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(btn);
      expect(btn.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById(btn.getAttribute("aria-controls")!)).not.toBeNull();
    },
  );

  it("help click does not toggle Open to Remote", () => {
    const onToggle = vi.fn();
    render(<OnboardingStep1 {...step1Props} onToggleOpenToRemote={onToggle} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Info about remote preference" })[0]);
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open to Remote" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("OnboardingStep2 card text", () => {
  it("does not truncate card titles or descriptions", () => {
    render(<OnboardingStep2 onBack={() => {}} onFinish={() => {}} isSaving={false} authToken="t" />);
    for (const id of ["linkedin-card-title", "resume-card-title"]) {
      const title = document.getElementById(id)!;
      const desc = title.nextElementSibling!;
      expect(title.className).not.toContain("truncate");
      expect(desc.className).not.toContain("truncate");
    }
    expect(screen.getByText("e.g. https://www.linkedin.com/in/yourname")).toBeTruthy();
  });
});
