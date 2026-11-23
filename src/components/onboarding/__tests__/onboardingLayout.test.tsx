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
    // Renders once per breakpoint tree (desktop + mobile/tablet); either copy toggles the same state.
    fireEvent.click(screen.getAllByRole("button", { name: "Open to Remote" })[0]);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("OnboardingStep1 work authorization: {1}, {2}, {3}, {2,3}", () => {
  const A = "I am authorized to work without sponsorship.";
  const S = "I need visa sponsorship.";
  const O = "I have another work permit or authorization.";
  const filled = { ...step1Props, roles: ["Software Engineer"], employmentTypes: ["full-time"], country: "India" };

  // Stateful wrapper so taps accumulate like on the real page.
  function Harness({ initial = "" }: { initial?: string }) {
    const [workAuth, setWorkAuth] = React.useState(initial);
    return <OnboardingStep1 {...filled} workAuth={workAuth} onSelectWorkAuth={setWorkAuth} />;
  }
  // The mobile tree renders first; the desktop copy is display:none in a real browser.
  const option = (label: string) => screen.getAllByRole("button", { name: label })[0];
  const pressed = () => [A, S, O].filter((l) => option(l).getAttribute("aria-pressed") === "true");
  const next = () => screen.getByTestId("btn-onboarding-step1-next-mobile") as HTMLButtonElement;

  it("nothing is preselected and Next stays disabled until a valid set is chosen", () => {
    render(<Harness />);
    expect(pressed()).toEqual([]);
    expect(next().disabled).toBe(true);
    fireEvent.click(option(S));
    expect(next().disabled).toBe(false);
  });

  it("2 and 3 combine; 1 clears them; 2 or 3 clear 1; re-tap deselects", () => {
    render(<Harness />);
    fireEvent.click(option(S));
    fireEvent.click(option(O));
    expect(pressed()).toEqual([S, O]);
    fireEvent.click(option(A));
    expect(pressed()).toEqual([A]);
    fireEvent.click(option(O));
    expect(pressed()).toEqual([O]);
    fireEvent.click(option(O));
    expect(pressed()).toEqual([]);
    expect(next().disabled).toBe(true);
  });

  it("an invalid saved combination shows nothing selected and does not complete the step", () => {
    render(<Harness initial={`${A} + ${S}`} />);
    expect(pressed()).toEqual([]);
    expect(next().disabled).toBe(true);
  });

  it("a saved {2,3} reloads as both selected", () => {
    render(<Harness initial={`${S} + ${O}`} />);
    expect(pressed()).toEqual([S, O]);
    expect(next().disabled).toBe(false);
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
      if (id === "linkedin-card-title") {
        expect(desc.textContent).toBe("e.g. https://www.linkedin.com/in/yourname");
      }
    }
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

  it("expands mobile categories inline as an accordion and keeps selections across collapse", () => {
    const onToggleRole = vi.fn();
    const { rerender } = render(
      <JobFunctionBottomSheet isOpen={true} onClose={() => {}} selectedRoles={[]} onToggleRole={onToggleRole} />
    );

    const consulting = screen.getByTestId("mobile-cat-consulting");
    expect(consulting.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("mobile-cat-panel-consulting")).toBeNull();

    // Expand in place: no drill-down screen, other category rows stay rendered.
    fireEvent.click(consulting);
    expect(consulting.getAttribute("aria-expanded")).toBe("true");
    expect(consulting.getAttribute("aria-controls")).toBe("mobile-cat-panel-consulting");
    const panel = document.getElementById("mobile-cat-panel-consulting")!;
    expect(panel.textContent).toContain("Strategy & Management");
    expect(screen.queryByText("Back to categories")).toBeNull();
    expect(screen.getByTestId("mobile-cat-software-internet-ai")).toBeTruthy();

    // Select a child role inline.
    const role = Array.from(panel.querySelectorAll("button")).find((b) => b.textContent === "Management Consultant")!;
    fireEvent.click(role);
    expect(onToggleRole).toHaveBeenCalledWith("Management Consultant");

    // A second category can be open at the same time.
    fireEvent.click(screen.getByTestId("mobile-cat-software-internet-ai"));
    expect(document.getElementById("mobile-cat-panel-software-internet-ai")).not.toBeNull();
    expect(document.getElementById("mobile-cat-panel-consulting")).not.toBeNull();

    // Collapse/re-expand keeps the parent-owned selection (count badge + pressed chip).
    rerender(
      <JobFunctionBottomSheet
        isOpen={true}
        onClose={() => {}}
        selectedRoles={["Management Consultant"]}
        onToggleRole={onToggleRole}
      />
    );
    fireEvent.click(consulting);
    expect(consulting.getAttribute("aria-expanded")).toBe("false");
    expect(consulting.textContent).toContain("1 selected");
    fireEvent.click(consulting);
    const reopened = document.getElementById("mobile-cat-panel-consulting")!;
    const chip = Array.from(reopened.querySelectorAll("button")).find((b) => b.textContent === "Management Consultant")!;
    expect(chip.getAttribute("aria-pressed")).toBe("true");
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

    const searchInput = screen.getByLabelText("Search job roles");
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
    // 2 placeholder cards (LinkedIn, Resume) rendered once per breakpoint tree (desktop + mobile/tablet) = 4.
    expect(screen.getAllByText("Coming soon")).toHaveLength(4);

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

    // Desktop keeps per-card skips (the phone tree has none since item 10)
    const skipLi = screen.getByTestId("skip-linkedin");
    fireEvent.click(skipLi);
    expect(screen.getAllByText("Skipped")).toHaveLength(1);

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

describe("Step 2 phone: one bottom-right 'Skip for now' for LinkedIn and CV", () => {
  const URL_IN = "https://www.linkedin.com/in/test-user";
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ linkedinUrl: URL_IN }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const finishBtn = () => screen.getByTestId("btn-onboarding-finish-mobile");
  const saveLinkedIn = async () => {
    fireEvent.change(screen.getByTestId("input-linkedin-url-mobile"), { target: { value: URL_IN } });
    fireEvent.click(screen.getByTestId("btn-save-linkedin-mobile"));
    await waitFor(() => expect(finishBtn().textContent).toBe("Finish"));
  };

  it("both empty: no per-card skip controls, one 'Skip for now' that finishes without saving anything", () => {
    const onFinish = vi.fn();
    render(<OnboardingStep2 onBack={() => {}} onFinish={onFinish} isSaving={false} authToken="t" />);
    expect(screen.queryByTestId("skip-linkedin-mobile")).toBeNull();
    expect(screen.queryByTestId("skip-resume-mobile")).toBeNull();
    // Both optional fields stay visible on the phone.
    expect(screen.getByTestId("input-linkedin-url-mobile")).toBeTruthy();
    expect(screen.getByTestId("resume-dropzone-mobile")).toBeTruthy();
    expect(finishBtn().textContent).toBe("Skip for now");
    fireEvent.click(finishBtn());
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("one field filled: saving LinkedIn still works, the action becomes Finish and the CV is skipped", async () => {
    const onFinish = vi.fn();
    const onLinkedinSaved = vi.fn();
    render(
      <OnboardingStep2 onBack={() => {}} onFinish={onFinish} isSaving={false} authToken="t" onLinkedinSaved={onLinkedinSaved} />
    );
    await saveLinkedIn();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/onboarding/linkedin");
    expect(onLinkedinSaved).toHaveBeenCalledWith(URL_IN);
    fireEvent.click(finishBtn());
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("typed but unsaved LinkedIn is not treated as saved: the action stays 'Skip for now'", () => {
    render(<OnboardingStep2 onBack={() => {}} onFinish={() => {}} isSaving={false} authToken="t" />);
    fireEvent.change(screen.getByTestId("input-linkedin-url-mobile"), { target: { value: URL_IN } });
    expect(finishBtn().textContent).toBe("Skip for now");
  });

  it("both filled: saved CV plus saved LinkedIn shows Finish and both stay marked saved", async () => {
    const onFinish = vi.fn();
    render(
      <OnboardingStep2 onBack={() => {}} onFinish={onFinish} isSaving={false} authToken="t" initialResumeName="cv.pdf" />
    );
    expect(finishBtn().textContent).toBe("Finish");
    await saveLinkedIn();
    expect(screen.getAllByText("Saved").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(finishBtn());
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("Back then Next keeps the saved LinkedIn URL and CV (page re-passes them on remount)", async () => {
    let savedUrl: string | null = null;
    const first = render(
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="t"
        initialResumeName="cv.pdf"
        onLinkedinSaved={(u) => (savedUrl = u)}
      />
    );
    await saveLinkedIn();
    first.unmount(); // Back to step 1 unmounts step 2 on the real page
    render(
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="t"
        initialResumeName="cv.pdf"
        initialLinkedinUrl={savedUrl}
      />
    );
    expect((screen.getByTestId("input-linkedin-url-mobile") as HTMLInputElement).value).toBe(URL_IN);
    expect(finishBtn().textContent).toBe("Finish");
    expect(screen.getAllByText("cv.pdf").length).toBeGreaterThan(0);
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
    expect(screen.getAllByText("cv.docx").length).toBeGreaterThan(0);
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

    // Selected role shown in summary chip (once per breakpoint tree: desktop + mobile/tablet)
    expect(screen.getAllByText("Backend Engineer").length).toBeGreaterThan(0);

    // Checkboxes checked
    for (const fullTimeBtn of screen.getAllByRole("button", { name: "Full-time" })) {
      expect(fullTimeBtn.getAttribute("aria-pressed")).toBe("true");
    }

    for (const contractBtn of screen.getAllByRole("button", { name: "Contract" })) {
      expect(contractBtn.getAttribute("aria-pressed")).toBe("true");
    }

    // Location shown
    expect(screen.getAllByText("United States").length).toBeGreaterThan(0);

    // Work auth selected
    for (const workAuthBtn of screen.getAllByRole("button", { name: /I am authorized to work without sponsorship/ })) {
      expect(workAuthBtn.getAttribute("aria-pressed")).toBe("true");
    }

    // Next button enabled
    const nextBtn = screen.getByTestId("btn-onboarding-step1-next");
    expect((nextBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(nextBtn);
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
