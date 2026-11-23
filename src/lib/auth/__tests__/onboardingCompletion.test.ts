import { describe, expect, it } from "vitest";
import {
  checkAccountOnboardingCompleted,
  onboardingRedirectFor,
  resolvePostAuthDestination,
} from "@/lib/auth/onboarding";
import { createFakeSupabase, seedCompletedAccount } from "./fakeSupabase";

// Mock coverage: a stateful local stub, not real Supabase/PostgREST.
const writes = (db: ReturnType<typeof createFakeSupabase>) =>
  db.calls.filter((c) => !c.startsWith("select:"));

describe("checkAccountOnboardingCompleted", () => {
  it("completed account -> true, without writing anything", async () => {
    const db = createFakeSupabase();
    seedCompletedAccount(db, "u1");
    expect(await checkAccountOnboardingCompleted(db.client, "u1")).toBe(true);
    expect(writes(db)).toEqual([]);
  });

  it("fresh account (no rows) -> false", async () => {
    const db = createFakeSupabase();
    expect(await checkAccountOnboardingCompleted(db.client, "u-new")).toBe(false);
  });

  it("partial answers (preferences saved, onboarding_completed=false) -> false", async () => {
    const db = createFakeSupabase();
    db.insert("user_preferences", { user_id: "u2", onboarding_completed: false, roles: ["PM"], deleted_at: null });
    expect(await checkAccountOnboardingCompleted(db.client, "u2")).toBe(false);
  });

  it("legacy substantive profile still counts (read-only, no self-heal write)", async () => {
    const db = createFakeSupabase();
    db.insert("profiles", { user_id: "u3", full_name: "Legacy User", target_roles: [] });
    expect(await checkAccountOnboardingCompleted(db.client, "u3")).toBe(true);
    expect(writes(db)).toEqual([]);
    expect(db.rowsOf("profiles")[0].onboarding_completed_at).toBeUndefined();
  });

  it("soft-deleted candidate profile and preferences never count and are never healed into completion", async () => {
    const db = createFakeSupabase();
    db.insert("candidate_profiles", { user_id: "u4", confirmed_at: "2026-11-01", skills: ["a"], deleted_at: "2026-11-20" });
    db.insert("user_preferences", { user_id: "u4", onboarding_completed: true, deleted_at: "2026-11-20" });
    expect(await checkAccountOnboardingCompleted(db.client, "u4")).toBe(false);
    expect(writes(db)).toEqual([]);
    expect(db.rowsOf("profiles")).toEqual([]);
  });

  it("a stub that ignores the deleted_at filter still cannot leak a deleted row (row-level guard)", async () => {
    const db = createFakeSupabase();
    db.insert("user_preferences", { user_id: "u5", onboarding_completed: true, deleted_at: "2026-11-20" });
    const realFrom = db.client.from;
    db.client.from = (t: string) => {
      const b = realFrom(t);
      b.is = () => b; // drop the filter
      return b;
    };
    expect(await checkAccountOnboardingCompleted(db.client, "u5")).toBe(false);
  });

  it("missing deleted_at column (pre-migration) falls back to the unfiltered read for live rows only", async () => {
    const db = createFakeSupabase({ missingDeletedAt: ["user_preferences", "candidate_profiles"] });
    db.insert("user_preferences", { user_id: "u6", onboarding_completed: true });
    expect(await checkAccountOnboardingCompleted(db.client, "u6")).toBe(true);
    expect(db.calls.filter((c) => c === "select:user_preferences").length).toBe(2);
  });

  it("other schema/query errors are never treated as completion and never fall back", async () => {
    const db = createFakeSupabase({
      failTables: {
        profiles: { code: "42P01", message: "relation public.profiles does not exist" },
        candidate_profiles: { code: "42703", message: "column candidate_profiles.skills does not exist" },
        user_preferences: { code: "57014", message: "canceling statement due to statement timeout" },
      },
    });
    db.insert("user_preferences", { user_id: "u7", onboarding_completed: true, deleted_at: null });
    expect(await checkAccountOnboardingCompleted(db.client, "u7")).toBe(false);
    expect(db.calls.filter((c) => c === "select:user_preferences").length).toBe(1);
  });

  it("invalid input -> false", async () => {
    expect(await checkAccountOnboardingCompleted(null, "u")).toBe(false);
    expect(await checkAccountOnboardingCompleted(createFakeSupabase().client, "")).toBe(false);
  });
});

describe("resolvePostAuthDestination / onboardingRedirectFor", () => {
  it("completed keeps destination; not completed goes to onboarding with next kept", async () => {
    const db = createFakeSupabase();
    seedCompletedAccount(db, "done");
    expect(await resolvePostAuthDestination(db.client, "done", "/jobs/saved?x=1")).toBe("/jobs/saved?x=1");
    expect(await resolvePostAuthDestination(db.client, "fresh", "/jobs/saved?x=1")).toBe(
      "/onboarding?next=%2Fjobs%2Fsaved%3Fx%3D1"
    );
  });

  it("unknown user id goes to onboarding; an onboarding destination is not nested", async () => {
    const db = createFakeSupabase();
    expect(await resolvePostAuthDestination(db.client, undefined, "/jobs")).toBe("/onboarding?next=%2Fjobs");
    expect(onboardingRedirectFor("/onboarding?next=%2Fprofile")).toBe("/onboarding?next=%2Fprofile");
    expect(onboardingRedirectFor("/onboarding")).toBe("/onboarding");
  });
});
