import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { PGlite } from "@electric-sql/pglite";
// vi.mock calls below are hoisted above these imports.
import { getUserPreferences, saveUserPreferences } from "../auth/session";
import { POST } from "../../app/api/onboarding/route";

/**
 * End-to-end: getUserPreferences + /api/onboarding save + saveUserPreferences against a real
 * Postgres (PGlite) carrying the real user_preferences migrations, behind a minimal
 * PostgREST-shaped shim (select/eq/maybeSingle, upsert). Covers:
 *  - new accounts read back blank values and nothing is seeded into the DB;
 *  - country / country_code round-trip as first-class columns;
 *  - before migration 20261117 is applied, reads degrade and writes never report success
 *    after dropping the country.
 */

const ROOT = join(__dirname, "..", "..", "..");
const migration = (name: string) => readFileSync(join(ROOT, "supabase", "migrations", name), "utf8");

// Base table as created by 20261008_phase4_user_preferences_and_onboarding.sql (FK to auth.users omitted).
const BASE_TABLE = `
  create table public.user_preferences (
    user_id             uuid primary key,
    roles               text[] default '{}',
    categories          text[] default '{}',
    experience_level    text,
    employment_types    text[] default '{}',
    locations           text[] default '{}',
    remote_preference   text default 'any',
    work_auth           text,
    min_salary          numeric,
    salary_currency     text default 'USD',
    daily_digest_opt_in boolean default true,
    onboarding_completed boolean default false,
    created_at          timestamptz default now(),
    updated_at          timestamptz default now()
  );
`;

const USER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "token-for-user";

let db: PGlite;

function pgError(e: any) {
  return { code: e?.code, message: e?.message || String(e) };
}

/** Minimal PostgREST-shaped client over PGlite. */
function shimClient() {
  return {
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: USER_ID } }, error: null }
          : { data: { user: null }, error: new Error("invalid") },
      getSession: async () => ({ data: { session: null } }),
    },
    from(table: string) {
      return {
        select(cols: string) {
          return {
            eq(col: string, val: unknown) {
              return {
                is(isCol: string, _isVal: null) {
                  return {
                    async maybeSingle() {
                      try {
                        const r = await db.query<any>(
                          `select ${cols} from public.${table} where ${col} = $1 and ${isCol} is null`,
                          [val]
                        );
                        return { data: r.rows[0] ?? null, error: null };
                      } catch (e) {
                        return { data: null, error: pgError(e) };
                      }
                    },
                  };
                },
                async maybeSingle() {
                  try {
                    const r = await db.query<any>(`select ${cols} from public.${table} where ${col} = $1`, [val]);
                    return { data: r.rows[0] ?? null, error: null };
                  } catch (e) {
                    return { data: null, error: pgError(e) };
                  }
                },
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
          const cols = Object.keys(payload);
          const missing = cols.find((c) => !names.has(c));
          if (missing) {
            // Same shape PostgREST returns for an unknown column on write.
            return {
              data: null,
              error: { code: "PGRST204", message: `Could not find the '${missing}' column of '${table}' in the schema cache` },
            };
          }
          const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
          const updates = cols.filter((c) => c !== "user_id").map((c) => `${c} = excluded.${c}`).join(", ");
          try {
            await db.query(
              `insert into public.${table} (${cols.join(", ")}) values (${placeholders})
               on conflict (user_id) do update set ${updates}`,
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
vi.mock("@/lib/ai/serviceHandler", () => ({ getSupabaseAdminClient: () => shimClient() }));
vi.mock("@/lib/auth/onboarding", () => ({
  markAccountOnboardingCompleted: vi.fn(async () => {}),
  checkAccountOnboardingCompleted: vi.fn(async () => false),
}));
vi.mock("@cloudflare/next-on-pages", () => ({ getRequestContext: () => undefined }));


async function rowCount(): Promise<number> {
  const r = await db.query<{ n: number }>("select count(*)::int as n from public.user_preferences");
  return r.rows[0].n;
}

async function row(): Promise<any> {
  const r = await db.query<any>("select * from public.user_preferences where user_id = $1", [USER_ID]);
  return r.rows[0] ?? null;
}

function onboardingRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  roles: ["Frontend Engineer"],
  employmentTypes: ["contract"],
  country: "IN",
  workAuth: "Requires visa sponsorship (e.g. H1B)",
};

async function setUp(applyCountryMigration: boolean) {
  db = new PGlite();
  await db.exec(BASE_TABLE);
  await db.exec("alter table public.user_preferences add column deleted_at timestamptz");
  await db.exec(migration("20261101_user_preferences_eligibility_filter.sql"));
  if (applyCountryMigration) {
    await db.exec(migration("20261117_user_preferences_country.sql"));
  }
}

describe("user preferences end to end (migration 20261117 applied)", () => {
  beforeEach(async () => {
    await setUp(true);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.close();
  });

  it("new account: getter returns blank values and seeds nothing into the DB", async () => {
    const prefs = await getUserPreferences(USER_ID);

    expect(await rowCount()).toBe(0);
    expect(prefs.roles).toEqual([]);
    expect(prefs.categories).toEqual([]);
    expect(prefs.employmentTypes).toEqual([]);
    expect(prefs.locations).toEqual([]);
    expect(prefs.experienceLevel).toBeUndefined(); // never "mid"
    expect(prefs.minSalary).toBeUndefined(); // never 80000
    expect(prefs.salaryCurrency).toBeUndefined(); // never "USD"
    expect(prefs.workAuth).toBeUndefined(); // never "Authorized"
    expect(prefs.country).toBeUndefined();
    expect(prefs.onboardingCompleted).toBe(false);

    // Reading twice still writes nothing.
    await getUserPreferences(USER_ID);
    expect(await rowCount()).toBe(0);
  });

  it("ordinary getter ignores tombstoned preferences and returns fresh defaults", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("window", { dispatchEvent: () => true });
    storage.set("careermonke_preferences", JSON.stringify({ roles: ["Previous identity"], onboardingCompleted: true }));
    await db.query(
      "insert into public.user_preferences (user_id, roles, onboarding_completed, deleted_at) values ($1, $2, true, now())",
      [USER_ID, ["Old role"]]
    );
    const prefs = await getUserPreferences(USER_ID);
    expect(prefs.roles).toEqual([]);
    expect(prefs.onboardingCompleted).toBe(false);
    vi.unstubAllGlobals();
  });

  it("ordinary getter does not turn a database read error into cached preferences", async () => {
    const storage = new Map<string, string>([["careermonke_preferences", JSON.stringify({ roles: ["Old user"], onboardingCompleted: true })]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal("window", { dispatchEvent: () => true });
    await db.exec("drop table public.user_preferences");
    const prefs = await getUserPreferences(USER_ID);
    expect(prefs.roles).toEqual([]);
    expect(prefs.onboardingCompleted).toBe(false);
  });

  it("genuinely old schema without deleted_at can read a row after hard-delete-era setup", async () => {
    await db.exec("alter table public.user_preferences drop column deleted_at");
    await db.query("insert into public.user_preferences (user_id, roles) values ($1, $2)", [USER_ID, ["Legacy role"]]);
    expect((await getUserPreferences(USER_ID)).roles).toEqual(["Legacy role"]);
  });

  it("new account: getter, then API save, then getter agrees with the saved row and the API response", async () => {
    await getUserPreferences(USER_ID);
    expect(await rowCount()).toBe(0);

    const res = await POST(onboardingRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    const saved = await row();
    expect(saved.country).toBe("India");
    expect(saved.country_code).toBe("IN");
    expect(saved.roles).toEqual(["Frontend Engineer"]);
    expect(saved.experience_level).toBeNull();
    expect(saved.min_salary).toBeNull();
    expect(saved.salary_currency).toBeNull(); // the column default (USD) must not leak in
    expect(saved.daily_digest_opt_in).toBe(false);

    const prefs = await getUserPreferences(USER_ID);
    const { updatedAt: _a, ...fromDb } = prefs;
    const { updatedAt: _b, ...fromApi } = json.preferences;
    // The validated preferences the API returns (what the page caches) equal what the DB holds.
    expect(fromDb).toEqual(JSON.parse(JSON.stringify(fromApi)));
    expect(prefs.country).toBe("India");
    expect(prefs.countryCode).toBe("IN");
    // The API accepts the legacy label and stores the current first-person wording.
    expect(prefs.workAuth).toBe("I need visa sponsorship.");
    expect(prefs.salaryCurrency).toBeUndefined();
  });

  it("saveUserPreferences writes country and country_code; a save that does not set them keeps them", async () => {
    const blank = await getUserPreferences(USER_ID);
    await saveUserPreferences(
      { ...blank, roles: ["Data Analyst"], employmentTypes: ["full-time"], country: "United States", countryCode: "us" },
      USER_ID
    );
    let saved = await row();
    expect(saved.country).toBe("United States");
    expect(saved.country_code).toBe("US");

    const prefs = await getUserPreferences(USER_ID);
    expect(prefs.country).toBe("United States");
    expect(prefs.countryCode).toBe("US");
    expect(prefs.roles).toEqual(["Data Analyst"]);

    // A settings-style save that never touched the country leaves it in place.
    const { country: _c, countryCode: _cc, ...withoutCountry } = prefs;
    await saveUserPreferences({ ...withoutCountry, roles: ["Data Scientist"] }, USER_ID);
    saved = await row();
    expect(saved.roles).toEqual(["Data Scientist"]);
    expect(saved.country).toBe("United States");
    expect(saved.country_code).toBe("US");
  });
});

describe("user preferences end to end (migration 20261117 NOT applied yet)", () => {
  beforeEach(async () => {
    await setUp(false);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.close();
  });

  it("getter degrades: reads the row without the country columns", async () => {
    await db.query(
      "insert into public.user_preferences (user_id, roles, employment_types, locations) values ($1, $2, $3, $4)",
      [USER_ID, ["Backend Engineer"], ["full-time"], ["Pune"]]
    );
    const prefs = await getUserPreferences(USER_ID);
    expect(prefs.roles).toEqual(["Backend Engineer"]);
    expect(prefs.employmentTypes).toEqual(["full-time"]);
    expect(prefs.locations).toEqual(["Pune"]);
    expect(prefs.country).toBeUndefined();
  });

  it("ordinary getter ignores tombstoned preferences when country columns are unavailable", async () => {
    await db.query(
      "insert into public.user_preferences (user_id, roles, onboarding_completed, deleted_at) values ($1, $2, true, now())",
      [USER_ID, ["Old role"]]
    );
    const prefs = await getUserPreferences(USER_ID);
    expect(prefs.roles).toEqual([]);
    expect(prefs.onboardingCompleted).toBe(false);
  });

  it("API save does NOT report success when the country columns are missing (no retry that drops them)", async () => {
    const res = await POST(onboardingRequest(VALID_BODY));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBeUndefined();
    expect(await rowCount()).toBe(0);
  });

  it("saveUserPreferences with a country throws instead of dropping it; without one it still saves", async () => {
    const blank = await getUserPreferences(USER_ID);
    await expect(
      saveUserPreferences({ ...blank, roles: ["QA Engineer"], country: "India", countryCode: "IN" }, USER_ID)
    ).rejects.toThrow(/country/i);
    expect(await rowCount()).toBe(0);

    await saveUserPreferences({ ...blank, roles: ["QA Engineer"] }, USER_ID);
    expect((await row()).roles).toEqual(["QA Engineer"]);
  });
});
