import { beforeEach, describe, expect, it } from "vitest";
import { handleAccountDeleteRequest } from "@/lib/account/deleteHandler";
import { checkAccountOnboardingCompleted, resolvePostAuthDestination } from "@/lib/auth/onboarding";
import { createFakeSupabase, seedCompletedAccount } from "@/lib/auth/__tests__/fakeSupabase";
import { getUserPreferences, saveUserPreferences } from "@/lib/auth/session";
import { emptyUserPreferences } from "@/lib/auth/types";

/*
 * MOCK COVERAGE: the deletion handler and the onboarding rule run for real against a stateful local
 * Supabase stub (tables, auth users, profiles cascade). Real Supabase Auth, RLS, storage and the
 * Google provider are not exercised; "Google" here is a fresh identity created by the stub, the same
 * as an OAuth sign-up for that email would create after the old identity is gone.
 */

type Db = ReturnType<typeof createFakeSupabase>;

async function deleteAccount(db: Db, userId: string, bodyJson?: any) {
  const req = new Request("http://localhost/api/account/delete", {
    method: "POST",
    headers: { authorization: `Bearer ${userId}`, "content-type": "application/json" },
    body: bodyJson ? JSON.stringify(bodyJson) : undefined,
  });
  const res = await handleAccountDeleteRequest(req, { getSupabaseAdmin: () => db.client });
  return { status: res.status, body: await res.json() };
}

describe("account deletion contract", () => {
  beforeEach(() => {
    (globalThis as any).__mockSentry = { captureMessage: () => {} };
  });
  it("success: data cleaned, Auth identity deleted last, success=true", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("ok@example.test");
    seedCompletedAccount(db, user.id);

    const { status, body } = await deleteAccount(db, user.id);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(db.hasUser(user.id)).toBe(false);
    expect(db.calls.at(-1)).toBe("auth.deleteUser");
    expect(db.calls.indexOf("delete:profiles")).toBeLessThan(db.calls.indexOf("update:candidate_profiles"));
    expect(db.rowsOf("profiles")).toEqual([]);
    expect(db.rowsOf("user_preferences")[0].deleted_at).toBeTruthy(); // retention window kept (soft delete)
  });

  it("row cleanup failure: 500, success=false, Auth identity kept, and the survivor is not onboarded", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("cleanup@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("resumes", { code: "XX000", message: "internal error" });

    const { status, body } = await deleteAccount(db, user.id);
    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(db.calls).not.toContain("auth.deleteUser");
    expect(db.hasUser(user.id)).toBe(true);
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
    expect(await resolvePostAuthDestination(db.client, user.id, "/jobs")).toBe("/onboarding?next=%2Fjobs");
  });

  it("profiles cleanup failure is reported, not swallowed", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("profiles@example.test");
    db.setFailTable("profiles", { code: "XX000", message: "internal error" });
    const { status, body } = await deleteAccount(db, user.id);
    expect(status).toBe(500);
    expect(body.error).toContain("profiles");
    expect(db.calls).not.toContain("auth.deleteUser");
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
  });

  it("storage listing failure (previously skipped silently) blocks success", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("storage@example.test");
    db.client.storage.from = () => ({
      list: async () => ({ data: null, error: { message: "list failed" } }),
      remove: async () => ({ error: null }),
    }) as any;
    const { status, body } = await deleteAccount(db, user.id);
    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toContain("storage.resumes");
    expect(db.calls).not.toContain("auth.deleteUser");
    expect(await resolvePostAuthDestination(db.client, user.id, "/jobs")).toBe("/onboarding?next=%2Fjobs");
    expect(await resolvePostAuthDestination(db.client, user.id, "/jobs")).toBe("/onboarding?next=%2Fjobs");
  });

  it("billing reconciliation failure stops before tombstoning or deleting account data", async () => {
    const db = createFakeSupabase({ failTables: { subscriptions: { code: "XX000", message: "billing unavailable" } } });
    const user = db.signUp("billing@example.test");
    seedCompletedAccount(db, user.id);
    const result = await deleteAccount(db, user.id);
    expect(result.status).toBe(500);
    expect(result.body.success).toBe(false);
    expect(db.rowsOf("deleted_account_tombstones")).toEqual([]);
    expect(db.hasUser(user.id)).toBe(true);
    expect(db.rowsOf("profiles")).toHaveLength(1);
  });

  it("tombstone write failure stops before any destructive cleanup", async () => {
    const db = createFakeSupabase({ failTables: { deleted_account_tombstones: { code: "42P01", message: "tombstone migration unavailable" } } });
    const user = db.signUp("tombstone@example.test");
    seedCompletedAccount(db, user.id);
    const result = await deleteAccount(db, user.id);
    expect(result.status).toBe(503);
    expect(result.body.success).toBe(false);
    expect(db.rowsOf("profiles")).toHaveLength(1);
    expect(db.calls).not.toContain("delete:profiles");
    expect(db.calls).not.toContain("auth.deleteUser");
  });

  for (const table of ["candidate_profiles", "user_preferences"]) {
    it(`${table} cleanup failure leaves a recoverable tombstone and cannot sign in as completed`, async () => {
      const db = createFakeSupabase();
      const user = db.signUp(`${table}@example.test`);
      seedCompletedAccount(db, user.id);
      db.setFailTable(table, { code: "XX000", message: "cleanup failed" });
      const result = await deleteAccount(db, user.id);
      expect(result.status).toBe(500);
      expect(result.body.success).toBe(false);
      expect(db.hasUser(user.id)).toBe(true);
      expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
      expect(await resolvePostAuthDestination(db.client, user.id, "/jobs")).toBe("/onboarding?next=%2Fjobs");
    });
  }

  it("a failed retry can be repeated after the cleanup dependency recovers", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("retry@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("resumes", { code: "XX000", message: "temporary failure" });
    expect((await deleteAccount(db, user.id)).status).toBe(500);
    db.setFailTable("resumes", null);
    expect((await deleteAccount(db, user.id)).body.success).toBe(true);
    expect(db.hasUser(user.id)).toBe(false);
  });

  it("bucket listing failure (previously ignored) blocks success", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("buckets@example.test");
    db.client.storage.listBuckets = async () => ({ data: null, error: { message: "forbidden" } }) as any;
    const { status, body } = await deleteAccount(db, user.id);
    expect(status).toBe(500);
    expect(body.error).toContain("storage.listBuckets");
    expect(db.calls).not.toContain("auth.deleteUser");
  });

  it("Auth-delete failure: 500, success=false, and the partially deleted identity is sent to onboarding", async () => {
    const db = createFakeSupabase({ authDeleteError: { message: "auth unavailable" } });
    const user = db.signUp("authfail@example.test");
    seedCompletedAccount(db, user.id);

    const { status, body } = await deleteAccount(db, user.id);
    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Failed to delete auth identity");
    expect(db.hasUser(user.id)).toBe(true);
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
    // Same identity signs in again: no profiles marker, soft-deleted rows ignored, nothing written.
    expect(await resolvePostAuthDestination(db.client, user.id, "/jobs")).toBe("/onboarding?next=%2Fjobs");
    expect(db.rowsOf("profiles")).toEqual([]);
  });
});

describe("delete -> fresh sign-up with the same email (stateful local stub)", () => {
  for (const provider of ["email", "google"] as const) {
    it(`${provider}: a new identity is created and onboarding is shown; a completed user is unaffected`, async () => {
      const db = createFakeSupabase();
      const email = `same-${provider}@example.test`;
      const old = db.signUp(email);
      seedCompletedAccount(db, old.id);
      const bystander = db.signUp(`other-${provider}@example.test`);
      seedCompletedAccount(db, bystander.id);

      expect((await deleteAccount(db, old.id)).body.success).toBe(true);

      const fresh = db.signUp(email); // signup stays allowed after deletion
      expect(fresh.id).not.toBe(old.id);
      expect(await resolvePostAuthDestination(db.client, fresh.id, "/jobs/saved")).toBe(
        "/onboarding?next=%2Fjobs%2Fsaved"
      );
      expect(await resolvePostAuthDestination(db.client, bystander.id, "/jobs/saved")).toBe("/jobs/saved");
      // Old soft-deleted rows stay for the retention window; login never restores or marks completion.
      expect(db.rowsOf("user_preferences").find((r) => r.user_id === old.id)?.deleted_at).toBeTruthy();
      expect(db.rowsOf("profiles").map((r) => r.user_id)).toEqual([bystander.id]);
    });
  }

  it("interrupted deletion recovery: user can cancel deletion to start fresh", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("cancel@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("resumes", { code: "XX000", message: "temporary error" });

    // Step 1: Deletion fails midway
    const delRes = await deleteAccount(db, user.id);
    expect(delRes.status).toBe(500);
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);

    // Step 2: Cancel interrupted deletion
    const cancelRes = await deleteAccount(db, user.id, { action: "cancel" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);
    expect(cancelRes.body.action).toBe("cancelled");
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(0);

    // Step 3: Account can now proceed cleanly to onboarding
    expect(await resolvePostAuthDestination(db.client, user.id, "/jobs")).toBe("/onboarding?next=%2Fjobs");
  });

  it("A1 regression: interrupted deletion with surviving profile resets profile on cancel and enforces fresh onboarding", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("surviving-profile@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("profiles", { code: "XX000", message: "profiles delete failed" });

    // Step 1: Deletion fails because profiles could not be deleted
    const delRes = await deleteAccount(db, user.id);
    expect(delRes.status).toBe(500);
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
    expect(db.rowsOf("profiles")).toHaveLength(1);

    // Step 2: Dependency recovers, user calls cancel
    db.setFailTable("profiles", null);
    const cancelRes = await deleteAccount(db, user.id, { action: "cancel" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);

    // Step 3: Old completed profiles row was reset (removed), user MUST NOT skip onboarding!
    expect(db.rowsOf("profiles")).toEqual([]);
    const completed = await checkAccountOnboardingCompleted(db.client, user.id);
    expect(completed).toBe(false);
    expect(await resolvePostAuthDestination(db.client, user.id, "/jobs")).toBe("/onboarding?next=%2Fjobs");
  });

  it("A2 regression: partial delete then cancel allows fresh onboarding save with readable fresh preferences", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("fresh-prefs@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("resumes", { code: "XX000", message: "temporary failure" });

    // Step 1: Deletion fails midway, soft-deleting user_preferences
    const delRes = await deleteAccount(db, user.id);
    expect(delRes.status).toBe(500);
    db.setFailTable("resumes", null);

    // Step 2: User cancels deletion
    const cancelRes = await deleteAccount(db, user.id, { action: "cancel" });
    expect(cancelRes.status).toBe(200);

    // Step 3: Fresh onboarding saves new answers
    await saveUserPreferences(
      {
        ...emptyUserPreferences(),
        roles: ["Staff Platform Engineer"],
        country: "United States",
        countryCode: "US",
        onboardingCompleted: true,
      },
      user.id,
      db.client
    );

    // Step 4: Fresh preferences are readable and NOT soft-deleted
    const prefs = await getUserPreferences(user.id, db.client);
    expect(prefs.roles).toEqual(["Staff Platform Engineer"]);
    expect(prefs.country).toBe("United States");
    expect(prefs.countryCode).toBe("US");
    expect(prefs.onboardingCompleted).toBe(true);
  });

  it("A1 safety: reset failure retains tombstone and keeps account truthfully blocked", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("reset-fail@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("resumes", { code: "XX000", message: "temporary failure" });

    // Step 1: Delete fails midway
    await deleteAccount(db, user.id);
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
    db.setFailTable("resumes", null);

    // Step 2: Cancel fails because resetting profiles fails
    db.setFailTable("profiles", { code: "XX000", message: "reset failed" });
    const cancelRes = await deleteAccount(db, user.id, { action: "cancel" });
    expect(cancelRes.status).toBe(500);
    expect(cancelRes.body.success).toBe(false);

    // Tombstone must be retained! Account remains deletion_pending!
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
  });

  it("A3 permissions: if tombstone DELETE gets 42501, UPDATE purged_at fallback succeeds", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("perm-fallback@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("resumes", { code: "XX000", message: "temporary failure" });

    // Step 1: Delete fails midway
    await deleteAccount(db, user.id);
    db.setFailTable("resumes", null);
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);

    // When deleting tombstone, simulate 42501
    const originalFrom = db.client.from.bind(db.client);
    db.client.from = (table: string) => {
      const builder = originalFrom(table);
      if (table === "deleted_account_tombstones") {
        builder.delete = () => ({
          eq: () => Promise.resolve({ error: { code: "42501", message: "permission denied for table" } }),
        });
      }
      return builder;
    };

    // Cancel must use UPDATE purged_at fallback and succeed
    const cancelRes = await deleteAccount(db, user.id, { action: "cancel" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);
    expect(db.rowsOf("deleted_account_tombstones")[0].purged_at).toBeTruthy();
  });

  it("realistic RLS permission: unprivileged authenticated client getting 42501 on tombstones is not falsely blocked", async () => {
    const db = createFakeSupabase({ role: "authenticated" });
    const user = db.signUp("client@example.test");
    seedCompletedAccount(db, user.id);

    // Authenticated role cannot select tombstones (42501), but completed account is still evaluated
    const completed = await checkAccountOnboardingCompleted(db.client, user.id);
    expect(completed).toBe(true);
  });

  it("purged marker reactivated: purged marker then new deletion failing at profiles cleanup leaves completion false", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("purged-marker@example.test");
    seedCompletedAccount(db, user.id);

    // Simulate an existing tombstone that was marked purged by the 42501 cancel fallback
    db.insert("deleted_account_tombstones", {
      user_id: user.id,
      email_hash: "hash",
      deletion_completed_at: new Date().toISOString(),
      hard_delete_after: new Date(Date.now() + 86400000).toISOString(),
      purged_at: new Date().toISOString(),
    });

    // Make profiles cleanup fail on new deletion
    db.setFailTable("profiles", { code: "XX000", message: "profiles cleanup failed" });

    // New deletion attempt
    const res = await deleteAccount(db, user.id);
    expect(res.status).toBe(500);

    // Tombstone must be reactivated with purged_at = null!
    const tombstone = db.rowsOf("deleted_account_tombstones")[0];
    expect(tombstone.purged_at).toBeNull();

    // Onboarding completion check MUST evaluate to false, not true
    const completed = await checkAccountOnboardingCompleted(db.client, user.id);
    expect(completed).toBe(false);
  });

  it("metadata reset failure: returns 500 and retains tombstone", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("meta-fail@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("resumes", { code: "XX000", message: "initial delete failure" });

    // Interrupted deletion creates tombstone
    await deleteAccount(db, user.id);
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
    db.setFailTable("resumes", null);

    // Metadata reset fails during cancel
    db.setAuthUpdateError({ message: "Auth admin service unavailable" });
    const cancelRes = await deleteAccount(db, user.id, { action: "cancel" });
    expect(cancelRes.status).toBe(500);
    expect(cancelRes.body.success).toBe(false);
    expect(cancelRes.body.error).toContain("Failed to reset auth user metadata");

    // Tombstone MUST be retained
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);
  });

  it("browser status lookup fails closed to /onboarding when getSession returns no token", async () => {
    const originalWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {};
      const fakeClient = {
        auth: {
          getSession: async () => ({ data: { session: null }, error: null }),
        },
      };
      const dest = await resolvePostAuthDestination(fakeClient as any, "user-browser-test", "/jobs");
      expect(dest).toBe("/onboarding?next=%2Fjobs");
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
    }
  });

  it("browser status lookup fails closed to /onboarding when status fetch throws (completed profile + hidden tombstone via 42501)", async () => {
    const originalWindow = (globalThis as any).window;
    const originalFetch = globalThis.fetch;
    try {
      (globalThis as any).window = {};
      // Status fetch throws (network error, DNS failure, etc.)
      globalThis.fetch = (async () => {
        throw new Error("Network connection reset");
      }) as any;

      // Authenticated role client: lacks SELECT grant on deleted_account_tombstones (42501)
      const db = createFakeSupabase({ role: "authenticated" });
      const user = db.signUp("hidden-tombstone@example.test");
      seedCompletedAccount(db, user.id);
      db.insert("deleted_account_tombstones", {
        user_id: user.id,
        email_hash: "hash",
        deletion_completed_at: new Date().toISOString(),
        hard_delete_after: new Date(Date.now() + 86400000).toISOString(),
        purged_at: null,
      });

      const client = {
        ...db.client,
        auth: {
          ...db.client.auth,
          getSession: async () => ({
            data: { session: { access_token: "browser-valid-token", user: { id: user.id } } },
            error: null,
          }),
        },
      };

      // Completed profile + pending tombstone hidden by 42501 + status fetch throws => must return /onboarding, not /jobs
      const dest = await resolvePostAuthDestination(client as any, user.id, "/jobs");
      expect(dest).toBe("/onboarding?next=%2Fjobs");
    } finally {
      if (originalWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = originalWindow;
      }
      globalThis.fetch = originalFetch;
    }
  });

  it("duplicate / retry deletion safely cleans up after previous partial failure", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("retry-user@example.test");
    seedCompletedAccount(db, user.id);
    db.setFailTable("resumes", { code: "XX000", message: "temporary storage glitch" });

    // First attempt fails at resumes
    const res1 = await deleteAccount(db, user.id);
    expect(res1.status).toBe(500);
    expect(db.hasUser(user.id)).toBe(true);
    expect(db.rowsOf("deleted_account_tombstones")).toHaveLength(1);

    // Resolve glitch and retry deletion
    db.setFailTable("resumes", null);
    const res2 = await deleteAccount(db, user.id);
    expect(res2.status).toBe(200);
    expect(res2.body.success).toBe(true);
    expect(db.hasUser(user.id)).toBe(false);
  });

  it("concurrent deletion: multiple simultaneous delete requests handle state safely", async () => {
    const db = createFakeSupabase();
    const user = db.signUp("concurrent-user@example.test");
    seedCompletedAccount(db, user.id);

    const [res1, res2] = await Promise.all([
      deleteAccount(db, user.id),
      deleteAccount(db, user.id),
    ]);

    // Both requests finish cleanly; at least one returns 200 success
    expect([200, 401, 404, 500]).toContain(res1.status);
    expect([200, 401, 404, 500]).toContain(res2.status);
    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(200);
    expect(db.hasUser(user.id)).toBe(false);
  });
});

describe("getUserPreferences independent column compatibility", () => {
  it("preserves country when deleted_at alone is absent (schema before 20261106h)", async () => {
    const db = createFakeSupabase({ missingDeletedAt: ["user_preferences"] });
    const user = db.signUp("country@example.test");
    db.insert("user_preferences", {
      user_id: user.id,
      country: "India",
      country_code: "IN",
      onboarding_completed: true,
      roles: ["Engineer"],
    });

    const prefs = await getUserPreferences(user.id, db.client);
    expect(prefs.country).toBe("India");
    expect(prefs.countryCode).toBe("IN");
    expect(prefs.roles).toEqual(["Engineer"]);
  });
});
