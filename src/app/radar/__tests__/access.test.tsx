// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ user: null as any, pro: false, definitive: true, replace: vi.fn() }));
vi.mock("next/navigation", () => {
  const router = { replace: h.replace };
  return { useRouter: () => router };
});
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="radar-globe" /> }));
vi.mock("@/components/shell/LoggedInAppShell", () => ({
  default: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("@/components/billing/ProUpgradeScreen", () => ({
  default: () => <div data-testid="upgrade" />,
}));
vi.mock("@/lib/auth/session", () => ({ getAuthUser: async () => h.user }));
vi.mock("@/lib/billing/subscription", () => ({
  getProAccessStatus: async () => ({ isPro: h.pro, isDefinitive: h.definitive }),
}));
import RadarPage from "../page";
afterEach(cleanup);
beforeEach(() => {
  h.user = { id: "fixture-owner" };
  h.pro = false;
  h.definitive = true;
  h.replace.mockReset();
});
describe("Radar route access stays closed", () => {
  it("redirects unauthenticated viewers without rendering globe", async () => {
    h.user = null;
    render(<RadarPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/login?returnTo=/radar"));
    expect(screen.queryByTestId("radar-globe")).toBeNull();
  });
  it("shows upgrade for confirmed Free user", async () => {
    render(<RadarPage />);
    await screen.findByTestId("upgrade");
    expect(screen.queryByTestId("radar-globe")).toBeNull();
  });
  it("does not treat a non-definitive error as Free or Pro", async () => {
    h.definitive = false;
    render(<RadarPage />);
    await screen.findByTestId("radar-access-retry");
    expect(screen.queryByTestId("radar-globe")).toBeNull();
    expect(screen.queryByTestId("upgrade")).toBeNull();
  });
  it("renders only after confirmed Pro check", async () => {
    h.pro = true;
    render(<RadarPage />);
    await screen.findByTestId("radar-globe");
  });
  it("removes mounted globe on subscription downgrade", async () => {
    h.pro = true;
    render(<RadarPage />);
    await screen.findByTestId("radar-globe");
    h.pro = false;
    await act(async () => window.dispatchEvent(new Event("careermonke_pro_updated")));
    await screen.findByTestId("upgrade");
    expect(screen.queryByTestId("radar-globe")).toBeNull();
  });
});
