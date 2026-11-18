// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();
const router = { replace }; // stable like Next's router
const getAuthUser = vi.fn();
const getProAccessStatus = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="globe" /> }));
vi.mock("@/lib/auth/session", () => ({ getAuthUser: () => getAuthUser() }));
vi.mock("@/lib/billing/subscription", () => ({ getProAccessStatus: (id: string) => getProAccessStatus(id) }));
vi.mock("@/components/shell/LoggedInAppShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/billing/ProUpgradeScreen", () => ({ default: () => <div data-testid="upgrade" /> }));

import RadarPage from "../page";

const transient = { isPro: false, status: "unknown", inGracePeriod: false, isLoading: true, isDefinitive: false };
const pro = { isPro: true, status: "active", inGracePeriod: false, isLoading: false, isDefinitive: true };
const free = { isPro: false, status: "none", inGracePeriod: false, isLoading: false, isDefinitive: true };

beforeEach(() => {
  vi.clearAllMocks();
  getAuthUser.mockResolvedValue({ id: "u1" });
});
afterEach(cleanup);

describe("RadarPage entitlement check", () => {
  it("shows a retry state on a transient failure instead of spinning forever, and retry recovers", async () => {
    getProAccessStatus.mockResolvedValueOnce(transient).mockResolvedValueOnce(pro);
    render(<RadarPage />);

    const retry = await screen.findByTestId("radar-access-retry");
    expect(screen.queryByText("Checking radar access...")).toBeNull();

    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId("globe")).toBeTruthy());
    expect(getProAccessStatus).toHaveBeenCalledTimes(2);
  });

  it("shows the retry state when the auth/entitlement call throws (network error)", async () => {
    getAuthUser.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<RadarPage />);
    expect(await screen.findByTestId("radar-access-retry")).toBeTruthy();
  });

  it("shows the spinner only while the request is in flight", async () => {
    let resolve!: (v: typeof free) => void;
    getProAccessStatus.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<RadarPage />);
    expect(screen.getByText("Checking radar access...")).toBeTruthy();
    resolve(free);
    expect(await screen.findByTestId("upgrade")).toBeTruthy();
    expect(screen.queryByText("Checking radar access...")).toBeNull();
  });

  it("redirects signed-out users to login", async () => {
    getAuthUser.mockResolvedValueOnce(null);
    render(<RadarPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?returnTo=/radar"));
  });
});
