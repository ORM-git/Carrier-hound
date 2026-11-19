// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import FirstJobsWelcome from "../FirstJobsWelcome";
import JobsProductTour, { TOUR_STEPS } from "../JobsProductTour";
import {
  shouldShowFirstJobsWelcome,
  consumeFirstRunMarker,
  markTourDismissed,
  isTourDismissed,
  setFirstJobsMarker,
} from "@/lib/onboarding/firstJobsExperience";

describe("FirstJobsWelcome Dialog", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders with capped recommendation count and accessible dialog semantics", () => {
    const handleClose = vi.fn();
    const handleConfirm = vi.fn();

    render(
      <FirstJobsWelcome
        isOpen={true}
        onClose={handleClose}
        onConfirm={handleConfirm}
        recommendedCount={18}
        initialLevels=""
      />
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    // Title mentions count
    expect(
      screen.getByText(/Welcome! We found 18 roles in your current recommendations/i)
    ).toBeInTheDocument();
    // Scope note
    expect(screen.getByText(/Here is your current recommendation set/i)).toBeInTheDocument();
  });

  it("renders fallback message when recommendation count is zero or null", () => {
    const handleClose = vi.fn();
    const handleConfirm = vi.fn();

    render(
      <FirstJobsWelcome
        isOpen={true}
        onClose={handleClose}
        onConfirm={handleConfirm}
        recommendedCount={0}
      />
    );

    expect(screen.getByText("Your job preferences are ready")).toBeInTheDocument();
  });

  it("pre-selects initial levels and supports toggling checkboxes", () => {
    const handleClose = vi.fn();
    const handleConfirm = vi.fn();

    render(
      <FirstJobsWelcome
        isOpen={true}
        onClose={handleClose}
        onConfirm={handleConfirm}
        recommendedCount={12}
        initialLevels="entry,senior"
      />
    );

    // Entry and Senior checkboxes should be checked
    const entryCheckbox = screen.getByLabelText(/Entry Level/i) as HTMLInputElement;
    const seniorCheckbox = screen.getByLabelText(/Senior Level/i) as HTMLInputElement;
    const midCheckbox = screen.getByLabelText(/Mid Level/i) as HTMLInputElement;

    expect(entryCheckbox.checked).toBe(true);
    expect(seniorCheckbox.checked).toBe(true);
    expect(midCheckbox.checked).toBe(false);

    // Toggle mid checkbox on
    fireEvent.click(midCheckbox);
    expect(midCheckbox.checked).toBe(true);

    // Toggle entry checkbox off
    fireEvent.click(entryCheckbox);
    expect(entryCheckbox.checked).toBe(false);

    // Click Confirm button
    const confirmButton = screen.getByRole("button", { name: /Confirm & See Jobs/i });
    fireEvent.click(confirmButton);

    expect(handleConfirm).toHaveBeenCalledTimes(1);
    const confirmedLevels = handleConfirm.mock.calls[0][0];
    expect(confirmedLevels).toContain("senior");
    expect(confirmedLevels).toContain("mid");
    expect(confirmedLevels).not.toContain("entry");
  });

  it("supports Clear all and Select all buttons", () => {
    const handleConfirm = vi.fn();

    render(
      <FirstJobsWelcome
        isOpen={true}
        onClose={vi.fn()}
        onConfirm={handleConfirm}
        initialLevels="mid"
      />
    );

    const clearButton = screen.getByRole("button", { name: /Clear all/i });
    fireEvent.click(clearButton);

    const midCheckbox = screen.getByLabelText(/Mid Level/i) as HTMLInputElement;
    expect(midCheckbox.checked).toBe(false);

    const selectAllButton = screen.getByRole("button", { name: /Select all/i });
    fireEvent.click(selectAllButton);

    const confirmButton = screen.getByRole("button", { name: /Confirm & See Jobs/i });
    fireEvent.click(confirmButton);

    expect(handleConfirm).toHaveBeenCalledWith(
      expect.arrayContaining(["intern", "entry", "mid", "senior", "lead"])
    );
  });

  it("calls onClose on Close button, Skip button, or Escape key", () => {
    const handleClose = vi.fn();

    const { rerender } = render(
      <FirstJobsWelcome
        isOpen={true}
        onClose={handleClose}
        onConfirm={vi.fn()}
      />
    );

    // Click Close (X) button
    const closeBtn = screen.getByRole("button", { name: /Close welcome dialog/i });
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);

    // Click Skip for now button
    const skipBtn = screen.getByRole("button", { name: /Skip for now/i });
    fireEvent.click(skipBtn);
    expect(handleClose).toHaveBeenCalledTimes(2);

    // Escape key
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleClose).toHaveBeenCalledTimes(3);

    // Rerender with isOpen={false} -> does not render dialog
    rerender(
      <FirstJobsWelcome
        isOpen={false}
        onClose={handleClose}
        onConfirm={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("JobsProductTour Component", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  it("renders nothing when isActive is false", () => {
    render(
      <JobsProductTour
        isActive={false}
        onComplete={vi.fn()}
        onExit={vi.fn()}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders 3 defined steps in order and progresses through Next/Back/Complete", () => {
    // The "facts" step (Listing Facts panel) was removed along with the panel itself.
    expect(TOUR_STEPS).toHaveLength(3);
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(["filters", "details", "apply"]);

    // Create target elements in DOM
    const filterEl = document.createElement("button");
    filterEl.setAttribute("data-tour", "tour-filters");
    document.body.appendChild(filterEl);

    const detailsEl = document.createElement("button");
    detailsEl.setAttribute("data-tour", "tour-job-details");
    document.body.appendChild(detailsEl);

    const applyEl = document.createElement("button");
    applyEl.setAttribute("data-tour", "tour-job-apply");
    document.body.appendChild(applyEl);

    const handleComplete = vi.fn();
    const handleExit = vi.fn();

    render(
      <JobsProductTour
        isActive={true}
        onComplete={handleComplete}
        onExit={handleExit}
      />
    );

    // Step 1: Adjust Your Job Preferences
    expect(screen.getByText("Adjust Your Job Preferences")).toBeInTheDocument();
    expect(screen.getByText(/1 of 3/i)).toBeInTheDocument();

    // Click Next -> Step 2
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    expect(screen.getByText("View Job Details")).toBeInTheDocument();
    expect(screen.getByText(/2 of 3/i)).toBeInTheDocument();

    // Click Back -> Step 1
    fireEvent.click(screen.getByRole("button", { name: /Back/i }));
    expect(screen.getByText("Adjust Your Job Preferences")).toBeInTheDocument();

    // Advance to Step 3
    fireEvent.click(screen.getByRole("button", { name: /Next/i })); // to step 2
    fireEvent.click(screen.getByRole("button", { name: /Next/i })); // to step 3
    expect(screen.getByText("Apply")).toBeInTheDocument();

    // Click Done button -> onComplete
    const finishBtn = screen.getByRole("button", { name: /Done/i });
    fireEvent.click(finishBtn);
    expect(handleComplete).toHaveBeenCalledTimes(1);
  });

  it("calls onExit when Exit button or close button is clicked", () => {
    const filterEl = document.createElement("button");
    filterEl.setAttribute("data-tour", "tour-filters");
    document.body.appendChild(filterEl);

    const handleExit = vi.fn();
    render(
      <JobsProductTour
        isActive={true}
        onComplete={vi.fn()}
        onExit={handleExit}
      />
    );

    const exitBtn = screen.getByRole("button", { name: /Exit tour/i });
    fireEvent.click(exitBtn);
    expect(handleExit).toHaveBeenCalledTimes(1);
  });
});

describe("FirstJobsExperience Persistence & Isolation", () => {
  const TEST_USER = "user_abc_123";
  const OTHER_USER = "user_xyz_999";

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("checks eligibility strictly based on user, tab, mode and marker", () => {
    // Unverified / guest -> false
    expect(
      shouldShowFirstJobsWelcome({
        userId: undefined,
        isVerifiedUser: false,
        isRecommendedTab: true,
        isEditMode: false,
      })
    ).toBe(false);

    // Non-recommended tab -> false
    expect(
      shouldShowFirstJobsWelcome({
        userId: TEST_USER,
        isVerifiedUser: true,
        isRecommendedTab: false,
        isEditMode: false,
      })
    ).toBe(false);

    // Edit mode -> false
    expect(
      shouldShowFirstJobsWelcome({
        userId: TEST_USER,
        isVerifiedUser: true,
        isRecommendedTab: true,
        isEditMode: true,
      })
    ).toBe(false);

    // Without first-run marker -> false
    expect(
      shouldShowFirstJobsWelcome({
        userId: TEST_USER,
        isVerifiedUser: true,
        isRecommendedTab: true,
        isEditMode: false,
      })
    ).toBe(false);

    // Set first-run marker -> true
    setFirstJobsMarker(TEST_USER);
    expect(
      shouldShowFirstJobsWelcome({
        userId: TEST_USER,
        isVerifiedUser: true,
        isRecommendedTab: true,
        isEditMode: false,
      })
    ).toBe(true);

    // Different user without marker -> false
    expect(
      shouldShowFirstJobsWelcome({
        userId: OTHER_USER,
        isVerifiedUser: true,
        isRecommendedTab: true,
        isEditMode: false,
      })
    ).toBe(false);
  });

  it("isolates consumption and tour dismissal per account", () => {
    setFirstJobsMarker(TEST_USER);
    setFirstJobsMarker(OTHER_USER);

    // Consume for TEST_USER
    consumeFirstRunMarker(TEST_USER);

    expect(
      shouldShowFirstJobsWelcome({
        userId: TEST_USER,
        isVerifiedUser: true,
        isRecommendedTab: true,
        isEditMode: false,
      })
    ).toBe(false);

    // OTHER_USER still has active marker
    expect(
      shouldShowFirstJobsWelcome({
        userId: OTHER_USER,
        isVerifiedUser: true,
        isRecommendedTab: true,
        isEditMode: false,
      })
    ).toBe(true);

    // Tour dismissal isolation
    expect(isTourDismissed(TEST_USER)).toBe(false);
    expect(isTourDismissed(OTHER_USER)).toBe(false);

    markTourDismissed(TEST_USER);
    expect(isTourDismissed(TEST_USER)).toBe(true);
    expect(isTourDismissed(OTHER_USER)).toBe(false);
  });

  it("gracefully handles storage exceptions without crashing", () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: Access is denied");
    });

    // Should not throw, should return false safely
    expect(
      shouldShowFirstJobsWelcome({
        userId: TEST_USER,
        isVerifiedUser: true,
        isRecommendedTab: true,
        isEditMode: false,
      })
    ).toBe(false);

    expect(isTourDismissed(TEST_USER)).toBe(false);

    getItemSpy.mockRestore();
  });
});

describe("Jobs welcome/tour: desktop integration contracts", () => {
  afterEach(() => {
    cleanup();
    document.body.replaceChildren();
  });

  const anchor = (tour: string, hidden = false) => {
    const el = document.createElement("button");
    el.setAttribute("data-tour", tour);
    el.textContent = tour;
    if (hidden) el.style.display = "none";
    document.body.appendChild(el);
    return el;
  };

  it("uses the visible desktop control when a hidden mobile control shares the same anchor", () => {
    anchor("tour-filters", true); // mobile Filters button, hidden at desktop
    anchor("tour-filters"); // desktop All Filters
    anchor("tour-job-apply");
    render(<JobsProductTour isActive onComplete={vi.fn()} onExit={vi.fn()} />);
    expect(screen.getByText("Adjust Your Job Preferences")).toBeInTheDocument();
    expect(screen.getByText(/1 of 2|1 \/ 2|Step 1 of 2/)).toBeInTheDocument();
  });

  it("skips absent targets and renumbers; ends immediately when nothing is visible", () => {
    anchor("tour-filters");
    anchor("tour-job-apply");
    render(<JobsProductTour isActive onComplete={vi.fn()} onExit={vi.fn()} />);
    expect(screen.getByText(/1 of 2|1 \/ 2|Step 1 of 2/)).toBeInTheDocument();
    cleanup();
    document.body.replaceChildren();
    const onComplete = vi.fn();
    render(<JobsProductTour isActive onComplete={onComplete} onExit={vi.fn()} />);
    expect(onComplete).toHaveBeenCalled();
  });

  it("keyboard-only Escape exits the tour", () => {
    anchor("tour-filters");
    const onExit = vi.fn();
    render(<JobsProductTour isActive onComplete={vi.fn()} onExit={onExit} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onExit).toHaveBeenCalled();
  });

  it("tour copy makes no score, AI or promotional claims", () => {
    const text = TOUR_STEPS.map((s) => `${s.title} ${s.description}`).join(" ");
    expect(text).not.toMatch(/\bAI\b|match score|%|resume|perks|company profile/i);
  });

  it("welcome makes the page background inert while open and restores it on close", () => {
    const page = document.createElement("div");
    page.id = "page";
    document.body.appendChild(page);
    const { rerender } = render(<FirstJobsWelcome isOpen onClose={vi.fn()} onConfirm={vi.fn()} recommendedCount={12} />);
    expect(page.hasAttribute("inert")).toBe(true);
    expect(screen.getByRole("dialog").closest("[inert]")).toBeNull();
    rerender(<FirstJobsWelcome isOpen={false} onClose={vi.fn()} onConfirm={vi.fn()} recommendedCount={12} />);
    expect(page.hasAttribute("inert")).toBe(false);
  });

  it("independent checkboxes produce an OR selection; unknown count shows the honest fallback", () => {
    const onConfirm = vi.fn();
    render(<FirstJobsWelcome isOpen onClose={vi.fn()} onConfirm={onConfirm} recommendedCount={null} />);
    expect(screen.getByText("Your job preferences are ready")).toBeInTheDocument();
    expect(screen.queryByText(/We found 0/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Entry Level/));
    fireEvent.click(screen.getByLabelText(/Senior Level/));
    fireEvent.click(screen.getByText("Confirm & See Jobs"));
    expect(onConfirm).toHaveBeenCalledWith(["entry", "senior"]);
  });
});
