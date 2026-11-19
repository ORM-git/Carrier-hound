// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";

const getProAccessStatus = vi.fn();

// Stable router like Next's (a new object per render would re-run the access effect forever).
const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/auth/session", () => ({ getAuthUser: async () => ({ id: "user-a", email: "a@test.com" }) }));
vi.mock("@/lib/billing/subscription", () => ({ getProAccessStatus: (...a: unknown[]) => getProAccessStatus(...a) }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } }),
}));
vi.mock("@/components/shell/LoggedInAppShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/billing/ProUpgradeScreen", () => ({ default: () => <div data-testid="upgrade-screen" /> }));
vi.mock("@/components/interview-pack/InterviewPackView", () => ({ default: () => <div data-testid="pro-view" /> }));
vi.mock("@/components/skill-what-if/SkillWhatIfView", () => ({ default: () => <div data-testid="pro-view" /> }));

import InterviewPackClient from "../[id]/interview-pack/InterviewPackClient";
import SkillWhatIfClient from "../[id]/skill-what-if/SkillWhatIfClient";

const clients: Array<[string, React.ComponentType<{ jobId: string }>, string]> = [
  ["Interview Pack", InterviewPackClient, "interview-pack-access-retry"],
  ["Skill What-If", SkillWhatIfClient, "skill-what-if-access-retry"],
];

beforeEach(() => {
  getProAccessStatus.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(clients)("%s client entitlement states", (_name, Client, retryId) => {
  it("shows a retry (never the Free/upgrade screen) when the Pro check is not definitive", async () => {
    getProAccessStatus.mockResolvedValue({ isPro: false, isDefinitive: false });
    render(<Client jobId="sample" />);
    expect(await screen.findByTestId(retryId)).toBeTruthy();
    expect(screen.queryByTestId("upgrade-screen")).toBeNull();
  });

  it("shows a retry when the Pro check throws", async () => {
    getProAccessStatus.mockRejectedValue(new Error("network"));
    render(<Client jobId="sample" />);
    expect(await screen.findByTestId(retryId)).toBeTruthy();
    expect(screen.queryByTestId("upgrade-screen")).toBeNull();
  });

  it("retry re-checks and shows the upgrade screen only once Free is definitive", async () => {
    getProAccessStatus.mockResolvedValueOnce({ isPro: false, isDefinitive: false });
    getProAccessStatus.mockResolvedValue({ isPro: false, isDefinitive: true });
    render(<Client jobId="sample" />);
    fireEvent.click(await screen.findByTestId(retryId));
    expect(await screen.findByTestId("upgrade-screen")).toBeTruthy();
  });

  it.each(["careermonke_pro_updated", "careermonke_auth_updated"])("re-checks access on %s (e.g. after purchase)", async (evt) => {
    getProAccessStatus.mockResolvedValueOnce({ isPro: false, isDefinitive: true });
    getProAccessStatus.mockResolvedValue({ isPro: true, isDefinitive: true });
    render(<Client jobId="sample" />);
    expect(await screen.findByTestId("upgrade-screen")).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event(evt));
    });
    expect(await screen.findByTestId("pro-view")).toBeTruthy();
    expect(getProAccessStatus).toHaveBeenCalledTimes(2);
  });
});
