// @vitest-environment jsdom
// CM mobile item 8: work authorization UI -> API -> store -> reload -> Settings, against an in-memory store.
// MOCK COVERAGE ONLY (stateful fake Supabase, no real database). The real onboarding route handler,
// getUserPreferences / saveUserPreferences and the real Settings page run unchanged.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createFakeSupabase } from "@/lib/auth/__tests__/fakeSupabase";

let fakeDb = createFakeSupabase();
let user: { id: string; email: string } | null = null;

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    ...fakeDb.client,
    auth: {
      ...fakeDb.client.auth,
      getSession: async () => ({ data: { session: user ? { access_token: user.id, user } : null }, error: null }),
    },
  }),
}));
vi.mock("@/lib/ai/serviceHandler", () => ({ getSupabaseAdminClient: () => fakeDb.client }));
vi.mock("@/lib/auth/onboarding", () => ({
  markAccountOnboardingCompleted: vi.fn(async () => {}),
  checkAccountOnboardingCompleted: vi.fn(async () => true),
}));
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => undefined }));
vi.mock("@/lib/auth/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/session")>("@/lib/auth/session");
  return { ...actual, getAuthUser: async () => user };
});
vi.mock("@/lib/billing/subscription", () => ({ getUserSubscription: async () => null, cancelAutoRenewSubscription: vi.fn() }));
vi.mock("@/lib/resume/storage", () => ({ getCandidateProfile: async () => null, deleteCandidateProfile: vi.fn() }));
vi.mock("@/lib/tracker/storage", () => ({ getTrackedApplications: async () => [] }));
// Stable router object, like Next (Settings effects depend on it).
const router = vi.hoisted(() => ({ replace: () => {}, push: () => {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
}));
vi.mock("@/components/shell/LoggedInAppShell", () => ({ default: ({ children }: { children?: any }) => children }));
vi.mock("@/components/shell/AppIconRail", () => ({ default: () => null }));
vi.mock("@/components/shell/AppTopBar", () => ({ default: () => null }));
vi.mock("@/components/GuideHeader", () => ({ default: () => null }));
vi.mock("@/components/PaywallModal", () => ({ default: () => null }));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: toastMock }));
vi.mock("@/config/onboarding", () => ({ isOnboardingStep2EnabledClient: () => false }));

import SettingsPage from "@/app/settings/page";
import OnboardingStep1 from "@/components/onboarding/OnboardingStep1";
import { POST } from "@/app/api/onboarding/route";

const A = "I am authorized to work without sponsorship.";
const S = "I need visa sponsorship.";
const O = "I have another work permit or authorization.";
const LABEL = { 1: A, 2: S, 3: O } as const;

const stored = () => fakeDb.rowsOf("user_preferences")[0] ?? null;

/** Real Step 1 UI: taps the given options and returns the value the page would send. */
function chooseInStep1(taps: (1 | 2 | 3)[]): string {
  let value = "";
  function Harness() {
    const [workAuth, setWorkAuth] = React.useState("");
    value = workAuth;
    return (
      <OnboardingStep1
        roles={["Data Analyst"]}
        onToggleRole={() => {}}
        onRemoveRole={() => {}}
        employmentTypes={["contract"]}
        onToggleEmploymentType={() => {}}
        country="India"
        onSelectCountry={() => {}}
        openToRemote
        onToggleOpenToRemote={() => {}}
        workAuth={workAuth}
        onSelectWorkAuth={setWorkAuth}
        onNext={() => {}}
      />
    );
  }
  const view = render(<Harness />);
  for (const t of taps) fireEvent.click(screen.getAllByRole("button", { name: LABEL[t] })[0]);
  view.unmount();
  return value;
}

async function postOnboarding(workAuth: unknown) {
  const res = await POST(
    new Request("http://localhost/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user!.id}` },
      body: JSON.stringify({ roles: ["Data Analyst"], employmentTypes: ["contract", "internship"], country: "IN", workAuth }),
    }) as any
  );
  return res.status;
}

/** Reload: a fresh Settings mount that reads preferences back from the store. */
async function openSettings() {
  cleanup();
  localStorage.clear();
  render(<SettingsPage />);
  await waitFor(() => expect(screen.getByRole("group", { name: "Work Authorization" })).toBeTruthy());
  await act(async () => {});
}
const box = (label: string) => screen.getByRole("checkbox", { name: label }) as HTMLInputElement;
const checked = () => [A, S, O].filter((l) => box(l).checked);
const save = async () => {
  fireEvent.click(screen.getByRole("button", { name: /Save Preferences|Saving/ }));
  await act(async () => {});
};

beforeEach(() => {
  fakeDb = createFakeSupabase();
  user = fakeDb.signUp("fixture@example.invalid") as any;
  localStorage.clear();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});
afterEach(() => cleanup());

describe("work authorization roundtrip: onboarding UI -> API -> store -> reload -> Settings", () => {
  it.each([
    [[1], [A], A],
    [[2], [S], S],
    [[3], [O], O],
    [[2, 3], [S, O], `${S} + ${O}`],
  ] as const)("taps %j persist canonically and reload checked in Settings", async (taps, expected, canonical) => {
    const value = chooseInStep1([...taps]);
    expect(await postOnboarding(value)).toBe(200);
    expect(stored().work_auth).toBe(canonical);
    await openSettings();
    expect(checked()).toEqual(expected);
  });

  it.each([
    ["mixed 1 + 2", `${A} + ${S}`],
    ["unknown option", "Citizen of Mars"],
    ["empty (completion without a choice)", ""],
    ["wrong type: number", 1],
    ["wrong type: array", ["authorized"]],
    ["wrong type: null", null],
  ])("API rejects %s and the store is untouched", async (_n, bad) => {
    expect(await postOnboarding(S)).toBe(200);
    expect(await postOnboarding(bad)).toBe(400);
    expect(stored().work_auth).toBe(S);
  });
});

describe("Settings edits and saves work authorization", () => {
  it("toggle 2/3, exclusive 1, save, reload: every step round-trips and job types are kept", async () => {
    expect(await postOnboarding(`${S} + ${O}`)).toBe(200);
    await openSettings();
    expect(checked()).toEqual([S, O]);

    fireEvent.click(box(O)); // {2,3} -> {2}
    await save();
    expect(stored().work_auth).toBe(S);
    await openSettings();
    expect(checked()).toEqual([S]);

    fireEvent.click(box(O)); // {2} -> {2,3}
    fireEvent.click(box(A)); // 1 is exclusive -> {1}
    expect(checked()).toEqual([A]);
    await save();
    await openSettings();
    expect(checked()).toEqual([A]);
    expect(stored().work_auth).toBe(A);
    // Settings does not overwrite the onboarding job types with a made-up value.
    expect(stored().employment_types).toEqual(["contract", "internship"]);
  });

  it("legacy wording parses into the right options and is saved back in canonical form", async () => {
    fakeDb.insert("user_preferences", {
      user_id: user!.id,
      roles: ["Data Analyst"],
      employment_types: ["full-time"],
      work_auth: "Requires visa sponsorship (e.g. H1B) + Other / Work Permit",
      deleted_at: null,
    });
    await openSettings();
    expect(checked()).toEqual([S, O]);
    fireEvent.click(box(O));
    fireEvent.click(box(O));
    await save();
    expect(stored().work_auth).toBe(`${S} + ${O}`);
  });

  it("no invented default: a legacy 'Authorized' seed shows nothing checked and cannot be saved until chosen", async () => {
    fakeDb.insert("user_preferences", { user_id: user!.id, roles: ["Data Analyst"], employment_types: ["full-time"], work_auth: "Authorized", deleted_at: null });
    await openSettings();
    expect(checked()).toEqual([]);
    await save();
    expect(screen.getByRole("alert").textContent).toBe("Choose your work authorization before saving.");
    expect(stored().work_auth).toBe("Authorized");
    expect(fakeDb.calls.filter((c) => c === "upsert:user_preferences")).toHaveLength(0);

    fireEvent.click(box(S));
    expect(screen.queryByRole("alert")).toBeNull();
    await save();
    expect(stored().work_auth).toBe(S);
  });

  it("clearing every option is rejected (empty completion) and nothing is written", async () => {
    expect(await postOnboarding(S)).toBe(200);
    await openSettings();
    fireEvent.click(box(S));
    expect(checked()).toEqual([]);
    const upserts = fakeDb.calls.filter((c) => c === "upsert:user_preferences").length;
    await save();
    expect(screen.getByRole("alert").textContent).toContain("Choose your work authorization");
    expect(fakeDb.calls.filter((c) => c === "upsert:user_preferences").length).toBe(upserts);
    expect(stored().work_auth).toBe(S);
  });

  it("failed save: error shown, the edited choice stays on screen, the store keeps the old value, retry works", async () => {
    expect(await postOnboarding(S)).toBe(200);
    await openSettings();
    fireEvent.click(box(O)); // {2,3}
    fakeDb.setFailTable("user_preferences", { code: "57014", message: "FIXTURE: statement timeout" });
    await save();
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(checked()).toEqual([S, O]);
    fakeDb.setFailTable("user_preferences", null);
    expect(stored().work_auth).toBe(S);

    await save();
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    expect(stored().work_auth).toBe(`${S} + ${O}`);
  });
});
