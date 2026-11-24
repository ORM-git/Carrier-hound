// @vitest-environment jsdom
// CM mobile item 3: the real /login, /signup and /auth/reset-password form handlers against a spy Supabase SDK.
// MOCK COVERAGE ONLY: proves our handlers, messages and routing. Real GoTrue behaviour (sign-up, verification
// e-mail, reset e-mail, rate limits, Google-only identities) remains an OWNER LIVE CHECK.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push }) }));
vi.mock("next/link", () => ({ default: (p: any) => React.createElement("a", { ...p, href: p.href }, p.children) }));
vi.mock("@/components/GuideHeader", () => ({ default: () => null }));
vi.mock("@/components/Footer", () => ({ default: () => null }));
vi.mock("@/lib/analytics/funnel", () => ({ trackFunnelEvent: vi.fn() }));

let signedInUser: { id: string } | null = null;
vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { ...actual, getAuthUser: async () => signedInUser };
});
vi.mock("@/lib/auth/onboarding", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/onboarding")>("@/lib/auth/onboarding");
  // Completed vs new onboarding routing after sign-in is decided by /auth/callback (covered in its own tests);
  // here the already-signed-in redirect only needs a deterministic answer.
  return { ...actual, resolvePostAuthDestination: async (_s: unknown, _id: unknown, dest: string) => dest };
});

// Spy SDK: every auth method a page could call. Methods that must never be used throw if called.
const auth = {
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  resend: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
  signInWithOAuth: vi.fn(async () => ({ data: {}, error: null })),
  signInWithOtp: vi.fn(),
  linkIdentity: vi.fn(),
  verifyOtp: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe() {} } } })),
};
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth }) }));

import LoginPage from "@/app/login/page";
import SignupPage from "@/app/signup/page";
import ResetPasswordPage from "@/app/auth/reset-password/page";

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
const err = (code: string, status = 400, message = code) => ({ data: { user: null, session: null }, error: { code, status, message } });
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

async function mount(el: React.ReactElement, url: string) {
  window.history.replaceState(null, "", url);
  render(el);
  await act(async () => {});
}
const typeInto = (id: string, value: string) => fireEvent.change(document.getElementById(id)!, { target: { value } });
const submit = (testid: string) => fireEvent.click(screen.getByTestId(testid).querySelector('button[type="submit"]')!);
const banner = () => screen.queryByTestId("auth-error-banner")?.textContent?.trim() ?? null;
const forbiddenCalls = () => [auth.signInWithOtp, auth.linkIdentity, auth.verifyOtp].map((f) => f.mock.calls.length).reduce((a, b) => a + b, 0);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  signedInUser = null;
  for (const f of Object.values(auth)) (f as any).mockClear?.();
  auth.getSession.mockImplementation(async () => ({ data: { session: null }, error: null }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  replace.mockReset();
  push.mockReset();
  fetchMock.mockClear();
});

describe("/login password sign-in", () => {
  it("valid password: one SDK call with the trimmed email, then the shared callback with the safe returnTo", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { session: { access_token: "x" } }, error: null });
    await mount(<LoginPage />, "/login?returnTo=%2Fjobs%2Fsaved");
    typeInto("login-email", "  user@example.test ");
    typeInto("login-password", "correct-horse");
    submit("login-auth-card");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/callback?returnTo=%2Fjobs%2Fsaved"));
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(auth.signInWithPassword).toHaveBeenCalledWith({ email: "user@example.test", password: "correct-horse" });
    // Telemetry goes to our own endpoint only, and never carries the password.
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe("/api/auth/security-event");
    expect(String(init.body)).not.toContain("correct-horse");
    expect(forbiddenCalls()).toBe(0);
  });

  it("unsafe returnTo falls back to /jobs", async () => {
    auth.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
    await mount(<LoginPage />, "/login?returnTo=https%3A%2F%2Fevil.example%2Fsteal");
    typeInto("login-email", "user@example.test");
    typeInto("login-password", "pw-123456");
    submit("login-auth-card");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/callback?returnTo=%2Fjobs"));
  });

  it.each([
    ["invalid password", err("invalid_credentials", 400, "Invalid login credentials"), "Incorrect email or password. If you joined with Google, use Continue with Google."],
    // A Google-only identity has no password: GoTrue answers exactly like a wrong password, so we cannot and do not reveal it.
    ["Google-only identity", err("invalid_credentials", 400, "Invalid login credentials"), "Incorrect email or password. If you joined with Google, use Continue with Google."],
    ["unknown e-mail (privacy: same message)", err("user_not_found", 400, "Invalid login credentials"), "Incorrect email or password. If you joined with Google, use Continue with Google."],
    ["unverified e-mail", err("email_not_confirmed", 400, "Email not confirmed"), "Please verify your email first. Check your inbox for the verification link."],
    ["rate limited", err("over_request_rate_limit", 429, "rate limit"), "Too many attempts. Please wait a few minutes and try again."],
    ["e-mail provider disabled", err("email_provider_disabled", 400), "Email sign-in is not available right now. Please continue with Google."],
  ])("%s: stays on /login with a clear message, no reset/link/OTP side effects", async (_n, response, message) => {
    auth.signInWithPassword.mockResolvedValue(response);
    await mount(<LoginPage />, "/login");
    typeInto("login-email", "user@example.test");
    typeInto("login-password", "some-password");
    submit("login-auth-card");
    await waitFor(() => expect(banner()).toBe(message));
    expect(replace).not.toHaveBeenCalled();
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(forbiddenCalls()).toBe(0);
    // Editing a field clears the error so the next attempt starts clean.
    typeInto("login-password", "another-password");
    expect(banner()).toBeNull();
  });

  it("network failure shows the generic message and re-enables the button", async () => {
    auth.signInWithPassword.mockRejectedValue(new TypeError("Failed to fetch"));
    await mount(<LoginPage />, "/login");
    typeInto("login-email", "user@example.test");
    typeInto("login-password", "pw-123456");
    submit("login-auth-card");
    await waitFor(() => expect(banner()).toMatch(/Incorrect email or password/));
    expect((screen.getByTestId("login-auth-card").querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it("pending: button locks with 'Signing in…' and a double submit sends one request", async () => {
    const d = deferred<any>();
    auth.signInWithPassword.mockReturnValue(d.promise);
    await mount(<LoginPage />, "/login");
    typeInto("login-email", "user@example.test");
    typeInto("login-password", "pw-123456");
    submit("login-auth-card");
    const btn = screen.getByTestId("login-auth-card").querySelector('button[type="submit"]') as HTMLButtonElement;
    await waitFor(() => expect(btn.textContent).toBe("Signing in…"));
    expect(btn.disabled).toBe(true);
    submit("login-auth-card");
    expect(auth.signInWithPassword).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve(err("invalid_credentials")));
  });

  it("empty or malformed input is rejected before any SDK call", async () => {
    await mount(<LoginPage />, "/login");
    typeInto("login-email", "not-an-email");
    typeInto("login-password", "pw");
    submit("login-auth-card");
    expect(banner()).toBe("Please enter a valid email address.");
    typeInto("login-email", "user@example.test");
    typeInto("login-password", "");
    submit("login-auth-card");
    expect(banner()).toBe("Please enter your password.");
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it("is a password form, not OTP relabelled: a password field and 'Sign in', no code field", async () => {
    await mount(<LoginPage />, "/login");
    expect((document.getElementById("login-password") as HTMLInputElement).type).toBe("password");
    expect(screen.getByTestId("login-auth-card").textContent).not.toMatch(/one-time|magic link|verification code|OTP/i);
  });

  it("forgot password: neutral confirmation (no account enumeration), reset link via the callback, rate limit message", async () => {
    auth.resetPasswordForEmail.mockResolvedValueOnce({ data: {}, error: null });
    await mount(<LoginPage />, "/login");
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(document.getElementById("login-password")).toBeNull();
    typeInto("login-email", "maybe@example.test");
    submit("login-auth-card");
    await waitFor(() => expect(screen.getByTestId("auth-email-sent").textContent).toContain("If an account exists for maybe@example.test"));
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("maybe@example.test", {
      redirectTo: expect.stringMatching(/\/auth\/callback\?returnTo=%2Fauth%2Freset-password$/),
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();

    // Resend is rate-limited by GoTrue: the message says so and stays in the sent state.
    cleanup();
    auth.resetPasswordForEmail.mockResolvedValueOnce(err("over_email_send_rate_limit", 429));
    await mount(<LoginPage />, "/login");
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    typeInto("login-email", "maybe@example.test");
    submit("login-auth-card");
    await waitFor(() => expect(banner()).toBe("Too many attempts. Please wait a few minutes and try again."));
  });

  it("an error passed back by /auth/callback is shown as text (escaped), not markup", async () => {
    await mount(<LoginPage />, "/login?error=%3Cb%3Ebold%3C%2Fb%3E%20expired");
    expect(banner()).toBe("<b>bold</b> expired");
    expect(screen.getByTestId("auth-error-banner").querySelector("b")).toBeNull();
  });
});

describe("/signup password sign-up", () => {
  it("short password is rejected client-side with no SDK call", async () => {
    await mount(<SignupPage />, "/signup");
    typeInto("signup-email", "new@example.test");
    typeInto("signup-password", "short");
    submit("signup-auth-card");
    expect(banner()).toBe("Use at least 8 characters for your password.");
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it("verification required: check-your-inbox, password cleared, resend uses the signup type; no auto sign-in", async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: "u1" }, session: null }, error: null });
    auth.resend.mockResolvedValue({ data: {}, error: null });
    await mount(<SignupPage />, "/signup?next=%2Fjobs%2Fsaved");
    typeInto("signup-email", "new@example.test");
    typeInto("signup-password", "long-enough-pw");
    submit("signup-auth-card");
    await waitFor(() => expect(screen.getByTestId("auth-email-sent")).toBeTruthy());
    expect(auth.signUp).toHaveBeenCalledWith({
      email: "new@example.test",
      password: "long-enough-pw",
      options: { emailRedirectTo: expect.stringMatching(/\/auth\/callback\?returnTo=%2Fjobs%2Fsaved$/) },
    });
    expect(replace).not.toHaveBeenCalled();
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(forbiddenCalls()).toBe(0);
  });

  it("confirmation off (session returned): one navigation through the shared callback (new account -> onboarding there)", async () => {
    auth.signUp.mockResolvedValue({ data: { user: { id: "u1" }, session: { access_token: "x" } }, error: null });
    await mount(<SignupPage />, "/signup");
    typeInto("signup-email", "new@example.test");
    typeInto("signup-password", "long-enough-pw");
    submit("signup-auth-card");
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/callback?returnTo=%2Fonboarding"));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["existing account (privacy)", err("user_already_exists"), "We couldn't create an account with this email. If you already have one, sign in instead."],
    ["weak password (server policy)", err("weak_password"), "Choose a stronger password (at least 8 characters, not a common one)."],
    ["rate limited", err("over_email_send_rate_limit", 429), "Too many attempts. Please wait a few minutes and try again."],
    ["signups disabled", err("signup_disabled"), "Email sign-in is not available right now. Please continue with Google."],
  ])("%s", async (_n, response, message) => {
    auth.signUp.mockResolvedValue(response);
    await mount(<SignupPage />, "/signup");
    typeInto("signup-email", "new@example.test");
    typeInto("signup-password", "long-enough-pw");
    submit("signup-auth-card");
    await waitFor(() => expect(banner()).toBe(message));
    expect(screen.queryByTestId("auth-email-sent")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it.each([
    ["/signup?next=%2Fprofile", "/profile"],
    ["/signup?next=https%3A%2F%2Fevil.example", "/onboarding"],
  ])("an already signed-in visitor at %s is sent on once, to %s", async (url, target) => {
    signedInUser = { id: "u-done" };
    await mount(<SignupPage />, url);
    await waitFor(() => expect(replace).toHaveBeenCalled());
    await act(async () => {});
    expect(replace.mock.calls).toEqual([[target]]);
  });
});

describe("/auth/reset-password", () => {
  it("expired or missing recovery session: no form, a way back to sign in, no update call", async () => {
    await mount(<ResetPasswordPage />, "/auth/reset-password");
    await waitFor(() => expect(screen.getByText(/invalid or has expired/)).toBeTruthy());
    expect(document.getElementById("reset-password")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("valid recovery session: validates length, saves once, then the shared callback to /jobs", async () => {
    auth.getSession.mockImplementation(async () => ({ data: { session: { access_token: "recovery" } }, error: null }) as any);
    auth.updateUser.mockResolvedValue({ data: {}, error: null });
    await mount(<ResetPasswordPage />, "/auth/reset-password");
    await waitFor(() => expect(document.getElementById("reset-password")).toBeTruthy());
    typeInto("reset-password", "short");
    fireEvent.click(screen.getByRole("button", { name: /Save password/ }));
    expect(screen.getByRole("alert").textContent).toContain("at least 8 characters");
    expect(auth.updateUser).not.toHaveBeenCalled();
    typeInto("reset-password", "a-new-long-password");
    fireEvent.click(screen.getByRole("button", { name: /Save password/ }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/auth/callback?returnTo=%2Fjobs"));
    expect(auth.updateUser).toHaveBeenCalledTimes(1);
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "a-new-long-password" });
  });

  it.each([
    ["same password", err("same_password"), "Your new password must be different from your current one."],
    ["session expired mid-way", err("session_expired", 401), "Could not update your password. Your reset link may have expired, so please request a new one."],
  ])("update error: %s", async (_n, response, message) => {
    auth.getSession.mockImplementation(async () => ({ data: { session: { access_token: "recovery" } }, error: null }) as any);
    auth.updateUser.mockResolvedValue(response);
    await mount(<ResetPasswordPage />, "/auth/reset-password");
    await waitFor(() => expect(document.getElementById("reset-password")).toBeTruthy());
    typeInto("reset-password", "a-new-long-password");
    fireEvent.click(screen.getByRole("button", { name: /Save password/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(message));
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("owner item 3: no e-mail sign-in link on /login or /signup", () => {
  it.each([
    ["login", () => <LoginPage />, "/login", "login-auth-card", "Sign in"],
    ["signup", () => <SignupPage />, "/signup", "signup-auth-card", "Sign up"],
  ])("%s offers only Continue with Google and email + password", async (_n, el, url, card, submitLabel) => {
    await mount(el(), url);
    const root = screen.getByTestId(card);
    expect(root.textContent).not.toMatch(/sign-in link|magic link|email me a link|one-time code/i);
    const buttons = Array.from(root.querySelectorAll("button")).map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim());
    expect(buttons).toContain("Continue with Google");
    expect(buttons).toContain(submitLabel);
    expect(root.querySelector('input[type="email"]')).toBeTruthy();
    expect(root.querySelector('input[type="password"]')).toBeTruthy();
    for (const b of buttons) expect(b).not.toMatch(/link/i);
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
  });
});
