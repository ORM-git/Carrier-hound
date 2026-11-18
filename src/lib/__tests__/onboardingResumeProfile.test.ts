import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  EMPTY_RESUME_PROFILE,
  PROFILE_LIMITS,
  extractTimeline,
  hasProfileSignal,
  mergeAiProfile,
  normalizeStoredProfile,
  parseMonthIndex,
  parseResumeProfileRules,
  rolesFromHeadline,
  yearsFromRanges,
} from "../onboarding/resumeProfile";
import {
  loadResumeProfileForRanking,
  parseOnboardingResume,
  saveResumeProfile,
  summarizeOutcome,
  type ResumeParseOutcome,
} from "../onboarding/resumeParse";

const NOW = new Date("2026-11-18T00:00:00Z");
const FIX = path.join(process.cwd(), "tests/fixtures/onboarding-resume");
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));

const LINKEDIN_TEXT = [
  "Contact",
  "www.linkedin.com/in/priya-sharma-test",
  "Top Skills",
  "Python",
  "SQL",
  "Tableau",
  "Priya Sharma",
  "Senior Data Analyst at Acme Analytics",
  "Bengaluru, Karnataka, India",
  "Summary",
  "Analyst with experience in dashboards.",
  "Experience",
  "Acme Analytics",
  "Senior Data Analyst",
  "March 2021 - Present (5 years 9 months)",
  "Beta Corp",
  "Data Analyst",
  "July 2018 - February 2021 (2 years 8 months)",
  "Education",
  "Indian Institute of Technology, Delhi",
  "Bachelor of Technology - BTech, Computer Science · (2014 - 2018)",
].join("\n");

describe("rules parser", () => {
  it("parses a LinkedIn 'Save to PDF' layout into titles, skills, years, education, location, roles", () => {
    const p = parseResumeProfileRules(LINKEDIN_TEXT, NOW);
    expect(p.jobTitles).toEqual(["Senior Data Analyst", "Data Analyst"]);
    expect(p.skills.slice(0, 3)).toEqual(["Python", "SQL", "Tableau"]);
    // Jul 2018 .. Nov 2026 inclusive = 101 months
    expect(p.yearsOfExperience).toBe(8.4);
    expect(p.education).toEqual([
      { degree: "Bachelor of Technology - BTech, Computer Science", institution: "Indian Institute of Technology, Delhi", year: "2018" },
    ]);
    expect(p.location).toBe("Bengaluru, Karnataka, India");
    expect(p.preferredRoles[0]).toBe("Senior Data Analyst");
    expect(p.preferredRoles).not.toContain("Acme Analytics");
  });

  it("never stores name, email, phone or URLs", () => {
    const text = `Jane Doe\njane@example.com | +91 98765 43210 | https://janedoe.dev\nBackend Engineer\nPune, Maharashtra\nExperience\nBackend Engineer - Foo Jan 2022 - Present\nSkills\nGo, PostgreSQL`;
    const json = JSON.stringify(parseResumeProfileRules(text, NOW));
    expect(json).not.toMatch(/Jane|jane@|98765|https?:/);
  });

  it("strips markup and prompt-like junk from fields", () => {
    const text = `X\nData Engineer\nPune, Maharashtra\nExperience\n<script>alert(1)</script>Data Engineer - Foo Jan 2021 - Present\nSkills\n<img src=x onerror=alert(1)>, Spark`;
    const p = parseResumeProfileRules(text, NOW);
    expect(JSON.stringify(p)).not.toMatch(/<script|onerror|<img/i);
    expect(p.skills).toContain("Spark");
  });

  it("returns an empty profile for empty or unreadable text", () => {
    expect(parseResumeProfileRules("", NOW)).toEqual(EMPTY_RESUME_PROFILE);
    expect(hasProfileSignal(parseResumeProfileRules("   \n  ", NOW))).toBe(false);
  });

  it("does not count education date ranges as work experience", () => {
    const { titles, ranges } = extractTimeline(
      ["Education", "Some University", "B.Sc Physics 2014 - 2018"],
      NOW
    );
    expect(titles).toEqual([]);
    expect(ranges).toEqual([]);
  });

  it("merges overlapping ranges and handles month formats", () => {
    expect(parseMonthIndex("Sept 2020", NOW)).toBe(2020 * 12 + 8);
    expect(parseMonthIndex("03/2019", NOW)).toBe(2019 * 12 + 2);
    expect(parseMonthIndex("Present", NOW)).toBe(2026 * 12 + 10);
    expect(parseMonthIndex("someday", NOW)).toBeNull();
    // Jan-Dec 2020 and Jun 2020-Jun 2021 overlap -> 18 months
    expect(yearsFromRanges([[2020 * 12, 2021 * 12], [2020 * 12 + 5, 2021 * 12 + 6]])).toBe(1.5);
    expect(yearsFromRanges([])).toBeNull();
    expect(yearsFromRanges([[1900 * 12, 2026 * 12]])).toBe(PROFILE_LIMITS.maxYears);
  });

  it("splits a headline into roles without the employer", () => {
    expect(rolesFromHeadline("Senior Data Analyst at Acme | SQL · Python")).toEqual(["Senior Data Analyst", "SQL", "Python"]);
    expect(rolesFromHeadline(null)).toEqual([]);
  });
});

describe("AI merge and stored-profile normalization", () => {
  const rules = parseResumeProfileRules(LINKEDIN_TEXT, NOW);

  it("prefers AI values and fills gaps from rules", () => {
    const merged = mergeAiProfile(
      {
        headline: "Analytics Lead",
        skills: ["dbt", "SQL"],
        experience: [
          { id: "e1", company: "Acme", role: "Analytics Lead", startDate: "Jan 2020", endDate: "Present", bullets: [] },
          { id: "e2", company: "X", role: "Role Title (Needs Confirmation)", startDate: "", endDate: "", bullets: [] },
        ],
        education: [],
      },
      rules,
      NOW
    );
    expect(merged.jobTitles[0]).toBe("Analytics Lead");
    expect(merged.jobTitles).not.toContain("Role Title (Needs Confirmation)");
    expect(merged.skills.slice(0, 2)).toEqual(["dbt", "SQL"]);
    expect(merged.skills.filter((s) => s.toLowerCase() === "sql")).toHaveLength(1);
    expect(merged.yearsOfExperience).toBe(6.9); // Jan 2020 .. Nov 2026 inclusive
    expect(merged.education).toEqual(rules.education);
    expect(merged.location).toBe(rules.location);
    expect(merged.preferredRoles[0]).toBe("Analytics Lead");
  });

  it("ignores a non-object AI result", () => {
    expect(mergeAiProfile(null, rules, NOW)).toBe(rules);
  });

  it("normalizes stored JSON, rejects junk and enforces the size cap", () => {
    expect(normalizeStoredProfile(null)).toBeNull();
    expect(normalizeStoredProfile([1, 2])).toBeNull();
    const big = normalizeStoredProfile({ skills: Array.from({ length: 500 }, (_, i) => `skill-${i}-${"x".repeat(50)}`), jobTitles: [42, "Dev"] });
    expect(big!.skills.length).toBe(PROFILE_LIMITS.skills);
    expect(big!.jobTitles).toEqual(["Dev"]);
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(PROFILE_LIMITS.maxJsonBytes);
  });
});

describe("parseOnboardingResume (extract + rules + existing AI operation)", () => {
  const ctx = { clientIp: "1.2.3.4", authHeader: "Bearer good", env: { X: "1" }, supabaseAdmin: { id: "admin" } };

  it("uses the AI result when the existing AI pipeline returns 200", async () => {
    const executeAi = vi.fn(async () => ({
      statusCode: 200,
      body: { success: true, result: { skills: ["Looker"], experience: [{ role: "BI Analyst", startDate: "2019", endDate: "Present" }] } },
    }));
    const out = await parseOnboardingResume(fixture("linkedin-style.pdf"), "pdf", ctx, { executeAi: executeAi as any, now: NOW });
    expect(out.status).toBe("parsed");
    expect(out.source).toBe("ai");
    expect(out.profile.jobTitles[0]).toBe("BI Analyst");
    expect(out.profile.skills).toEqual(expect.arrayContaining(["Looker", "Python", "SQL"]));
    // Called through executeAiCore's contract: allowlisted op, user's own bearer token, same env/admin
    const [ip, auth, body, deps] = (executeAi.mock.calls[0] as unknown) as any[];
    expect(ip).toBe("1.2.3.4");
    expect(auth).toBe("Bearer good");
    expect(body.operation).toBe("resume_extraction");
    expect(typeof body.params.rawText).toBe("string");
    expect(deps.env).toEqual({ X: "1" });
    expect(deps.getSupabaseAdmin()).toEqual({ id: "admin" });
  });

  it.each([
    ["Pro required (403)", async () => ({ statusCode: 403, body: { code: "PRO_REQUIRED" } })],
    ["rate limited (429)", async () => ({ statusCode: 429, body: {} })],
    ["kill switch / budget (503)", async () => ({ statusCode: 503, body: {} })],
    ["throws", async () => { throw new Error("boom"); }],
    ["non-object result", async () => ({ statusCode: 200, body: { result: "text" } })],
  ])("falls back to rules when the AI step is unavailable: %s", async (_label, impl) => {
    const out = await parseOnboardingResume(fixture("resume.docx"), "docx", ctx, { executeAi: vi.fn(impl) as any, now: NOW });
    expect(out.status).toBe("parsed");
    expect(out.source).toBe("rules");
    expect(out.profile.jobTitles).toEqual(["Frontend Engineer", "Junior Developer"]);
  });

  it("falls back to rules when the AI step times out", async () => {
    const never = vi.fn(() => new Promise(() => {}));
    const out = await parseOnboardingResume(fixture("resume.docx"), "docx", ctx, { executeAi: never as any, aiTimeoutMs: 20, now: NOW });
    expect(out.source).toBe("rules");
  });

  it("reports scanned and empty files as failed without calling AI", async () => {
    const executeAi = vi.fn();
    const scanned = await parseOnboardingResume(fixture("scanned.pdf"), "pdf", ctx, { executeAi: executeAi as any });
    expect(scanned).toMatchObject({ status: "failed", failureReason: "scanned_pdf", source: null });
    const empty = await parseOnboardingResume(new TextEncoder().encode("%PDF-1.7\n%%EOF"), "pdf", ctx, { executeAi: executeAi as any });
    expect(empty).toMatchObject({ status: "failed", failureReason: "no_text" });
    expect(executeAi).not.toHaveBeenCalled();
  });

  it("marks readable text with nothing usable as parse_error", async () => {
    const pdfText = "BT /F1 12 Tf (" + "lorem ipsum dolor sit amet ".repeat(4) + ") Tj ET";
    const pdf = new TextEncoder().encode(
      `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] >>\nendobj\n` +
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n` +
        `4 0 obj\n<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF`
    );
    const out = await parseOnboardingResume(pdf, "pdf", null, { now: NOW });
    expect(out).toMatchObject({ status: "failed", failureReason: "parse_error" });
  });
});

/** Table-aware fake of the service-role client for the two onboarding tables. */
function fakeAdmin(opts: {
  pointer?: string | null;
  profileRow?: any;
  upsertError?: any;
  readError?: any;
  throws?: boolean;
  rpcHandler?: (fn: string, args: any) => Promise<{ data: any; error: any }>;
} = {}) {
  const upserts: any[] = [];
  let currentPointer = opts.pointer;
  const admin = {
    upserts,
    setPointer: (p: string) => { currentPointer = p; },
    rpc: vi.fn(async (fn: string, args: any) => {
      if (opts.throws) throw new Error("reset");
      if (opts.rpcHandler) return opts.rpcHandler(fn, args);
      if (fn === "save_onboarding_resume_profile") {
        if (opts.readError) return { data: null, error: opts.readError };
        if (opts.upsertError) return { data: null, error: opts.upsertError };
        if (currentPointer !== args.p_storage_path) return { data: false, error: null };
        upserts.push({
          table: "onboarding_resume_profiles",
          row: {
            user_id: args.p_user_id,
            source_storage_path: args.p_storage_path,
            parse_status: args.p_parse_status,
            parse_source: args.p_parse_source,
            failure_reason: args.p_failure_reason,
            profile: args.p_profile,
          },
          o: { onConflict: "user_id" },
        });
        return { data: true, error: null };
      }
      return { data: null, error: { message: "unknown rpc" } };
    }),
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (opts.throws) throw new Error("reset");
            if (table === "onboarding_resume_uploads") {
              return { data: currentPointer ? { storage_path: currentPointer } : null, error: opts.readError ?? null };
            }
            return { data: opts.profileRow ?? null, error: null };
          },
        }),
      }),
      upsert: async (row: any, o: any) => {
        upserts.push({ table, row, o });
        return { error: opts.upsertError ?? null };
      },
    })),
  };
  return admin;
}

const UID = "11111111-2222-3333-4444-555555555555";
const PATH = `${UID}/onboarding/a.pdf`;
const parsed: ResumeParseOutcome = {
  status: "parsed",
  source: "rules",
  failureReason: null,
  profile: { ...EMPTY_RESUME_PROFILE, jobTitles: ["Data Analyst"], skills: ["SQL"] },
};

describe("saveResumeProfile", () => {
  it("upserts the parsed row for the owner, keyed on user_id", async () => {
    const admin = fakeAdmin({ pointer: PATH });
    expect(await saveResumeProfile(admin, UID, PATH, parsed)).toBe(true);
    expect(admin.upserts).toHaveLength(1);
    const { table, row, o } = admin.upserts[0];
    expect(table).toBe("onboarding_resume_profiles");
    expect(o).toEqual({ onConflict: "user_id" });
    expect(row).toMatchObject({ user_id: UID, source_storage_path: PATH, parse_status: "parsed", parse_source: "rules", failure_reason: null });
    expect(row.profile.jobTitles).toEqual(["Data Analyst"]);
  });

  it("saves failures with a reason and no source", async () => {
    const admin = fakeAdmin({ pointer: PATH });
    await saveResumeProfile(admin, UID, PATH, { status: "failed", source: null, failureReason: "scanned_pdf", profile: EMPTY_RESUME_PROFILE });
    expect(admin.upserts[0].row).toMatchObject({ parse_status: "failed", parse_source: null, failure_reason: "scanned_pdf" });
  });

  it("does not write when a newer upload replaced the pointer, or on read errors", async () => {
    const newer = fakeAdmin({ pointer: `${UID}/onboarding/newer.pdf` });
    expect(await saveResumeProfile(newer, UID, PATH, parsed)).toBe(false);
    expect(newer.upserts).toHaveLength(0);
    const broken = fakeAdmin({ pointer: PATH, readError: { message: "down" } });
    expect(await saveResumeProfile(broken, UID, PATH, parsed)).toBe(false);
    expect(broken.upserts).toHaveLength(0);
  });

  it("returns false (never throws) when the table is not migrated yet or the client throws", async () => {
    expect(await saveResumeProfile(fakeAdmin({ pointer: PATH, upsertError: { code: "42P01", message: "relation does not exist" } }), UID, PATH, parsed)).toBe(false);
    expect(await saveResumeProfile(fakeAdmin({ throws: true }), UID, PATH, parsed)).toBe(false);
  });

  it("interleaving test: newer upload replaces pointer before older save runs; older save returns false atomically", async () => {
    const PATH_OLD = `${UID}/onboarding/old.pdf`;
    const PATH_NEW = `${UID}/onboarding/new.pdf`;

    const admin = fakeAdmin({ pointer: PATH_OLD });

    // Newer upload arrives, pointer is updated to PATH_NEW, and its parse saves successfully
    admin.setPointer(PATH_NEW);
    const saveNew = await saveResumeProfile(admin, UID, PATH_NEW, {
      ...parsed,
      profile: { ...parsed.profile, jobTitles: ["Senior Engineer"] },
    });
    expect(saveNew).toBe(true);

    // Slower parse from earlier upload finishes now with PATH_OLD and tries to save
    const saveOld = await saveResumeProfile(admin, UID, PATH_OLD, parsed);
    expect(saveOld).toBe(false);

    // The newer profile is preserved; old profile was never saved
    const savedProfiles = admin.upserts.filter((u) => u.table === "onboarding_resume_profiles");
    expect(savedProfiles).toHaveLength(1);
    expect(savedProfiles[0].row.source_storage_path).toBe(PATH_NEW);
    expect(savedProfiles[0].row.profile.jobTitles).toEqual(["Senior Engineer"]);
  });

  it("fails closed on RPC 57014 (statement timeout / cancel) without non-atomic fallback; interleaved newer upload is preserved", async () => {
    const PATH_OLD = `${UID}/onboarding/old.pdf`;
    const PATH_NEW = `${UID}/onboarding/new.pdf`;

    const admin = fakeAdmin({ pointer: PATH_OLD });

    // Newer upload arrives, pointer is updated to PATH_NEW, and its parse saves successfully
    admin.setPointer(PATH_NEW);
    const saveNew = await saveResumeProfile(admin, UID, PATH_NEW, {
      ...parsed,
      profile: { ...parsed.profile, jobTitles: ["Staff Engineer"] },
    });
    expect(saveNew).toBe(true);

    // Slower parse from earlier upload finishes now with PATH_OLD and tries to save,
    // but encounters RPC error 57014 (canceling statement due to statement timeout)
    let rpcCalledWithOld = false;
    const originalRpc = admin.rpc;
    admin.rpc = vi.fn(async (fn: string, args: any) => {
      if (fn === "save_onboarding_resume_profile" && args.p_storage_path === PATH_OLD) {
        rpcCalledWithOld = true;
        return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      }
      return originalRpc(fn, args);
    });

    const saveOld = await saveResumeProfile(admin, UID, PATH_OLD, parsed);
    expect(rpcCalledWithOld).toBe(true);
    // Fails closed: returns false, does NOT fall back to non-atomic upsert
    expect(saveOld).toBe(false);

    // Only the newer profile is in upserts; old profile never overwrote it
    const savedProfiles = admin.upserts.filter((u) => u.table === "onboarding_resume_profiles");
    expect(savedProfiles).toHaveLength(1);
    expect(savedProfiles[0].row.source_storage_path).toBe(PATH_NEW);
    expect(savedProfiles[0].row.profile.jobTitles).toEqual(["Staff Engineer"]);
  });
});

describe("loadResumeProfileForRanking", () => {
  const row = { parse_status: "parsed", source_storage_path: PATH, profile: { jobTitles: ["Data Analyst"], skills: ["SQL"] } };

  it("returns the current parsed profile", async () => {
    const p = await loadResumeProfileForRanking(fakeAdmin({ pointer: PATH, profileRow: row }), UID);
    expect(p?.jobTitles).toEqual(["Data Analyst"]);
  });

  it("ignores stale (older upload), failed, missing and erroring rows", async () => {
    expect(await loadResumeProfileForRanking(fakeAdmin({ pointer: `${UID}/onboarding/new.pdf`, profileRow: row }), UID)).toBeNull();
    expect(await loadResumeProfileForRanking(fakeAdmin({ pointer: PATH, profileRow: { ...row, parse_status: "failed" } }), UID)).toBeNull();
    expect(await loadResumeProfileForRanking(fakeAdmin({ pointer: PATH, profileRow: null }), UID)).toBeNull();
    expect(await loadResumeProfileForRanking(fakeAdmin({ throws: true }), UID)).toBeNull();
  });
});

describe("summarizeOutcome (response to Step 2)", () => {
  it("returns a small summary and nothing when the save failed", () => {
    expect(summarizeOutcome(parsed, true)).toEqual({
      status: "parsed",
      source: "rules",
      jobTitle: "Data Analyst",
      skillsCount: 1,
      topSkills: ["SQL"],
      yearsOfExperience: null,
    });
    expect(summarizeOutcome(parsed, false)).toEqual({ status: "unavailable" });
    expect(summarizeOutcome({ status: "failed", source: null, failureReason: "no_text", profile: EMPTY_RESUME_PROFILE }, true)).toEqual({
      status: "failed",
      reason: "no_text",
    });
  });
});
