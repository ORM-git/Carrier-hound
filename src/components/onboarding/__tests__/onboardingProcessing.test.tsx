// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import OnboardingProcessingScreen, {
  UPLOAD_ROTATING_MESSAGES,
  SAVING_PREFERENCES_MESSAGE,
} from "../OnboardingProcessingScreen";

describe("OnboardingProcessingScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    });
    cleanup();
  });

  it("renders with honest status and document animation elements", () => {
    render(<OnboardingProcessingScreen fileName="candidate_resume.pdf" />);

    // Renders polite status region
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toBeInTheDocument();
    expect(statusRegion.getAttribute("aria-live")).toBe("polite");

    // Renders document animation container
    expect(screen.getByTestId("cm-document-container")).toBeInTheDocument();

    // Renders file badge with filename
    expect(screen.getByTestId("cm-file-badge")).toHaveTextContent("candidate_resume.pdf");

    // Initial rotating status message
    expect(screen.getByText("Uploading and reading your file.")).toBeInTheDocument();
  });

  it("rotates truthful status messages during pending upload", () => {
    render(<OnboardingProcessingScreen />);

    // 1st sentence
    expect(screen.getByText(UPLOAD_ROTATING_MESSAGES[0])).toBeInTheDocument();

    // Advance 3.2s -> 2nd sentence
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(screen.getByText(UPLOAD_ROTATING_MESSAGES[1])).toBeInTheDocument();

    // Advance 3.2s -> 3rd sentence
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(screen.getByText(UPLOAD_ROTATING_MESSAGES[2])).toBeInTheDocument();

    // Advance 3.2s -> wraps back to 1st sentence
    act(() => {
      vi.advanceTimersByTime(3200);
    });
    expect(screen.getByText(UPLOAD_ROTATING_MESSAGES[0])).toBeInTheDocument();
  });

  it("shows 'Saving your preferences.' only during actual preferences save", () => {
    const { rerender } = render(<OnboardingProcessingScreen isSavingPreferences={false} />);
    expect(screen.getByText("Uploading and reading your file.")).toBeInTheDocument();
    expect(screen.queryByText(SAVING_PREFERENCES_MESSAGE)).not.toBeInTheDocument();

    // Transition to saving preferences
    rerender(<OnboardingProcessingScreen isSavingPreferences={true} />);
    expect(screen.getByText(SAVING_PREFERENCES_MESSAGE)).toBeInTheDocument();

    // Verify it stays on saving message and does not rotate to upload messages
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByText(SAVING_PREFERENCES_MESSAGE)).toBeInTheDocument();
  });

  it("supports phase='saving' to display saving preferences message", () => {
    render(<OnboardingProcessingScreen phase="saving" />);
    expect(screen.getByText(SAVING_PREFERENCES_MESSAGE)).toBeInTheDocument();
  });

  it("displays error immediately with accessible alert and retry action", () => {
    const onRetry = vi.fn();
    render(
      <OnboardingProcessingScreen
        error="Network error during resume upload."
        onRetry={onRetry}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Network error during resume upload.");

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("uses indeterminate progress treatment with NO fake numeric percentages", () => {
    const { container } = render(<OnboardingProcessingScreen />);

    // Indeterminate bar container and moving bar element exist
    expect(screen.getByTestId("cm-progress-bar-container")).toBeInTheDocument();
    expect(screen.getByTestId("cm-indeterminate-bar")).toBeInTheDocument();

    // No percentage strings like 25%, 50%, 80%, 100%
    const textContent = container.textContent || "";
    expect(textContent).not.toMatch(/\b\d{1,3}%\b/);

    // No fake aria-valuenow or aria-valuemax indicating a timer reaching 100%
    const bar = screen.getByTestId("cm-progress-bar-container");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
  });

  it("cleans up sentence rotation timer on unmount", () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const { unmount } = render(<OnboardingProcessingScreen />);

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it("respects prefers-reduced-motion by removing animated classes and sweep", () => {
    // Mock window.matchMedia for prefers-reduced-motion: reduce
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<OnboardingProcessingScreen />);

    const docContainer = screen.getByTestId("cm-document-container");
    expect(docContainer.className).not.toContain("cm-doc-float");

    // Scanning sweep is suppressed under reduced motion
    expect(screen.queryByTestId("cm-scanning-sweep")).not.toBeInTheDocument();

    window.matchMedia = originalMatchMedia;
  });

  it("contains NO unsupported promotional AI claims or competitor references", () => {
    const { container } = render(<OnboardingProcessingScreen />);
    const text = container.textContent || "";

    const forbiddenPhrases = [
      /ask orion/i,
      /autofill/i,
      /ai resume/i,
      /custom resume/i,
      /fit-score/i,
      /match score/i,
      /coaching/i,
      /referral/i,
      /radar/i,
      /tracker/i,
      /3113 roles/i,
    ];

    for (const phrase of forbiddenPhrases) {
      expect(text).not.toMatch(phrase);
    }
  });

  it("maintains a stable fixed-height container for rotating status lines", () => {
    render(<OnboardingProcessingScreen />);
    const statusContainer = screen.getByTestId("cm-status-line-container");
    expect(statusContainer.className).toContain("min-h-");
  });
});
