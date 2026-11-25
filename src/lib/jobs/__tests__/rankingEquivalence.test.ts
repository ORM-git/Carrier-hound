/**
 * Equivalence harness: the prepared-context ranking (src/lib/jobs/recommendations.ts) must return exactly what the
 * frozen pre-optimization copy (./recommendations.legacy.ts + ./eligibility.legacy.ts) returns, object for object,
 * on the same fixtures. Also counts regex compiles / country-table scans / scorer evaluations on those fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../experienceLevels", async (importOriginal) => {
  const m = await importOriginal<typeof import("../experienceLevels")>();
  return { ...m, isEarlyCareerJob: vi.fn(m.isEarlyCareerJob) };
});

import * as experienceLevels from "../experienceLevels";
import * as current from "../recommendations";
import * as legacy from "./recommendations.legacy";
import * as currentElig from "../eligibility";
import * as legacyElig from "./eligibility.legacy";
import { COUNTRY_CODE_TO_NAME } from "../../countries";
import type { OnboardingAnswers, ResumeRankingSignals } from "../recommendations";

const NOW = new Date("2026-11-25T12:00:00Z").getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3600e3).toISOString();

// ---------------------------------------------------------------- fixtures
const TITLES = [
  "Senior Software Engineer", "Junior Frontend Developer", "Staff C++ Engineer", "Node.js Backend Engineer",
  ".NET Developer", "Data Scientist", "Account Executive - Financial Services", "Executive Assistant, Marketing",
  "Product Manager", "Ingeniero de Software Sénior", "Développeur Full-Stack (Node.js)", "Head of Engineering",
  "Software Engineering Intern", "Founding Engineer", "Commercial Counsel", "Marketing Manager",
  "Principal Data Engineer", "VP Sales", "Registered Nurse", "", "Staff Accountant", "Sr. DevOps Engineer",
  "Entry Level Data Analyst", "Lead Product Designer", "C# / .NET Engineer", "Senior Data Analyst",
];
const LOCATIONS: [string | null, boolean | null, string | null, string | null, string | null][] = [
  // location, remote, remote_scope, country_code, remote_eligibility
  ["Remote", true, "worldwide", null, null],
  ["Remote - US", true, "remote", "US", "country_restricted"],
  ["Berlin, Germany", false, "onsite", "DE", null],
  ["Bangalore, India", false, null, "IN", null],
  ["Indianapolis, Indiana", false, "hybrid", "US", null],
  ["Santa Fe, New Mexico", false, null, null, null],
  ["Mexico City", false, null, "MX", null],
  ["London, UK", true, "hybrid", "GB", null],
  ["Work from anywhere", true, null, null, "worldwide"],
  [null, null, null, null, null],
  ["Remote (Canada)", true, "remote", null, null],
  ["Hybrid - Paris, France", false, "hybrid", "FR", null],
];
const CATEGORIES = ["software", "engineering", "data", "sales", "legal", null, "marketing", "design"];
const JOB_TYPES = ["full-time", "part-time", "contract", "internship", null, "job"];
const DATES = [hoursAgo(2), hoursAgo(2), hoursAgo(50), hoursAgo(400), hoursAgo(2000), null, "not-a-date"];
const SALARIES: Record<string, unknown>[] = [
  {}, { salary_max: 150000, currency: "USD" }, { salary_max: 40, salary_period: "hourly" },
  { salary_max: 3000 }, { salary_min: 2000000, currency: "INR" }, { salary_text: "€60,000 - €70,000" },
];

function makeJobs(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const [location, remote, remote_scope, country_code, remote_eligibility] = LOCATIONS[(i * 7) % LOCATIONS.length];
    const date = DATES[(i * 5) % DATES.length];
    return {
      // Tied ids and duplicate dates on purpose so the id / date tie-breaks are exercised
      key: i,
      id: i % 17 === 0 ? "dup" : `job-${String(i).padStart(3, "0")}`,
      title: i % 41 === 40 ? null : TITLES[i % TITLES.length],
      category: CATEGORIES[(i * 3) % CATEGORIES.length],
      location, remote, remote_scope, country_code, remote_eligibility,
      country: i % 9 === 0 ? "India" : null,
      job_type: JOB_TYPES[(i * 11) % JOB_TYPES.length],
      posted_at: i % 2 ? date : null,
      created_at: i % 2 ? null : date,
      first_seen_at: i % 13 === 0 ? hoursAgo(10) : null,
      company: `Co ${i % 6}`,
      skills: i % 4 === 0 ? ["C++", "Node.js", ".NET", "SQL"] : i % 4 === 1 ? ["Python", "Tableau"] : null,
      description: i % 3 === 0 ? "We use C++, Node.js and .NET; Kubernetes, Español, ingeniería." : null,
      ...SALARIES[i % SALARIES.length],
    };
  });
}

const LONG_SKILL = "distributed-systems ".repeat(30).trim(); // long term: compiled per call, never cached
const RESUMES: Record<string, ResumeRankingSignals | null | undefined> = {
  undefined: undefined,
  null: null, // also what the route passes when the Step 2 flag is disabled
  empty: {},
  emptyArrays: { jobTitles: [], skills: [], preferredRoles: [] },
  blank: { jobTitles: ["  "], skills: ["", " "], preferredRoles: ["\t"], yearsOfExperience: 3 },
  real: {
    jobTitles: ["Backend Engineer", "Data Analyst"],
    preferredRoles: ["Senior Software Engineer"],
    skills: ["C++", "Node.js", ".NET", "SQL", "Español", "ingeniería", "c", LONG_SKILL],
  },
  skillsOnly: { skills: ["Python", "Tableau", "Kubernetes"] },
  titlesOnly: { jobTitles: ["Commercial Counsel"] },
};
const ROLE_SETS: (string[] | undefined)[] = [
  ["Software Engineer"], ["Data Scientist", "ML Engineer"], ["Account Executive"], ["Ingeniero de Software"],
  ["C++ Developer"], [], undefined, ["Product Designer", "UX"],
];
const LEVELS = ["entry", "intern", "mid", "senior", "lead", null, "MID "];
const REMOTES = ["remote", "hybrid", "onsite", "any", null];
const LOCATION_PREFS: Pick<OnboardingAnswers, "locations" | "country" | "countryCode">[] = [
  {}, { locations: ["United States"] }, { locations: ["India"], countryCode: "IN" },
  { locations: ["European Union", "Remote"] }, { country: "Germany" }, { locations: ["Worldwide"] },
  { locations: ["Mexico"] },
];

function answerCases(): (OnboardingAnswers | null | undefined)[] {
  const out: (OnboardingAnswers | null | undefined)[] = [null, undefined, {}];
  const resumeKeys = Object.keys(RESUMES);
  for (const rk of resumeKeys) out.push({ resumeProfile: RESUMES[rk] }); // no onboarding answers, resume-only path
  let k = 0;
  // Every role set x level (resume variant cycling), plus every level x resume variant on one role set
  const combos: [string[] | undefined, string | null, string][] = [];
  for (const roles of ROLE_SETS) for (const lvl of LEVELS) combos.push([roles, lvl, resumeKeys[combos.length % resumeKeys.length]]);
  for (const lvl of LEVELS) for (const rk of resumeKeys) combos.push([ROLE_SETS[0], lvl, rk]);
  for (const [roles, experienceLevel, rk] of combos) {
    {
      {
        out.push({
          roles, experienceLevel,
          remotePreference: REMOTES[k % REMOTES.length],
          ...LOCATION_PREFS[k % LOCATION_PREFS.length],
          categories: k % 3 === 0 ? ["software", "data"] : undefined,
          employmentTypes: k % 4 === 0 ? ["full-time"] : k % 4 === 1 ? ["contract", "internship"] : undefined,
          minSalary: k % 5 === 0 ? 50000 : null,
          salaryCurrency: k % 10 === 0 ? "EUR" : null,
          resumeProfile: RESUMES[rk],
        });
        k++;
      }
    }
  }
  // Full remote x location cross on one profile
  for (const remotePreference of REMOTES) for (const lp of LOCATION_PREFS) {
    out.push({ roles: ["Software Engineer"], experienceLevel: "mid", remotePreference, ...lp, resumeProfile: RESUMES.real });
  }
  return out;
}

// ---------------------------------------------------------------- counters
const counts = { regex: 0, countryScans: 0 };
let counting = false;
const RealRegExp = globalThis.RegExp;
const realEntries = Object.entries;
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  globalThis.RegExp = new Proxy(RealRegExp, {
    construct(t, args, nt) {
      if (counting) counts.regex++;
      return Reflect.construct(t, args, nt);
    },
  });
  Object.entries = ((o: any) => {
    if (counting && o === COUNTRY_CODE_TO_NAME) counts.countryScans++;
    return realEntries(o);
  }) as typeof Object.entries;
});
afterAll(() => {
  globalThis.RegExp = RealRegExp;
  Object.entries = realEntries;
  vi.useRealTimers();
});

function measure<T>(fn: () => T) {
  const early = vi.mocked(experienceLevels.isEarlyCareerJob);
  early.mockClear();
  counts.regex = 0;
  counts.countryScans = 0;
  counting = true;
  try {
    const result = fn();
    return { result, regex: counts.regex, countryScans: counts.countryScans, seniorityEvals: early.mock.calls.length };
  } finally {
    counting = false;
  }
}

// ---------------------------------------------------------------- tests
describe("ranking equivalence with the pre-optimization implementation", () => {
  const jobs = makeJobs(80);
  const cases = answerCases();

  it("returns identical complete ranked output for every answers case", () => {
    let nonEmpty = 0;
    for (const a of cases) {
      const before = legacy.rankJobsByRecommendation(jobs, a);
      const after = current.rankJobsByRecommendation(jobs, a);
      expect(after, JSON.stringify(a)).toStrictEqual(before);
      if (after.length > 0 && a && Object.keys(a).length > 1) nonEmpty++;
    }
    // Guard against a vacuous comparison: most personalized cases must actually rank something
    expect(nonEmpty).toBeGreaterThan(cases.length / 2);
  });

  it("exported helpers return identical results per job", () => {
    for (const a of cases.filter((c, i) => c && i % 4 === 0) as OnboardingAnswers[]) {
      for (const job of jobs) {
        expect(current.scoreJobRecommendation(job, a)).toStrictEqual(legacy.scoreJobRecommendation(job, a));
        expect(current.isRelevantToProfile(job, a)).toBe(legacy.isRelevantToProfile(job, a));
        expect(current.scoreResumeMatch(job, a.resumeProfile)).toStrictEqual(legacy.scoreResumeMatch(job, a.resumeProfile));
      }
      expect(current.buildRelevancePrefilter(a)).toStrictEqual(legacy.buildRelevancePrefilter(a));
    }
    for (const t of [...TITLES, null, "HR Business Partner", "UX Researcher"]) {
      expect(current.fieldsForTitle(t)).toStrictEqual(legacy.fieldsForTitle(t));
    }
  });

  it("eligibility helpers match the old module for raw and normalized countries", () => {
    for (const lp of [...LOCATION_PREFS, { locations: ["Indiana"] }, { locations: ["New Mexico", "UK", "APAC"] }]) {
      const locs = [...(lp.locations || []), ...(lp.country ? [lp.country] : []), ...(lp.countryCode ? [lp.countryCode] : [])];
      const norm = currentElig.normalizeUserCountries(locs);
      expect(norm).toStrictEqual(legacyElig.normalizeUserCountries(locs));
      for (const job of jobs) {
        const old = legacyElig.isJobEligible(job, locs);
        expect(currentElig.isJobEligible(job, locs)).toBe(old);
        expect(currentElig.isJobEligible(job, norm)).toBe(old);
      }
      expect(currentElig.applyEligibilityFilter(jobs, locs)).toStrictEqual(legacyElig.applyEligibilityFilter(jobs, locs));
    }
  });

  it("keeps the resume boost and qualification rules for real resumes", () => {
    const a: OnboardingAnswers = { roles: ["Software Engineer"], experienceLevel: "mid", resumeProfile: RESUMES.real };
    const ranked = current.rankJobsByRecommendation(jobs, a);
    expect(ranked).toStrictEqual(legacy.rankJobsByRecommendation(jobs, a));
    const withoutResume = new Map(current.rankJobsByRecommendation(jobs, { ...a, resumeProfile: null }).map((j) => [j.key, j.matchScore]));
    // The resume never qualifies a job the base answers reject, and it does boost some scores
    expect(ranked.every((j) => withoutResume.has(j.key))).toBe(true);
    expect(ranked.some((j) => j.matchScore! > withoutResume.get(j.key)!)).toBe(true);
  });

  it("cold and warm calls agree, and no user-derived state leaks between calls", async () => {
    const a: OnboardingAnswers = { roles: ["C++ Developer"], experienceLevel: "senior", locations: ["India"], resumeProfile: RESUMES.real };
    const b: OnboardingAnswers = { roles: ["Account Executive"], remotePreference: "onsite", resumeProfile: RESUMES.titlesOnly };
    vi.resetModules();
    counts.regex = 0;
    counting = true;
    const cold = await import("../recommendations").finally(() => (counting = false));
    // Static keyword + country regexes are compiled once here, on the cold path only
    console.log("[ranking-cold-import] regexes compiled at module load:", counts.regex);
    expect(counts.regex).toBeGreaterThan(0);
    const coldA = cold.rankJobsByRecommendation(jobs, a);
    for (const c of cases) current.rankJobsByRecommendation(jobs, c); // warm the long-lived module with every profile
    expect(current.rankJobsByRecommendation(jobs, a)).toStrictEqual(coldA);
    expect(current.rankJobsByRecommendation(jobs, b)).toStrictEqual(legacy.rankJobsByRecommendation(jobs, b));
    expect(current.rankJobsByRecommendation(jobs, a)).toStrictEqual(legacy.rankJobsByRecommendation(jobs, a));
  });

  it("does fewer regex compiles, country-table scans and seniority evaluations on the same fixtures", () => {
    const rows: Record<string, unknown>[] = [];
    const scenarios: [string, OnboardingAnswers][] = [
      ["no resume", { roles: ["Software Engineer"], experienceLevel: "mid", locations: ["United States"], remotePreference: "remote" }],
      ["blank resume", { roles: ["Software Engineer"], experienceLevel: "mid", locations: ["United States"], resumeProfile: RESUMES.blank }],
      ["real resume", { roles: ["Software Engineer"], experienceLevel: "mid", locations: ["United States"], resumeProfile: RESUMES.real }],
      ["resume only", { resumeProfile: RESUMES.real }],
    ];
    for (const [name, a] of scenarios) {
      const before = measure(() => legacy.rankJobsByRecommendation(jobs, a));
      const after = measure(() => current.rankJobsByRecommendation(jobs, a));
      const afterHalf = measure(() => current.rankJobsByRecommendation(jobs.slice(0, 60), a));
      expect(after.result).toStrictEqual(before.result);
      expect(after.regex).toBeLessThan(before.regex);
      expect(after.seniorityEvals).toBeLessThanOrEqual(before.seniorityEvals);
      expect(after.countryScans).toBe(0);
      // Regex compiles depend on the profile only, never on how many jobs are ranked
      expect(afterHalf.regex).toBe(after.regex);
      rows.push({
        scenario: name, jobs: jobs.length,
        regexBefore: before.regex, regexAfter: after.regex,
        countryScansBefore: before.countryScans, countryScansAfter: after.countryScans,
        seniorityEvalsBefore: before.seniorityEvals, seniorityEvalsAfter: after.seniorityEvals,
      });
    }
    // Without resume signals the base score is reused: one scorer evaluation per job instead of two (+1 filter recheck)
    expect(rows[0].seniorityEvalsAfter as number).toBeLessThanOrEqual(jobs.length);
    console.log("[ranking-call-counts]", JSON.stringify(rows));
  });
});
