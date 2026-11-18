// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { render, fireEvent, screen, cleanup, waitFor } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import OnboardingStep2, { describeResumeParse } from "@/components/onboarding/OnboardingStep2";

const FLAG = "NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED";
const originalFetch = globalThis.fetch;

function renderStep2() {
  return render(<OnboardingStep2 onBack={vi.fn()} onFinish={vi.fn()} isSaving={false} authToken="tok" />);
}

function pickFile(name = "Profile.pdf", type = "application/pdf") {
  const input = screen.getByTestId("input-resume-file") as HTMLInputElement;
  const file = new File(["%PDF-1.7 test"], name, { type });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  process.env[FLAG] = "true";
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  delete process.env[FLAG];
});

describe("Onboarding Step 2: resume or LinkedIn PDF", () => {
  it("tells users they can upload their LinkedIn 'Save to PDF' file in the same box", () => {
    renderStep2();
    expect(screen.getByText("Upload resume or LinkedIn PDF")).toBeTruthy();
    const hint = screen.getByTestId("resume-linkedin-hint").textContent || "";
    expect(hint).toMatch(/LinkedIn profile/);
    expect(hint).toMatch(/More/);
    expect(hint).toMatch(/Save to PDF/);
    // Same single upload input, same accepted types
    expect(screen.getAllByTestId("input-resume-file")).toHaveLength(1);
    expect((screen.getByTestId("input-resume-file") as HTMLInputElement).accept).toContain(".pdf");
  });

  it("shows what was read after a parsed upload", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          fileName: "Profile.pdf",
          parse: { status: "parsed", source: "rules", jobTitle: "Senior Data Analyst", skillsCount: 4, topSkills: ["Python"], yearsOfExperience: 8.4 },
        }),
        { status: 200 }
      )
    ) as any;
    renderStep2();
    pickFile();
    await waitFor(() => expect(screen.getByTestId("resume-parse-status")).toBeTruthy());
    const status = screen.getByTestId("resume-parse-status");
    expect(status.getAttribute("data-status")).toBe("parsed");
    expect(status.textContent).toBe(
      "We read Senior Data Analyst · 4 skills · 8.4 yrs experience. We'll use this to rank your recommended jobs."
    );
    expect(screen.getByTestId("resume-success").textContent).toMatch(/Resume saved/);
    expect(screen.getByTestId("btn-onboarding-finish").textContent).toBe("Finish");
  });

  it("a scanned PDF is saved, explained without an error, and the user can finish", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, fileName: "scan.pdf", parse: { status: "failed", reason: "scanned_pdf" } }), { status: 200 })
    ) as any;
    renderStep2();
    pickFile("scan.pdf");
    await waitFor(() => expect(screen.getByTestId("resume-parse-status")).toBeTruthy());
    expect(screen.queryByTestId("resume-error")).toBeNull();
    expect(screen.getByTestId("resume-parse-status").textContent).toMatch(/scanned image/);
    expect((screen.getByTestId("btn-onboarding-finish") as HTMLButtonElement).disabled).toBe(false);
  });

  it("an older server response without `parse` still shows 'Resume saved' and no parse line", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, fileName: "cv.pdf" }), { status: 200 })) as any;
    renderStep2();
    pickFile("cv.pdf");
    await waitFor(() => expect(screen.getByTestId("resume-success")).toBeTruthy());
    expect(screen.queryByTestId("resume-parse-status")).toBeNull();
  });

  it("flag off: unchanged Coming soon cards, no upload box and no LinkedIn hint", () => {
    process.env[FLAG] = "false";
    renderStep2();
    expect(screen.queryByTestId("input-resume-file")).toBeNull();
    expect(screen.queryByTestId("resume-linkedin-hint")).toBeNull();
    expect(screen.getAllByText("Coming soon").length).toBe(2);
  });
});

describe("describeResumeParse", () => {
  it("covers parsed, failed and unavailable", () => {
    expect(describeResumeParse({ status: "parsed" })).toBe("We'll use your resume to rank your recommended jobs.");
    expect(describeResumeParse({ status: "parsed", skillsCount: 1 })).toMatch(/^We read 1 skill\./);
    expect(describeResumeParse({ status: "failed", reason: "no_text" })).toMatch(/couldn't read details/);
    expect(describeResumeParse({ status: "unavailable" })).toBeNull();
    expect(describeResumeParse(null)).toBeNull();
  });
});
