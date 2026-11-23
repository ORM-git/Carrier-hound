// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createFakeSupabase, seedCompletedAccount } from "@/lib/auth/__tests__/fakeSupabase";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock coverage: stateful local DB stub; real Supabase sessions are not exercised.
let fakeDb = createFakeSupabase();
let currentUser: { id: string } | null = null;
const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mockReplace, push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: (props: any) => createElement("a", props, props.children) }));
vi.mock("@/components/GuideHeader", () => ({ default: () => null }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: (t: string) => fakeDb.client.from(t), auth: {} }),
}));
vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { getValidReturnUrl: actual.getValidReturnUrl, getAuthUser: async () => currentUser };
});

import LoginPage from "../page";

describe("/login already-signed-in redirect", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    window.history.replaceState(null, "", "/login");
    mockReplace.mockReset();
    fakeDb = createFakeSupabase();
    currentUser = null;
  });

  async function mountAt(url: string) {
    window.history.replaceState(null, "", url);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(createElement(LoginPage)));
    for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
  }

  it("not-onboarded signed-in user: one navigation to onboarding, validated returnTo kept", async () => {
    currentUser = fakeDb.signUp("fresh@example.test");
    await mountAt("/login?returnTo=%2Fjobs%2Fsaved");
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/onboarding?next=%2Fjobs%2Fsaved");
  });

  it("completed signed-in user keeps the destination (no stale /jobs navigation first)", async () => {
    currentUser = fakeDb.signUp("done@example.test");
    seedCompletedAccount(fakeDb, currentUser!.id);
    await mountAt("/login?returnTo=%2Fprofile");
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/profile");
  });

  it("unsafe returnTo falls back to /jobs; signed-out visitors are not redirected", async () => {
    currentUser = fakeDb.signUp("unsafe@example.test");
    seedCompletedAccount(fakeDb, currentUser!.id);
    await mountAt("/login?returnTo=https%3A%2F%2Fevil.example");
    expect(mockReplace).toHaveBeenCalledWith("/jobs");

    act(() => root!.unmount());
    root = null;
    mockReplace.mockReset();
    currentUser = null;
    await mountAt("/login");
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
