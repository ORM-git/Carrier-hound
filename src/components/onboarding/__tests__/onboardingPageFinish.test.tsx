// @vitest-environment jsdom
// Page-level finish contract (real /onboarding page, mocked auth/session/network):
// accepted first-run save -> marker + funnel + /jobs; rejection -> no marker/navigation + retry;
// edit mode -> no marker; safe explicit returnTo honored; double click -> one save request.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WORK_AUTH_OPTIONS } from "@/data/onboardingCategories";
import { hasFirstJobsMarker } from "../onboardingMarkers";

const USER_ID = "fixture-user-onboarding";
const router = { replace: vi.fn(), push: vi.fn() };
let search = new URLSearchParams();
let completed = false;
const track = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => router, useSearchParams: () => search }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "fixture-token" } } }) } }),
}));
vi.mock("@/lib/auth/onboarding", () => ({
  checkAccountOnboardingCompleted: async () => completed,
  markAccountOnboardingCompleted: vi.fn(async () => undefined),
}));
vi.mock("@/lib/auth/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/session")>()),
  getAuthUser: async () => ({ id: USER_ID, email: "fixture@example.com" }),
  getUserPreferences: async () => ({
    roles: ["Backend Engineer"],
    employmentTypes: ["Full-time"],
    country: "India",
    countryCode: "IN",
    workAuth: WORK_AUTH_OPTIONS[0].label,
    remotePreference: "remote",
  }),
  saveUserPreferences: vi.fn(),
  signOutUser: vi.fn(),
}));
vi.mock("@/lib/analytics/funnel", () => ({ trackFunnelEvent: (...a: unknown[]) => track(...a) }));
vi.mock("@/config/onboarding", () => ({ isOnboardingActive: () => true, isOnboardingStep2EnabledClient: () => false }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import OnboardingPage from "@/app/onboarding/page";

const saveOk = () =>
  new Response(JSON.stringify({ preferences: { roles: ["Backend Engineer"], onboardingCompleted: true } }), { status: 200 });

async function reachFinish() {
  render(<OnboardingPage />);
  fireEvent.click(await screen.findByTestId("btn-onboarding-step1-next"));
  return screen.findByTestId("btn-onboarding-finish");
}

beforeEach(() => {
  search = new URLSearchParams();
  completed = false;
  localStorage.clear();
  sessionStorage.clear();
  router.push.mockReset();
  router.replace.mockReset();
  track.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Onboarding page finish", () => {
  it("first run: accepted save publishes the marker, tracks completion and goes to /jobs", async () => {
    const fetchMock = vi.fn(async () => saveOk());
    vi.stubGlobal("fetch", fetchMock);
    fireEvent.click(await reachFinish());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs"), { timeout: 2000 });
    expect(hasFirstJobsMarker(USER_ID)).toBe(true);
    expect(track).toHaveBeenCalledWith("onboarding_completed", { path: "/onboarding" });
  });

  it("save rejection: no marker, no completion event, no navigation; error shown and retry works", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Invalid preferences" }), { status: 400 }))
      .mockResolvedValueOnce(saveOk());
    vi.stubGlobal("fetch", fetchMock);
    const finish = await reachFinish();
    fireEvent.click(finish);
    expect(await screen.findByText("Invalid preferences")).toBeTruthy();
    expect(hasFirstJobsMarker(USER_ID)).toBe(false);
    expect(track).not.toHaveBeenCalledWith("onboarding_completed", expect.anything());
    expect(router.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("btn-onboarding-finish")); // retry
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs"), { timeout: 2000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hasFirstJobsMarker(USER_ID)).toBe(true);
  });

  it("edit mode: accepted save never publishes the first-run marker or completion event", async () => {
    search = new URLSearchParams("mode=edit");
    completed = true;
    vi.stubGlobal("fetch", vi.fn(async () => saveOk()));
    fireEvent.click(await reachFinish());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs"), { timeout: 2000 });
    expect(hasFirstJobsMarker(USER_ID)).toBe(false);
    expect(track).not.toHaveBeenCalledWith("onboarding_completed", expect.anything());
  });

  it("honors a safe explicit returnTo and normalizes the retired /dashboard to /jobs", async () => {
    search = new URLSearchParams("returnTo=/tracker");
    vi.stubGlobal("fetch", vi.fn(async () => saveOk()));
    fireEvent.click(await reachFinish());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/tracker"), { timeout: 2000 });

    cleanup();
    router.push.mockReset();
    search = new URLSearchParams("returnTo=/dashboard");
    fireEvent.click(await reachFinish());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs"), { timeout: 2000 });
  });

  it("double click on finish sends exactly one save request", async () => {
    let release!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (release = r)));
    vi.stubGlobal("fetch", fetchMock);
    const finish = await reachFinish();
    fireEvent.click(finish);
    fireEvent.click(finish);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(saveOk());
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/jobs"), { timeout: 2000 });
  });
});
