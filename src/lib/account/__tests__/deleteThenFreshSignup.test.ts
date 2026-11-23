import { describe, expect, it } from "vitest";
import { handleAccountDeleteRequest } from "@/lib/account/deleteHandler";
import { resolvePostAuthDestination } from "@/lib/auth/onboarding";
import { createFakeSupabase, seedCompletedAccount } from "@/lib/auth/__tests__/fakeSupabase";

/*
 * MOCK COVERAGE: the deletion handler and the onboarding rule run for real against a stateful local
 * Supabase stub (tables, auth users, profiles cascade). Real Supabase Auth, RLS, storage and the
 * Google provider are not exercised; "Google" here is a fresh identity created by the stub, the same
 * as an OAuth sign-up for that email would create after the old identity is gone.
 */

type Db = ReturnType<typeof createFakeSupabase>;

async function deleteAccount(db: Db, userId: string) {
  const req = new Request("http://localhost/api/account/delete", {
    method: "POST",
    headers: { authorization: `Bearer ${userId}` },
  });
  const res = await handleAccountDeleteRequest(req, { getSupabaseAdmin: () => db.client });
  return { status: res.status, body: await res.json() };
}

describe("account deletion contract", () => {
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
});
