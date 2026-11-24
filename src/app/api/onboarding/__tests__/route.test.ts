import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "../route";

const mockDb = {
  user_preferences: new Map<string, any>(),
};

const defaultFromImplementation = (table: string) => {
  let filterVal: string | null = null;
  const queryObj: any = {
    eq: vi.fn((col: string, val: string) => {
      filterVal = val;
      return queryObj;
    }),
    is: vi.fn(() => queryObj),
    maybeSingle: vi.fn(async () => {
      if (table === "user_preferences") {
        return { data: (filterVal ? mockDb.user_preferences.get(filterVal) : null) || null, error: null };
      }
      return { data: null, error: null };
    }),
  };
  return {
    select: vi.fn(() => queryObj),
    upsert: vi.fn(async (payload: any) => {
      if (table === "user_preferences") {
        const existing = mockDb.user_preferences.get(payload.user_id) || {};
        mockDb.user_preferences.set(payload.user_id, { ...existing, ...payload });
      }
      return { data: payload, error: null };
    }),
  };
};

const mockSupabaseAdmin = {
  auth: {
    getUser: vi.fn(async (token: string) => {
      if (token === "valid-user-token") {
        return { data: { user: { id: "user-123", email: "test@example.com" } }, error: null };
      }
      if (token === "existing-user-token") {
        return { data: { user: { id: "user-old-456", email: "old@example.com" } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid session") };
    }),
  },
  from: vi.fn(defaultFromImplementation),
};

vi.mock("@/lib/ai/serviceHandler", () => ({
  getSupabaseAdminClient: vi.fn(() => mockSupabaseAdmin),
}));

vi.mock("@/lib/auth/onboarding", () => ({
  markAccountOnboardingCompleted: vi.fn(async () => {}),
}));

vi.mock("@cloudflare/next-on-pages", () => ({
  getRequestContext: vi.fn(() => undefined),
}));

function makeReq(body: any, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return new Request("http://localhost:3000/api/onboarding", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/onboarding", () => {
  beforeEach(() => {
    mockDb.user_preferences.clear();
    vi.clearAllMocks();
    mockSupabaseAdmin.from.mockImplementation(defaultFromImplementation);
  });

  it("returns 401 with private no-store header when Authorization header is missing", async () => {
    const res = await POST(makeReq({ roles: ["Frontend"] }));
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
  });

  it("returns 401 on invalid token", async () => {
    const res = await POST(makeReq({ roles: ["Frontend"] }, "bad-token"));
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await POST(makeReq("{not-json", "valid-user-token"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
  });

  it("returns 400 when roles are missing or empty", async () => {
    const res = await POST(
      makeReq(
        {
          roles: [],
          employmentTypes: ["full-time"],
          country: "India",
          workAuth: "Authorized to work (No sponsorship required)",
        },
        "valid-user-token"
      )
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("target role");
  });

  it("returns 400 when employmentTypes are missing or invalid", async () => {
    const res = await POST(
      makeReq(
        {
          roles: ["Software Engineer"],
          employmentTypes: [],
          country: "India",
          workAuth: "Authorized to work (No sponsorship required)",
        },
        "valid-user-token"
      )
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("job type");
  });

  it("returns 400 when country is missing (no default fallback)", async () => {
    const res = await POST(
      makeReq(
        {
          roles: ["Software Engineer"],
          employmentTypes: ["full-time"],
          country: "",
          workAuth: "Authorized to work (No sponsorship required)",
        },
        "valid-user-token"
      )
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Valid country is required");
  });

  it("returns 400 when country is unrecognized/invalid", async () => {
    const res = await POST(
      makeReq(
        {
          roles: ["Software Engineer"],
          employmentTypes: ["full-time"],
          country: "Atlantis",
          workAuth: "Authorized to work (No sponsorship required)",
        },
        "valid-user-token"
      )
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Valid country is required");
  });

  it("returns 400 when workAuth is missing", async () => {
    const res = await POST(
      makeReq(
        {
          roles: ["Software Engineer"],
          employmentTypes: ["full-time"],
          country: "United States",
          workAuth: "",
        },
        "valid-user-token"
      )
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Work authorization status is required");
  });

  const authorized = "I am authorized to work without sponsorship.";
  const sponsorship = "I need visa sponsorship.";
  const other = "I have another work permit or authorization.";
  const postWorkAuth = (workAuth: unknown) =>
    POST(
      makeReq(
        { roles: ["Software Engineer"], employmentTypes: ["full-time"], country: "United States", workAuth },
        "valid-user-token"
      )
    );

  it.each([
    [`${authorized} + ${sponsorship}`],
    [`${authorized} + ${other}`],
    [`${authorized} + ${sponsorship} + ${other}`],
    ["Authorized"],
    ["unknown"],
    [["requires_sponsorship", "other"]],
    [42],
    [null],
  ])("returns 400 for invalid work authorization %j", async (workAuth) => {
    const res = await postWorkAuth(workAuth);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Work authorization status is required");
  });

  it("accepts {2,3} in either order or as ids and stores the canonical string", async () => {
    for (const input of [`${other} + ${sponsorship}`, "requires_sponsorship + other"]) {
      const res = await postWorkAuth(input);
      expect(res.status).toBe(200);
      expect((await res.json()).preferences.workAuth).toBe(`${sponsorship} + ${other}`);
      expect(mockDb.user_preferences.get("user-123").work_auth).toBe(`${sponsorship} + ${other}`);
    }
  });

  it("persists valid country separately (name + code) and workAuth without inventing defaults", async () => {
    const res = await POST(
      makeReq(
        {
          roles: ["Software Engineer", "AI Engineer"],
          employmentTypes: ["full-time", "contract"],
          country: "United States",
          workAuth: "Requires visa sponsorship (e.g. H1B)",
          openToRemote: true,
        },
        "valid-user-token"
      )
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.preferences.country).toBe("United States");
    expect(json.preferences.countryCode).toBe("US");
    // Legacy label input is accepted and stored with the current first-person label.
    expect(json.preferences.workAuth).toBe("I need visa sponsorship.");
    expect(json.preferences.locations).toEqual(["United States"]);
    expect(json.preferences.experienceLevel).toBeUndefined();
    expect(json.preferences.salaryCurrency).toBeUndefined();

    // Verify DB record
    const saved = mockDb.user_preferences.get("user-123");
    expect(saved.country).toBe("United States");
    expect(saved.country_code).toBe("US");
    expect(saved.work_auth).toBe("I need visa sponsorship.");
    // Written as explicit nulls so column defaults (salary_currency 'USD') never apply.
    expect(saved.experience_level).toBeNull();
    expect(saved.min_salary).toBeNull();
    expect(saved.salary_currency).toBeNull();
  });

  it("preserves ALL old saved locations, hybrid remotePreference, experience_level, and currency for existing users", async () => {
    // Seed existing user in DB
    mockDb.user_preferences.set("user-old-456", {
      user_id: "user-old-456",
      roles: ["Backend Engineer"],
      categories: ["engineering"],
      experience_level: "senior",
      employment_types: ["contract"],
      locations: ["Bengaluru", "London"],
      remote_preference: "hybrid",
      work_auth: "Authorized to work (No sponsorship required)",
      min_salary: 150000,
      salary_currency: "GBP",
      onboarding_completed: true,
    });

    const res = await POST(
      makeReq(
        {
          roles: ["Frontend Engineer"],
          employmentTypes: ["full-time"],
          country: "IN", // ISO code input
          workAuth: "Authorized to work (No sponsorship required)",
          openToRemote: true,
        },
        "existing-user-token"
      )
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preferences.country).toBe("India");
    expect(json.preferences.countryCode).toBe("IN");
    // Keeps ALL old locations + new country
    expect(json.preferences.locations).toEqual(["India", "Bengaluru", "London"]);
    // Keeps hybrid without narrowing
    expect(json.preferences.remotePreference).toBe("hybrid");
    // Keeps old experience level & currency
    expect(json.preferences.experienceLevel).toBe("senior");
    expect(json.preferences.salaryCurrency).toBe("GBP");
    expect(json.preferences.minSalary).toBe(150000);
  });

  const validBody = {
    roles: ["Frontend Engineer"],
    employmentTypes: ["full-time"],
    country: "India",
    workAuth: "Authorized to work (No sponsorship required)",
  };

  it.each(["any", "hybrid", "remote", "onsite"])(
    "keeps saved remote_preference '%s' unchanged when the client sends none (no narrowing)",
    async (saved) => {
      mockDb.user_preferences.set("user-old-456", {
        user_id: "user-old-456",
        locations: ["Remote / Global", "Pune"],
        remote_preference: saved,
      });
      // openToRemote: true is the legacy UI default and must not flip a saved onsite/any to remote.
      const res = await POST(makeReq({ ...validBody, openToRemote: true }, "existing-user-token"));
      expect(res.status).toBe(200);
      const row = mockDb.user_preferences.get("user-old-456");
      expect(row.remote_preference).toBe(saved);
      expect(row.locations).toEqual(["India", "Remote / Global", "Pune"]);
    }
  );

  it("applies an explicit remotePreference from the client", async () => {
    mockDb.user_preferences.set("user-old-456", { user_id: "user-old-456", remote_preference: "any" });
    const res = await POST(makeReq({ ...validBody, remotePreference: "onsite" }, "existing-user-token"));
    expect(res.status).toBe(200);
    expect(mockDb.user_preferences.get("user-old-456").remote_preference).toBe("onsite");
  });

  it("fails closed with 500 and writes nothing when saved preferences cannot be read", async () => {
    const upsert = vi.fn();
    mockSupabaseAdmin.from.mockImplementation((table: string) => {
      if (table === "deleted_account_tombstones") {
        return defaultFromImplementation(table) as any;
      }
      const q: any = {
        eq: vi.fn(() => q),
        is: vi.fn(() => q),
        maybeSingle: vi.fn(async () => ({ data: null, error: { message: "connection reset" } })),
      };
      return {
        select: vi.fn(() => q),
        upsert,
      } as any;
    });
    const res = await POST(makeReq(validBody, "valid-user-token"));
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache, no-store, must-revalidate");
    expect(upsert).not.toHaveBeenCalled();
    expect(mockDb.user_preferences.size).toBe(0);
  });

  it("returns 503 (never success) and does not retry without country when the country columns are missing", async () => {
    const upsert = vi.fn(async () => ({
      data: null,
      error: { code: "PGRST204", message: "Could not find the 'country' column of 'user_preferences' in the schema cache" },
    }));
    mockSupabaseAdmin.from.mockImplementation((table: string) => {
      if (table === "deleted_account_tombstones") {
        return defaultFromImplementation(table) as any;
      }
      const q: any = {
        eq: vi.fn(() => q),
        is: vi.fn(() => q),
        maybeSingle: vi.fn(async () => ({ data: null, error: null })),
      };
      return {
        select: vi.fn(() => q),
        upsert,
      } as any;
    });
    const res = await POST(makeReq(validBody, "valid-user-token"));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.success).toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0] as any[])[0]).toMatchObject({ country: "India", country_code: "IN" });
    expect(mockDb.user_preferences.size).toBe(0);
  });
});
