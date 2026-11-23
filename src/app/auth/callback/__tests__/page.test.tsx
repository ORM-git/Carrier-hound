// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createFakeSupabase, seedCompletedAccount } from "@/lib/auth/__tests__/fakeSupabase";
import { checkAccountOnboardingCompleted } from "@/lib/auth/onboarding";

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
let activeSession: any = null;
const mockOnAuthStateChange = vi.fn((cb: any) => {
  const wrappedCb = (event: any, session: any) => {
    if (session) activeSession = session;
    return cb(event, session);
  };
  return {
    data: { subscription: { unsubscribe: mockUnsubscribe } },
    _listener: wrappedCb,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

// Stateful local DB stub shared by the onboarding check (mock coverage, not real Supabase).
let fakeDb = createFakeSupabase();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      onAuthStateChange: (cb: any) => {
        const sub = mockOnAuthStateChange(cb);
        return {
          data: {
            subscription: {
              unsubscribe: mockUnsubscribe,
            },
          },
        };
      },
      getSession: async (...args: any[]) => {
        try {
          const res = await mockGetSession(...args);
          if (res?.data?.session) activeSession = res.data.session;
          if (res !== undefined) return res;
        } catch (err) {
          throw err;
        }
        return { data: { session: activeSession }, error: null };
      },
      exchangeCodeForSession: async (...args: any[]) => {
        const res = await mockExchangeCodeForSession(...args);
        if (res?.data?.session) activeSession = res.data.session;
        return res;
      },
    },
    from: (table: string) => fakeDb.client.from(table),
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

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    activeSession = null;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("/api/account/status")) {
        const userId = activeSession?.user?.id;
        const completed = userId ? await checkAccountOnboardingCompleted(fakeDb.client, userId) : false;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            onboardingCompleted: completed,
            deletionPending: false,
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    activeSession = null;
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

describe("AuthCallbackPage completion-aware redirect (email + Google, every success branch)", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    activeSession = null;
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes("/api/account/status")) {
        const userId = activeSession?.user?.id;
        const completed = userId ? await checkAccountOnboardingCompleted(fakeDb.client, userId) : false;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            onboardingCompleted: completed,
            deletionPending: false,
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    activeSession = null;
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    window.history.replaceState(null, "", "/auth/callback");
    vi.useRealTimers();
    mockReplace.mockReset();
    mockUnsubscribe.mockReset();
    mockGetSession.mockReset();
    mockExchangeCodeForSession.mockReset();
    mockOnAuthStateChange.mockClear();
    fakeDb = createFakeSupabase();
  });

  function mountAt(url: string) {
    window.history.replaceState(null, "", url);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(AuthCallbackPage));
    });
  }

  async function settle() {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  }

  const session = (id: string) => ({ user: { id }, access_token: "t" });
  const pending = () => new Promise<never>(() => {});

  // Google OAuth and email PKCE links both land on /auth/callback?code=...; the provider only changes the label.
  for (const provider of ["email", "google"] as const) {
    it(`${provider} PKCE: a fresh identity goes to onboarding with the intended destination kept`, async () => {
      const user = fakeDb.signUp(`${provider}@example.test`);
      mockExchangeCodeForSession.mockResolvedValueOnce({ data: { session: session(user.id) }, error: null });
      mountAt("/auth/callback?code=c1&returnTo=%2Fjobs%2Fsaved");
      await settle();
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith("/onboarding?next=%2Fjobs%2Fsaved");
    });

    it(`${provider} PKCE: a completed account keeps its destination`, async () => {
      const user = fakeDb.signUp(`${provider}-done@example.test`);
      seedCompletedAccount(fakeDb, user.id);
      mockExchangeCodeForSession.mockResolvedValueOnce({ data: { session: session(user.id) }, error: null });
      mountAt("/auth/callback?code=c2&returnTo=%2Fjobs%2Fsaved");
      await settle();
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith("/jobs/saved");
    });
  }

  it("PKCE: soft-deleted rows of a partially deleted identity never count as completed", async () => {
    const user = fakeDb.signUp("partial@example.test");
    fakeDb.insert("candidate_profiles", { user_id: user.id, confirmed_at: "2026-11-01", skills: ["x"], deleted_at: "2026-11-20" });
    fakeDb.insert("user_preferences", { user_id: user.id, onboarding_completed: true, deleted_at: "2026-11-20" });
    mockExchangeCodeForSession.mockResolvedValueOnce({ data: { session: session(user.id) }, error: null });
    mountAt("/auth/callback?code=c3");
    await settle();
    expect(mockReplace).toHaveBeenCalledWith("/onboarding?next=%2Fjobs");
    expect(fakeDb.rowsOf("profiles")).toEqual([]); // login never writes completion
  });

  it("PKCE: an unsafe returnTo is replaced by /jobs before the onboarding decision", async () => {
    const user = fakeDb.signUp("unsafe@example.test");
    mockExchangeCodeForSession.mockResolvedValueOnce({ data: { session: session(user.id) }, error: null });
    mountAt("/auth/callback?code=c4&returnTo=%2F%2Fevil.example");
    await settle();
    expect(mockReplace).toHaveBeenCalledWith("/onboarding?next=%2Fjobs");
  });

  it("PKCE error still goes to /login with the error and never checks onboarding", async () => {
    mockExchangeCodeForSession.mockResolvedValueOnce({ data: { session: null }, error: { message: "bad code" } });
    mountAt("/auth/callback?code=bad");
    await settle();
    expect(mockReplace).toHaveBeenCalledWith("/login?error=bad%20code");
    expect(fakeDb.calls).toEqual([]);
  });

  it("auth-state SIGNED_IN: no Supabase query runs inside the listener, one navigation to onboarding", async () => {
    const user = fakeDb.signUp("event@example.test");
    mockGetSession.mockReturnValueOnce(pending());
    mountAt("/auth/callback#access_token=a&refresh_token=r");
    const listener = (mockOnAuthStateChange.mock.calls[0] as unknown as [(e: string, s: unknown) => void])[0];
    act(() => listener("SIGNED_IN", session(user.id)));
    expect(fakeDb.calls).toEqual([]); // deferred out of the callback
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await settle();
    act(() => listener("TOKEN_REFRESHED", session(user.id)));
    await settle();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/onboarding?next=%2Fjobs");
  });

  it("existing-session fallback: a fresh identity goes to onboarding, a completed one to its destination", async () => {
    const fresh = fakeDb.signUp("existing-fresh@example.test");
    mockGetSession.mockResolvedValueOnce({ data: { session: session(fresh.id) } });
    mountAt("/auth/callback?returnTo=%2Fprofile");
    await settle();
    expect(mockReplace).toHaveBeenLastCalledWith("/onboarding?next=%2Fprofile");

    act(() => root!.unmount());
    root = null;
    mockReplace.mockReset();
    const done = fakeDb.signUp("existing-done@example.test");
    seedCompletedAccount(fakeDb, done.id);
    mockGetSession.mockResolvedValueOnce({ data: { session: session(done.id) } });
    mountAt("/auth/callback?returnTo=%2Fprofile");
    await settle();
    expect(mockReplace).toHaveBeenCalledWith("/profile");
  });

  it("hash/magic link: the delayed session check applies the onboarding rule", async () => {
    vi.useFakeTimers();
    const user = fakeDb.signUp("magic@example.test");
    mockGetSession
      .mockResolvedValueOnce({ data: { session: null } })
      .mockResolvedValueOnce({ data: { session: session(user.id) } });
    mountAt("/auth/callback#access_token=a&refresh_token=r");
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    await settle();
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith("/onboarding?next=%2Fjobs");
  });

  it("unmount while the onboarding check is pending: no navigation", async () => {
    const user = fakeDb.signUp("cancel@example.test");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realFrom = fakeDb.client.from;
    fakeDb.client.from = (t: string) => {
      const b = realFrom(t);
      const ms = b.maybeSingle;
      b.maybeSingle = async () => {
        await gate;
        return ms();
      };
      return b;
    };
    mockExchangeCodeForSession.mockResolvedValueOnce({ data: { session: session(user.id) }, error: null });
    mountAt("/auth/callback?code=c5");
    await settle();
    act(() => root!.unmount());
    root = null;
    release();
    await settle();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
