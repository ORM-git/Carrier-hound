// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const mockReplace = vi.fn();
const mockUnsubscribe = vi.fn();
const mockGetSession = vi.fn();
const mockExchangeCodeForSession = vi.fn();
const mockOnAuthStateChange = vi.fn(() => ({
  data: { subscription: { unsubscribe: mockUnsubscribe } },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: mockOnAuthStateChange,
      getSession: mockGetSession,
      exchangeCodeForSession: mockExchangeCodeForSession,
    },
  }),
}));

vi.mock("@/lib/resume/storage", () => ({
  clearCandidateProfileMemoryCache: vi.fn(),
}));

vi.mock("@/lib/analytics/funnel", () => ({
  trackFunnelEvent: vi.fn(),
}));

vi.mock("@/components/BrandIcon", () => ({
  default: () => null,
}));

import AuthCallbackPage from "../page";

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AuthCallbackPage unmount while getSession is pending", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    window.history.replaceState(null, "", "/auth/callback");
    vi.restoreAllMocks();
    mockReplace.mockReset();
    mockUnsubscribe.mockReset();
    mockGetSession.mockReset();
    mockExchangeCodeForSession.mockReset();
    mockOnAuthStateChange.mockClear();
  });

  function mountPage() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(AuthCallbackPage));
    });
  }

  it("creates no fallback timer and does not redirect when unmounted before getSession resolves", async () => {
    const pendingSession = deferred<{ data: { session: null } }>();
    mockGetSession.mockReturnValueOnce(pendingSession.promise);

    mountPage();
    expect(mockGetSession).toHaveBeenCalledTimes(1);

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // Unmount runs cleanup while getSession() is still pending
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);

    // Now resolve the delayed getSession()
    pendingSession.resolve({ data: { session: null } });
    await flushMicrotasks();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("creates no hash timer and avoids a second getSession call when unmounted with #access_token", async () => {
    window.history.replaceState(null, "", "/auth/callback#access_token=abc&refresh_token=xyz");
    const pendingSession = deferred<{ data: { session: null } }>();
    mockGetSession.mockReturnValueOnce(pendingSession.promise);

    mountPage();
    expect(mockGetSession).toHaveBeenCalledTimes(1);

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // Cleanup runs while getSession is pending
    act(() => {
      root!.unmount();
    });
    root = null;

    pendingSession.resolve({ data: { session: null } });
    await flushMicrotasks();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("does not navigate when unmounted while exchangeCodeForSession is pending", async () => {
    window.history.replaceState(null, "", "/auth/callback?code=pkce_123");
    const pendingExchange = deferred<{ error: null }>();
    mockExchangeCodeForSession.mockReturnValueOnce(pendingExchange.promise);

    mountPage();
    expect(mockExchangeCodeForSession).toHaveBeenCalledWith("pkce_123");

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    act(() => {
      root!.unmount();
    });
    root = null;

    pendingExchange.resolve({ error: null });
    await flushMicrotasks();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
