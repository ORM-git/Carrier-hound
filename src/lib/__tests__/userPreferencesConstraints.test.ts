import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";
import { getUserPreferences, saveUserPreferences } from "../auth/session";
import { draftFromPreferences, preferencesFromDraft } from "../preferences/model";

/**
 * Storage round trip for the Preferences sheet's saved feed constraints against real Postgres
 * (PGlite) carrying the real migrations, behind a minimal PostgREST-shaped shim.
 */

const ROOT = join(__dirname, "..", "..", "..");
const migration = (name: string) => readFileSync(join(ROOT, "supabase", "migrations", name), "utf8");

const BASE_TABLE = `
  create table public.user_preferences (
    user_id uuid primary key, roles text[] default '{}', categories text[] default '{}', experience_level text,
    employment_types text[] default '{}', locations text[] default '{}', remote_preference text default 'any',
    work_auth text, min_salary numeric, salary_currency text default 'USD', daily_digest_opt_in boolean default true,
    onboarding_completed boolean default false, created_at timestamptz default now(), updated_at timestamptz default now(),
    deleted_at timestamptz
  );
`;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let db: PGlite;

const pgError = (e: any) => ({ code: e?.code, message: e?.message || String(e) });
function shimClient() {
  return {
    auth: { getSession: async () => ({ data: { session: null } }) },
    from(table: string) {
      return {
        select(cols: string) {
          const run = async (where: string, val: unknown) => {
            try {
              const r = await db.query<any>(`select ${cols} from public.${table} where ${where}`, [val]);
              return { data: r.rows[0] ?? null, error: null };
            } catch (e) {
              return { data: null, error: pgError(e) };
            }
          };
          return {
            eq(col: string, val: unknown) {
              return {
                is: (isCol: string) => ({ maybeSingle: () => run(`${col} = $1 and ${isCol} is null`, val) }),
                maybeSingle: () => run(`${col} = $1`, val),
              };
            },
          };
        },
        async upsert(payload: Record<string, unknown>) {
          const known = await db.query<{ column_name: string }>(
            "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
            [table]
          );
          const names = new Set(known.rows.map((r) => r.column_name));
          const missing = Object.keys(payload).find((c) => !names.has(c));
          if (missing) return { data: null, error: { code: "PGRST204", message: `Could not find the '${missing}' column of '${table}' in the schema cache` } };
          const cols = Object.keys(payload);
          try {
            await db.query(
              `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})
               on conflict (user_id) do update set ${cols.filter((c) => c !== "user_id").map((c) => `${c} = excluded.${c}`).join(", ")}`,
              cols.map((c) => payload[c])
            );
            return { data: null, error: null };
          } catch (e) {
            return { data: null, error: pgError(e) };
          }
        },
      };
    },
  };
}

vi.mock("@/lib/supabase/client", () => ({ createClient: () => shimClient() }));
vi.mock("@/lib/auth/onboarding", () => ({ markAccountOnboardingCompleted: vi.fn(async () => {}), checkAccountOnboardingCompleted: vi.fn(async () => false) }));

const row = async (id = A) => (await db.query<any>("select * from public.user_preferences where user_id = $1", [id])).rows[0] ?? null;

async function setUp(applyConstraints: boolean) {
  db = new PGlite();
  await db.exec(BASE_TABLE);
  await db.exec(migration("20261101_user_preferences_eligibility_filter.sql"));
  await db.exec(migration("20261117_user_preferences_country.sql"));
  if (applyConstraints) await db.exec(migration("20261125a_user_preferences_feed_constraints.sql"));
}

async function seedLegacyRow(id = A) {
  await db.query(
    `insert into public.user_preferences (user_id, roles, categories, remote_preference, employment_types, locations, work_auth,
       min_salary, salary_currency, daily_digest_opt_in, onboarding_completed, eligibility_filter, country, country_code)
     values ($1, '{"Frontend Developer","My Custom Role"}', '{engineering}', 'hybrid', '{full-time}', '{"Pune, Maharashtra"}',
       'I need visa sponsorship.', 1500000, 'INR', true, true, false, 'India', 'IN')`,
    [id]
  );
}

describe("saved feed constraints (migration 20261125a applied)", () => {
  beforeEach(() => setUp(true));

  it("an old row reads with legacy work model and empty constraints; nothing else changes", async () => {
    await seedLegacyRow();
    const p = await getUserPreferences(A);
    expect(p.feedConstraintsAvailable).toBe(true);
    expect(p.workModels).toEqual(["hybrid"]);
    expect(p.excludedTitles).toEqual([]);
    expect(p.datePosted).toBeNull();
    expect(p.roles).toEqual(["Frontend Developer", "My Custom Role"]);
    expect(p.countryCode).toBe("IN");
    expect(p.eligibilityFilter).toBe(false);
  });

  it("sheet save round-trips every new field and keeps unrelated flags", async () => {
    await seedLegacyRow();
    const committed = await getUserPreferences(A);
    const d = draftFromPreferences(committed);
    d.workModels = ["remote", "hybrid"];
    d.excludedTitles = ["Sales", "sales ", "Intern"];
    d.datePosted = "3d";
    d.includedCompanies = ["Acme, Inc."];
    d.excludedCompanies = ["Globex"];
    await saveUserPreferences(preferencesFromDraft(committed, d), A);

    const r = await row();
    expect(r.work_models).toEqual(["hybrid", "remote"]);
    expect(r.remote_preference).toBe("any"); // a combination is never collapsed to remote-only
    expect(r.excluded_titles).toEqual(["Sales", "Intern"]);
    expect(r.date_posted).toBe("3d");
    expect(r.included_companies).toEqual(["Acme, Inc."]);
    expect(r.excluded_companies).toEqual(["Globex"]);
    // unrelated flags and profile facts survive
    expect(r.daily_digest_opt_in).toBe(true);
    expect(r.onboarding_completed).toBe(true);
    expect(r.eligibility_filter).toBe(false);
    expect(r.country_code).toBe("IN");
    expect(r.work_auth).toBe("I need visa sponsorship.");
    expect(r.roles).toEqual(["Frontend Developer", "My Custom Role"]);

    const again = await getUserPreferences(A);
    expect(again.workModels).toEqual(["hybrid", "remote"]);
    expect(again.datePosted).toBe("3d");
    expect(again.excludedTitles).toEqual(["Sales", "Intern"]);
  });

  it("a caller that does not know the new fields (settings, onboarding) never erases them", async () => {
    await seedLegacyRow();
    const committed = await getUserPreferences(A);
    await saveUserPreferences({ ...preferencesFromDraft(committed, { ...draftFromPreferences(committed), excludedTitles: ["Sales"] }) }, A);
    const { excludedTitles: _t, workModels: _w, datePosted: _d, includedCompanies: _i, excludedCompanies: _e, ...older } = await getUserPreferences(A);
    await saveUserPreferences({ ...older, roles: ["Data Engineer"] }, A);
    const r = await row();
    expect(r.excluded_titles).toEqual(["Sales"]);
    expect(r.roles).toEqual(["Data Engineer"]);
  });

  it("empty is saved as empty; unset (never saved) stays NULL", async () => {
    await seedLegacyRow();
    expect((await row()).excluded_titles).toBeNull();
    const committed = await getUserPreferences(A);
    await saveUserPreferences(preferencesFromDraft(committed, draftFromPreferences(committed)), A);
    expect((await row()).excluded_titles).toEqual([]);
  });

  it("the database rejects an unknown date window or work model", async () => {
    await seedLegacyRow();
    await expect(db.query("update public.user_preferences set date_posted = '5d' where user_id = $1", [A])).rejects.toThrow();
    await expect(db.query("update public.user_preferences set work_models = '{anywhere}' where user_id = $1", [A])).rejects.toThrow();
  });

  it("each account reads only its own row; a new account is blank and nothing is seeded", async () => {
    await seedLegacyRow(A);
    const a = await getUserPreferences(A);
    await saveUserPreferences(preferencesFromDraft(a, { ...draftFromPreferences(a), excludedCompanies: ["Globex"] }), A);
    const b = await getUserPreferences(B);
    expect(b.excludedCompanies ?? []).toEqual([]);
    expect(b.roles).toEqual([]);
    expect(await row(B)).toBeNull();
  });
});

describe("saved feed constraints (migration 20261125a NOT applied yet)", () => {
  beforeEach(() => setUp(false));

  it("reads every other preference and marks the constraints unavailable", async () => {
    await seedLegacyRow();
    const p = await getUserPreferences(A);
    expect(p.feedConstraintsAvailable).toBe(false);
    expect(p.roles).toEqual(["Frontend Developer", "My Custom Role"]);
    expect(p.workModels).toEqual(["hybrid"]);
  });

  it("a sheet save of available fields still works; a save that sets a constraint fails loudly", async () => {
    await seedLegacyRow();
    const committed = await getUserPreferences(A);
    await saveUserPreferences(preferencesFromDraft(committed, { ...draftFromPreferences(committed), roles: ["Data Engineer"], excludedTitles: ["Sales"] }), A);
    expect((await row()).roles).toEqual(["Data Engineer"]);
    await expect(saveUserPreferences({ ...committed, feedConstraintsAvailable: undefined, excludedTitles: ["Sales"] }, A)).rejects.toThrow(/not available yet/);
  });
});
