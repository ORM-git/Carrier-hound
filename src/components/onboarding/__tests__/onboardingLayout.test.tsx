// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OnboardingStep1 from "../OnboardingStep1";
import OnboardingStep2 from "../OnboardingStep2";
import JobFunctionBottomSheet from "../JobFunctionBottomSheet";
import {
  getFirstJobsMarkerKey,
  setFirstJobsMarker,
  hasFirstJobsMarker,
  clearFirstJobsMarker,
} from "../onboardingMarkers";

let isStep2Enabled = true;
vi.mock("@/config/onboarding", () => ({
  isOnboardingStep2EnabledClient: () => isStep2Enabled,
}));
vi.mock("react-toastify", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  isStep2Enabled = true;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

describe("Two-pane JobFunctionBottomSheet: navigation, search, selection and focus return", () => {
  it("renders desktop two-pane layout, allows category navigation and role toggling", () => {
    const onToggle = vi.fn();
    render(
      <JobFunctionBottomSheet
        isOpen={true}
        onClose={() => {}}
        selectedRoles={["Frontend Developer"]}
        onToggleRole={onToggle}
      />
    );

    // Left pane has categories
    expect(screen.getByTestId("category-nav-consulting")).toBeTruthy();
    expect(screen.getByTestId("category-nav-marketing")).toBeTruthy();

    // Default category Software/Internet/AI shows roles on the right
    expect(screen.getByText("Software Engineering")).toBeTruthy();
    const roleChip = screen.getByRole("button", { name: /Backend Engineer/ });
    expect(roleChip).toBeTruthy();

    // Tapping a role triggers toggle
    fireEvent.click(roleChip);
    expect(onToggle).toHaveBeenCalledWith("Backend Engineer");

    // Switching category to Consulting updates right pane
    fireEvent.click(screen.getByTestId("category-nav-consulting"));
    expect(screen.getByText("Strategy & Management")).toBeTruthy();
  });

  it("supports mobile category drill-in and back navigation", () => {
    render(
      <JobFunctionBottomSheet
        isOpen={true}
        onClose={() => {}}
        selectedRoles={[]}
        onToggleRole={() => {}}
      />
    );

    // Click mobile Consulting category
    const mobileCat = screen.getByTestId("mobile-cat-consulting");
    fireEvent.click(mobileCat);

    // Now in drill-down view: shows subcategory and Back button
    expect(screen.getByText("Back to categories")).toBeTruthy();
    expect(screen.getByText("Strategy & Management")).toBeTruthy();

    // Clicking Back returns to category list
    fireEvent.click(screen.getByText("Back to categories"));
    expect(screen.getByTestId("mobile-cat-consulting")).toBeTruthy();
  });

  it("searches across all taxonomy groups and allows clearing", () => {
    render(
      <JobFunctionBottomSheet
        isOpen={true}
        onClose={() => {}}
        selectedRoles={[]}
        onToggleRole={() => {}}
      />
    );

    const searchInput = screen.getByLabelText("Search expected job function or role");
    fireEvent.change(searchInput, { target: { value: "Full-Stack" } });

    // Finds matching role from Software Engineering
    expect(screen.getByText("Full-Stack Developer")).toBeTruthy();

    // Clear search
    const clearBtn = screen.getByLabelText("Clear search query");
    fireEvent.click(clearBtn);
    expect((searchInput as HTMLInputElement).value).toBe("");
  });

  it("returns focus to opener element when modal closes", async () => {
    const opener = document.createElement("button");
    opener.setAttribute("id", "opener-btn");
    document.body.appendChild(opener);
    opener.focus();

    const onClose = vi.fn();
    render(
      <JobFunctionBottomSheet
        isOpen={true}
        onClose={onClose}
        selectedRoles={[]}
        onToggleRole={() => {}}
        openerElement={opener}
      />
    );

    const doneBtn = screen.getByRole("button", { name: "Done" });
    fireEvent.click(doneBtn);
    expect(onClose).toHaveBeenCalled();

    await waitFor(() => {
      expect(document.activeElement).toBe(opener);
    });
    document.body.removeChild(opener);
  });
});

describe("OnboardingStep2 flag ON/OFF behavior", () => {
  it("when flag is OFF, shows Coming soon cards, no file input, skip-only CTA", () => {
    isStep2Enabled = false;
    const onFinish = vi.fn();
    render(<OnboardingStep2 onBack={() => {}} onFinish={onFinish} isSaving={false} authToken="t" />);

    expect(screen.queryByTestId("input-resume-file")).toBeNull();
    expect(screen.queryByTestId("input-linkedin-url")).toBeNull();
    expect(screen.getAllByText("Coming soon")).toHaveLength(2);

    const finishBtn = screen.getByTestId("btn-onboarding-finish");
    expect(finishBtn.textContent).toBe("Skip for now & Continue to Jobs");
    fireEvent.click(finishBtn);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("when flag is ON, shows upload dropzone and LinkedIn URL form", () => {
    isStep2Enabled = true;
    render(<OnboardingStep2 onBack={() => {}} onFinish={() => {}} isSaving={false} authToken="t" />);

    expect(screen.getByTestId("card-resume")).toBeTruthy();
    expect(screen.getByTestId("card-linkedin")).toBeTruthy();
    expect(screen.getByTestId("resume-dropzone")).toBeTruthy();
    expect(screen.getByTestId("input-linkedin-url")).toBeTruthy();
  });
});

describe("Step 2 Skip Both and Finish", () => {
  it("allows skipping both LinkedIn and Resume and finishing", () => {
    const onFinish = vi.fn();
    render(<OnboardingStep2 onBack={() => {}} onFinish={onFinish} isSaving={false} authToken="t" />);

    // Skip LinkedIn
    const skipLi = screen.getByTestId("skip-linkedin");
    fireEvent.click(skipLi);
    expect(screen.getByText("Skipped")).toBeTruthy();

    // Skip Resume
    const skipRes = screen.getByTestId("skip-resume");
    fireEvent.click(skipRes);
    expect(screen.getAllByText("Skipped")).toHaveLength(2);

    // Finish button
    const finishBtn = screen.getByTestId("btn-onboarding-finish");
    expect(finishBtn.textContent).toBe("Skip for now & Continue to Jobs");
    fireEvent.click(finishBtn);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});

describe("Duplicate Clicks Prevention", () => {
  it("does not trigger onFinish when isSaving is true", () => {
    const onFinish = vi.fn();
    render(<OnboardingStep2 onBack={() => {}} onFinish={onFinish} isSaving={true} authToken="t" />);

    const finishBtn = screen.getByTestId("btn-onboarding-finish");
    expect(finishBtn.textContent).toBe("Saving...");
    expect((finishBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(finishBtn);
    expect(onFinish).not.toHaveBeenCalled();
  });
});

describe("First-Run Marker and Edit Mode Isolation", () => {
  const userId = "test-user-123";

  it("publishes account-scoped marker on successful first-run", () => {
    expect(hasFirstJobsMarker(userId)).toBe(false);
    setFirstJobsMarker(userId);
    expect(hasFirstJobsMarker(userId)).toBe(true);
    expect(localStorage.getItem(getFirstJobsMarkerKey(userId))).toBe("true");
    expect(sessionStorage.getItem(getFirstJobsMarkerKey(userId))).toBe("true");

    // Scoped to specific userId, does not contaminate other accounts
    expect(hasFirstJobsMarker("other-user-456")).toBe(false);

    clearFirstJobsMarker(userId);
    expect(hasFirstJobsMarker(userId)).toBe(false);
  });
});

describe("Step 2 Parse Summary States: parsed, failed, and unavailable", () => {
  it("renders parsed summary with job title, skills count, and experience", () => {
    render(
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="t"
        initialResumeName="MyResume.pdf"
        initialResumeParse={{
          status: "parsed",
          source: "rules",
          jobTitle: "Frontend Architect",
          skillsCount: 5,
          yearsOfExperience: 7,
        }}
      />
    );

    const parseStatus = screen.getByTestId("resume-parse-status");
    expect(parseStatus.getAttribute("data-status")).toBe("parsed");
    expect(parseStatus.textContent).toContain("Frontend Architect");
    expect(parseStatus.textContent).toContain("5 skills");
    expect(parseStatus.textContent).toContain("7 yrs experience");

    const finishBtn = screen.getByTestId("btn-onboarding-finish");
    expect(finishBtn.textContent).toBe("Continue to Jobs");
  });

  it("renders failed summary explaining scanned image and falling back to preferences", () => {
    render(
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="t"
        initialResumeName="scan.pdf"
        initialResumeParse={{
          status: "failed",
          reason: "scanned_pdf",
        }}
      />
    );

    const parseStatus = screen.getByTestId("resume-parse-status");
    expect(parseStatus.getAttribute("data-status")).toBe("failed");
    expect(parseStatus.textContent).toMatch(/scanned image/);
    expect(parseStatus.textContent).toMatch(/preferences/);

    const finishBtn = screen.getByTestId("btn-onboarding-finish");
    expect(finishBtn.textContent).toBe("Continue to Jobs");
  });

  it("handles unavailable parse status gracefully without breaking upload display", () => {
    render(
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="t"
        initialResumeName="cv.docx"
        initialResumeParse={{
          status: "unavailable",
        }}
      />
    );

    expect(screen.queryByTestId("resume-parse-status")).toBeNull();
    expect(screen.getByTestId("resume-success").textContent).toContain("Resume saved");
    expect(screen.getByText("cv.docx")).toBeTruthy();
    const finishBtn = screen.getByTestId("btn-onboarding-finish");
    expect(finishBtn.textContent).toBe("Continue to Jobs");
  });
});

describe("OnboardingStep1 in Edit Mode", () => {
  it("prefills existing values and allows clicking Next", () => {
    const onNext = vi.fn();
    render(
      <OnboardingStep1
        {...step1Props}
        roles={["Backend Engineer"]}
        employmentTypes={["Full-time", "Contract"]}
        country="United States"
        workAuth="authorized"
        openToRemote={true}
        onNext={onNext}
      />
    );

    // Selected role shown in summary chip
    expect(screen.getByText("Backend Engineer")).toBeTruthy();

    // Checkboxes checked
    const fullTimeBtn = screen.getByRole("button", { name: "Full-time" });
    expect(fullTimeBtn.getAttribute("aria-pressed")).toBe("true");

    const contractBtn = screen.getByRole("button", { name: "Contract" });
    expect(contractBtn.getAttribute("aria-pressed")).toBe("true");

    // Location shown
    expect(screen.getByText("United States")).toBeTruthy();

    // Work auth selected
    const workAuthBtn = screen.getByRole("button", { name: /Authorized to work/ });
    expect(workAuthBtn.getAttribute("aria-pressed")).toBe("true");

    // Next button enabled
    const nextBtn = screen.getByTestId("btn-onboarding-step1-next");
    expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(nextBtn);
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
