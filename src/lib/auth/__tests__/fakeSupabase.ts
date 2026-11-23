/**
 * Stateful in-memory Supabase stub for onboarding and account-deletion tests.
 *
 * MOCK COVERAGE ONLY: this models the subset of PostgREST/Auth behaviour the code under test uses
 * (select/eq/is/maybeSingle, update/delete/upsert by user_id, auth.admin.deleteUser, sign-up of a
 * fresh identity). It does not prove real Supabase behaviour, RLS, cascades or triggers.
 */

type Row = Record<string, any>;
type DbError = { code?: string; message: string } | null;

export interface FakeDbOptions {
  /** Tables whose `deleted_at` column does not exist (pre-20261106h schema). */
  missingDeletedAt?: string[];
  /** Force an error for any operation on these tables. */
  failTables?: Record<string, DbError>;
  /** Force auth.admin.deleteUser to fail. */
  authDeleteError?: DbError;
  /** Role of client: 'service_role' (default for admin) or 'authenticated'/'anon' (RLS-restricted). */
  role?: "service_role" | "authenticated" | "anon";
}

export function createFakeSupabase(options: FakeDbOptions = {}) {
  const tables = new Map<string, Row[]>();
  const users = new Map<string, { id: string; email: string }>();
  const missingDeletedAt = new Set(options.missingDeletedAt || []);
  const failTables = { ...(options.failTables || {}) };
  let authDeleteError: DbError = options.authDeleteError ?? null;
  let nextId = 1;
  const idPrefix = Math.random().toString(36).slice(2, 8); // unique per instance: in-memory rate limits are keyed by user id
  const calls: string[] = [];

  const rows = (t: string) => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };
  const missingColumn = (t: string): DbError => ({
    code: "42703",
    message: `column ${t}.deleted_at does not exist`,
  });

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: "select" | "update" | "delete" = "select";
    let patch: Row = {};
    let usesDeletedAt = false;

    const run = (): { data: Row[]; error: DbError } => {
      calls.push(`${op}:${table}`);
      if (options.role && options.role !== "service_role" && table === "deleted_account_tombstones") {
        return { data: [], error: { code: "42501", message: "permission denied for table deleted_account_tombstones" } };
      }
      if (failTables[table]) return { data: [], error: failTables[table] };
      if (usesDeletedAt && missingDeletedAt.has(table)) return { data: [], error: missingColumn(table) };
      const matched = rows(table).filter((r) => filters.every((f) => f(r)));
      if (op === "update") matched.forEach((r) => Object.assign(r, patch));
      if (op === "delete") tables.set(table, rows(table).filter((r) => !matched.includes(r)));
      return { data: matched.map((r) => ({ ...r })), error: null };
    };

    const builder: any = {
      select(cols?: string) {
        if (cols && /\bdeleted_at\b/.test(cols)) usesDeletedAt = true;
        return builder;
      },
      eq(col: string, val: any) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      is(col: string, val: null) {
        if (col === "deleted_at") usesDeletedAt = true;
        filters.push((r) => (r[col] ?? null) === val);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      update(p: Row) {
        op = "update";
        patch = p;
        if ("deleted_at" in p) usesDeletedAt = true;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      async upsert(row: Row) {
        calls.push(`upsert:${table}`);
        if (failTables[table]) return { error: failTables[table] };
        const existing = rows(table).find((r) => r.user_id === row.user_id);
        if (existing) Object.assign(existing, row);
        else rows(table).push({ ...row });
        return { error: null };
      },
      async maybeSingle() {
        const { data, error } = run();
        return { data: error ? null : data[0] ?? null, error };
      },
      then(resolve: (v: { data: Row[]; error: DbError }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    from,
    auth: {
      admin: {
        async deleteUser(id: string) {
          calls.push(`auth.deleteUser`);
          if (authDeleteError) return { error: authDeleteError };
          users.delete(id);
          // Mirrors the FK on public.profiles(user_id) ... ON DELETE CASCADE (migration 20261114b).
          tables.set("profiles", rows("profiles").filter((r) => r.user_id !== id));
          return { error: null };
        },
      },
      async getUser(token: string) {
        const user = users.get(token) || null;
        return { data: { user }, error: user ? null : { message: "invalid token" } };
      },
    },
    storage: {
      async listBuckets() {
        return { data: [], error: null };
      },
      from: () => ({
        list: async () => ({ data: [], error: null }),
        remove: async () => ({ error: null }),
      }),
    },
  };

  return {
    client,
    calls,
    tables,
    insert(table: string, row: Row) {
      rows(table).push({ ...row });
    },
    rowsOf: (table: string) => rows(table).map((r) => ({ ...r })),
    /** Sign-up with an email: an existing identity is reused, otherwise a fresh id is created (Supabase semantics). */
    signUp(email: string) {
      const existing = Array.from(users.values()).find((u) => u.email === email);
      if (existing) return existing;
      const user = { id: `user-${idPrefix}-${nextId++}`, email };
      users.set(user.id, user);
      return user;
    },
    hasUser: (id: string) => users.has(id),
    setFailTable(table: string, error: DbError) {
      failTables[table] = error;
    },
    setAuthDeleteError(error: DbError) {
      authDeleteError = error;
    },
  };
}

/** A completed account: completion marker, legacy profile data, live candidate profile and preferences. */
export function seedCompletedAccount(db: ReturnType<typeof createFakeSupabase>, userId: string) {
  db.insert("profiles", {
    user_id: userId,
    onboarding_completed_at: "2026-11-01T00:00:00.000Z",
    full_name: "Test Person",
    target_roles: ["Engineer"],
  });
  db.insert("candidate_profiles", { user_id: userId, confirmed_at: "2026-11-01T00:00:00.000Z", skills: ["ts"], deleted_at: null });
  db.insert("user_preferences", { user_id: userId, onboarding_completed: true, deleted_at: null });
}
