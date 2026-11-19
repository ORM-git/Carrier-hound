// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import OnboardingFeatureHighlights, {
  FEATURE_HIGHLIGHTS_SLIDES,
} from "../OnboardingFeatureHighlights";

describe("OnboardingFeatureHighlights", () => {
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

  it("renders exactly three listing-only slides with truthful copy", () => {
    render(<OnboardingFeatureHighlights />);

    // Renders carousel landmark
    const carousel = screen.getByRole("region", { name: "Platform feature highlights" });
    expect(carousel).toBeInTheDocument();
    expect(carousel.getAttribute("aria-roledescription")).toBe("carousel");

    // Exactly 3 slides defined
    expect(FEATURE_HIGHLIGHTS_SLIDES).toHaveLength(3);

    // Slide 1: Find roles faster
    expect(FEATURE_HIGHLIGHTS_SLIDES[0].title).toBe("Find roles faster");
    expect(FEATURE_HIGHLIGHTS_SLIDES[0].description).toBe(
      "Search job titles and companies using the real search field."
    );

    // Slide 2: Narrow your search
    expect(FEATURE_HIGHLIGHTS_SLIDES[1].title).toBe("Narrow your search");
    expect(FEATURE_HIGHLIGHTS_SLIDES[1].description).toBe(
      "Location, job type and work-model filters using their real labels."
    );

    // Slide 3: Review the details
    expect(FEATURE_HIGHLIGHTS_SLIDES[2].title).toBe("Review the details");
    expect(FEATURE_HIGHLIGHTS_SLIDES[2].description).toBe(
      "Open a job and read its listed requirements before using the existing Apply action."
    );
  });

  it("contains NO forbidden AI, tailoring, autofill, or competitor claims", () => {
    const { container } = render(<OnboardingFeatureHighlights />);
    const text = container.textContent || "";

    const forbiddenPhrases = [
      /ask orion/i,
      /autofill/i,
      /apply with autofill/i,
      /ai resume/i,
      /tailoring/i,
      /custom resume/i,
      /fit-score/i,
      /match score/i,
      /coaching reward/i,
      /private coaching/i,
      /referral/i,
      /radar/i,
      /tracker/i,
      /3113/i,
    ];

    for (const phrase of forbiddenPhrases) {
      expect(text).not.toMatch(phrase);
    }

    // Must NOT contain links that navigate away during upload
    const links = container.querySelectorAll("a");
    expect(links.length).toBe(0);
  });

  it("allows navigating via pagination dots with accessible aria attributes", () => {
    render(<OnboardingFeatureHighlights />);

    const dots = screen.getAllByRole("tab");
    expect(dots).toHaveLength(3);

    // Initially Slide 1 is active
    expect(dots[0]).toHaveAttribute("aria-selected", "true");
    expect(dots[1]).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    // Click dot 2 -> Slide 2 active
    fireEvent.click(dots[1]);
    expect(dots[1]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();

    // Click dot 3 -> Slide 3 active
    fireEvent.click(dots[2]);
    expect(dots[2]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Review the details")).toBeInTheDocument();
  });

  it("allows navigating via previous and next buttons", () => {
    render(<OnboardingFeatureHighlights />);

    const prevBtn = screen.getByRole("button", { name: "Previous highlight" });
    const nextBtn = screen.getByRole("button", { name: "Next highlight" });

    // Click Next -> Slide 2
    fireEvent.click(nextBtn);
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();

    // Click Next -> Slide 3
    fireEvent.click(nextBtn);
    expect(screen.getByText("Review the details")).toBeInTheDocument();

    // Click Next -> wraps back to Slide 1
    fireEvent.click(nextBtn);
    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    // Click Prev -> wraps back to Slide 3
    fireEvent.click(prevBtn);
    expect(screen.getByText("Review the details")).toBeInTheDocument();
  });

  it("supports keyboard navigation with ArrowLeft and ArrowRight", () => {
    render(<OnboardingFeatureHighlights />);
    const dots = screen.getAllByRole("tab");

    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    fireEvent.keyDown(dots[0], { key: "ArrowRight" });
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();

    fireEvent.keyDown(dots[1], { key: "ArrowRight" });
    expect(screen.getByText("Review the details")).toBeInTheDocument();

    fireEvent.keyDown(dots[2], { key: "ArrowLeft" });
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();
  });

  it("auto-advances slides every 5000ms by default", () => {
    render(<OnboardingFeatureHighlights autoAdvanceMs={5000} />);
    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Review the details")).toBeInTheDocument();
  });

  it("provides an accessible pause/resume control", () => {
    render(<OnboardingFeatureHighlights autoAdvanceMs={5000} />);

    const pauseBtn = screen.getByRole("button", { name: /pause automatic slide rotation/i });
    expect(pauseBtn).toBeInTheDocument();

    // Click Pause
    fireEvent.click(pauseBtn);
    expect(screen.getByRole("button", { name: /resume automatic slide rotation/i })).toBeInTheDocument();

    // Verify slide does NOT advance when paused
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    // Click Resume
    const resumeBtn = screen.getByRole("button", { name: /resume automatic slide rotation/i });
    fireEvent.click(resumeBtn);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();
  });

  it("pauses rotation on mouse hover and resumes on mouse leave", () => {
    render(<OnboardingFeatureHighlights autoAdvanceMs={5000} />);
    const carousel = screen.getByRole("region", { name: "Platform feature highlights" });

    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    // Hover pauses
    fireEvent.mouseEnter(carousel);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    // Mouse leave resumes
    fireEvent.mouseLeave(carousel);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();
  });

  it("pauses rotation on focus and resumes on blur", () => {
    render(<OnboardingFeatureHighlights autoAdvanceMs={5000} />);
    const carousel = screen.getByRole("region", { name: "Platform feature highlights" });

    // Focus pauses
    fireEvent.focus(carousel);
    act(() => {
      vi.advanceTimersByTime(6000);
    });
    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    // Blur resumes
    fireEvent.blur(carousel);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();
  });

  it("pauses rotation when document is hidden (visibility API)", () => {
    render(<OnboardingFeatureHighlights autoAdvanceMs={5000} />);

    // Simulate tab switch / document hidden
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    fireEvent(document, new Event("visibilitychange"));

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    // Simulate tab returned / document visible
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    fireEvent(document, new Event("visibilitychange"));

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Narrow your search")).toBeInTheDocument();
  });

  it("disables auto-advance under prefers-reduced-motion", () => {
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

    render(<OnboardingFeatureHighlights autoAdvanceMs={5000} />);

    // Should stay on slide 1 even after 10 seconds
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByText("Find roles faster")).toBeInTheDocument();

    window.matchMedia = originalMatchMedia;
  });

  it("cleans up timer on unmount", () => {
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    const { unmount } = render(<OnboardingFeatureHighlights autoAdvanceMs={5000} />);

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it("maintains stable layout container with min-height", () => {
    render(<OnboardingFeatureHighlights />);
    const slide = screen.getByRole("group", { name: /Slide 1 of 3/i });
    expect(slide.className).toContain("min-h-");
  });
});
