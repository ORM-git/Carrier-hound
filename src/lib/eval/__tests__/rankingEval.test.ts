import { readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { capJobsPerCompany } from "@/lib/jobs/capping";
import { rankJobsByRecommendation } from "@/lib/jobs/recommendations";
import { evaluateDataset, validateDataset, type EvalDataset } from "../rankingEval";

const load = (): EvalDataset => JSON.parse(readFileSync("scripts/eval/ranking/synthetic-v1.json", "utf8"));

describe("offline ranking eval on the synthetic fixture", () => {
  it("is deterministic: two runs give identical results", () => {
    expect(JSON.stringify(evaluateDataset(load()))).toBe(JSON.stringify(evaluateDataset(load())));
  });

  it("uses the production ranker pipeline (rank, qualifying filter, per-company cap) at the dataset instant", () => {
    const d = load();
    const now = Date.parse(d.referenceTime);
    const r = evaluateDataset(d);
    for (const p of d.profiles) {
      const pool = p.candidates.map((id) => d.jobs.find((j) => j.id === id)!);
      const ranked = rankJobsByRecommendation(pool, p.answers, now);
      const expected = capJobsPerCompany(p.answers && Object.keys(p.answers).some((k) => k !== "resumeProfile") ? ranked.filter((j) => (j.matchScore ?? 0) > 0) : ranked, 3, 30);
      expect(r.profiles.find((x) => x.id === p.id)!.ranked, p.id).toEqual(expected.map((j) => ({ id: j.id, score: j.matchScore ?? null })));
    }
  });

  it("reports counts, coverage, undefined metrics and the synthetic flag", () => {
    const r = evaluateDataset(load());
    expect(r.dataset.synthetic).toBe(true);
    expect(r.counts.profiles).toBe(7);
    expect(r.labelCoverage).toEqual({ pairs: 41, relevanceJudged: 39, eligibilityJudged: 39 });
    const empty = r.profiles.find((p) => p.id === "syn-no-relevant-pool")!;
    expect(empty.metrics.ndcgAtK).toBeNull();
    expect(r.macro.ndcgAtK.excluded).toBe(1);
    // Every profile covers a distinct role / level / work-model / location combination
    expect(new Set(load().profiles.map((p) => `${p.answers?.roles}|${p.answers?.experienceLevel}|${p.answers?.remotePreference}`)).size).toBe(7);
  });

  it("detects a hard-filter violation end to end when a label marks a returned job ineligible", () => {
    const d = load();
    const p = d.profiles.find((x) => x.id === "syn-fe-mid-remote-us")!;
    p.labels.j02 = { relevance: 3, eligibility: "ineligible" }; // label disagrees with the ranker on purpose
    const m = evaluateDataset(d).profiles.find((x) => x.id === p.id)!.metrics;
    expect(m.hardFilterViolationsInTopK).toEqual(["j02"]);
  });

  it("evaluates one split only: tuning profiles never enter held-out numbers", () => {
    const d = load();
    d.profiles[0].split = "tuning";
    const evalOnly = evaluateDataset(d, "eval");
    expect(evalOnly.counts).toMatchObject({ profiles: 6, skippedOtherSplit: 1 });
    expect(evalOnly.profiles.map((p) => p.id)).not.toContain(d.profiles[0].id);
    expect(evaluateDataset(d, "tuning").profiles.map((p) => p.id)).toEqual([d.profiles[0].id]);
  });

  it("rejects malformed datasets instead of guessing", () => {
    const bad = (mutate: (d: EvalDataset) => void) => {
      const d = load();
      mutate(d);
      return () => validateDataset(d);
    };
    expect(bad((d) => d.jobs.push({ ...d.jobs[0] }))).toThrow(/duplicate job id j01/);
    expect(bad((d) => d.profiles[0].candidates.push("j01"))).toThrow(/duplicate candidate j01/);
    expect(bad((d) => (d.profiles[0].labels.j27 = { relevance: 1 }))).toThrow(/label for non-candidate j27/);
    expect(bad((d) => (d.profiles[0].labels.j02 = { relevance: 5 as any }))).toThrow(/relevance must be 0-3/);
    expect(bad((d) => ((d.profiles[0] as any).labelProvenance = ""))).toThrow(/labelProvenance is required/);
    expect(bad((d) => ((d as any).referenceTime = "soon"))).toThrow(/referenceTime/);
    expect(bad(() => undefined)).not.toThrow();
  });
});

// ---- human-judging-v1: the worksheet is generated from the dataset and must match it field for field ----

const JUDGING_DIR = "scripts/eval/ranking";
const JUDGING_DATASET = `${JUDGING_DIR}/human-judging-v1.json`;
const JUDGING_WORKSHEET = `${JUDGING_DIR}/human-judging-v1-worksheet.csv`;
const JUDGING_COLUMNS = ["relevance", "eligibility", "reason", "judge", "date"];
const NOT_STATED = "not stated"; // the profile did not give this input
const NOT_LISTED = "not listed"; // the job did not give this input

type Profile = EvalDataset["profiles"][number];
type Answers = NonNullable<Profile["answers"]>;
type Job = EvalDataset["jobs"][number];

/** JSON with sorted keys, so a snapshot does not depend on key order. */
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v ?? null);

const list = (v: unknown, unknown: string) => (Array.isArray(v) && v.length ? v.join("; ") : unknown);
const text = (v: unknown, unknown: string) => (v === null || v === undefined || v === "" ? unknown : String(v));

// Every ranker input in the dataset gets a worksheet column; the coverage test fails if a new field has none.
const CANDIDATE_FIELDS: [string, (a: Answers) => string][] = [
  ["candidate_target_roles", (a) => list(a.roles, NOT_STATED)],
  ["candidate_experience_level", (a) => text(a.experienceLevel, NOT_STATED)],
  ["candidate_work_model", (a) => text(a.remotePreference, NOT_STATED)],
  ["candidate_locations", (a) => list(a.locations, NOT_STATED)],
  ["candidate_country", (a) => text(a.countryCode ?? a.country, NOT_STATED)],
  ["candidate_employment_types", (a) => list(a.employmentTypes, NOT_STATED)],
  ["candidate_categories", (a) => list(a.categories, NOT_STATED)],
  ["candidate_min_salary", (a) => (a.minSalary ? `${a.minSalary} ${text(a.salaryCurrency, "(currency not stated)")}` : NOT_STATED)],
  ["resume_job_titles", (a) => list(a.resumeProfile?.jobTitles, NOT_STATED)],
  ["resume_skills", (a) => list(a.resumeProfile?.skills, NOT_STATED)],
  ["resume_preferred_roles", (a) => list(a.resumeProfile?.preferredRoles, NOT_STATED)],
  ["resume_years_experience", (a) => text(a.resumeProfile?.yearsOfExperience, NOT_STATED)],
];
const CANDIDATE_KEYS = ["roles", "experienceLevel", "remotePreference", "locations", "countryCode", "country", "employmentTypes", "categories", "minSalary", "salaryCurrency", "resumeProfile"];
const RESUME_KEYS = ["jobTitles", "skills", "preferredRoles", "yearsOfExperience"];

const salaryOf = (j: Job) =>
  j.salary_min || j.salary_max
    ? `${text(j.salary_min, "?")}-${text(j.salary_max, "?")} ${text(j.currency, "(currency not listed)")} ${text(j.salary_period, "")}`.trim()
    : NOT_LISTED;

const JOB_FIELDS: [string, (j: Job) => string][] = [
  ["job_title", (j) => text(j.title, NOT_LISTED)],
  ["company", (j) => text(j.company, NOT_LISTED)],
  ["job_category", (j) => text(j.category, NOT_LISTED)],
  ["job_location", (j) => text(j.location, NOT_LISTED)],
  ["job_country", (j) => text(j.country_code ?? j.country, NOT_LISTED)],
  ["job_remote", (j) => (j.remote === true ? "yes" : j.remote === false ? "no" : NOT_LISTED)],
  ["job_work_model", (j) => text(j.remote_scope, NOT_LISTED)],
  ["job_remote_restriction", (j) => text(j.remote_eligibility, j.remote ? NOT_LISTED : "n/a (not remote)")],
  ["job_type", (j) => text(j.job_type, NOT_LISTED)],
  ["job_posted_at", (j) => text(j.posted_at, NOT_LISTED)],
  ["job_salary", salaryOf],
  ["job_skills", (j) => list(j.skills, NOT_LISTED)],
  ["job_description", (j) => text(j.description, NOT_LISTED)],
];
const JOB_KEYS = ["id", "title", "company", "category", "location", "country_code", "country", "remote", "remote_scope", "remote_eligibility", "job_type", "posted_at", "salary_min", "salary_max", "currency", "salary_period", "skills", "description"];

const HEADER = [
  "snapshot",
  "dataset_version",
  "reference_time",
  "candidate_id",
  "candidate_summary",
  ...CANDIDATE_FIELDS.map((f) => f[0]),
  "job_id",
  ...JOB_FIELDS.map((f) => f[0]),
  ...JUDGING_COLUMNS,
];

/** sha256 over everything a judge sees or the ranker reads for this pair; judging columns are excluded. */
function snapshotOf(d: EvalDataset, p: Profile, job: Job): string {
  const hash = createHash("sha256")
    .update(canonical({ version: d.version, referenceTime: d.referenceTime, profile: { id: p.id, description: p.description ?? null, answers: p.answers }, job }))
    .digest("hex");
  return `${d.version}/${p.id}/${job.id}@${hash.slice(0, 16)}`;
}

function worksheetRows(d: EvalDataset): string[][] {
  const byId = new Map(d.jobs.map((j) => [j.id, j]));
  return d.profiles.flatMap((p) =>
    p.candidates.map((id) => {
      const job = byId.get(id)!;
      const a = p.answers ?? {};
      return [
        snapshotOf(d, p, job),
        d.version,
        d.referenceTime,
        p.id,
        text(p.description, NOT_STATED),
        ...CANDIDATE_FIELDS.map(([, f]) => f(a)),
        job.id,
        ...JOB_FIELDS.map(([, f]) => f(job)),
        ...JUDGING_COLUMNS.map(() => ""),
      ];
    }),
  );
}

const csvField = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (rows: string[][]) => rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
// shortcut: no newlines inside fields; generatedWorksheet() rejects any, so this parser is enough
const parseLine = (line: string) =>
  Array.from(line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g)).map((m) => m[1].replace(/^"|"$/g, "").replace(/""/g, '"'));
const parseCsv = (csv: string) => csv.replace(/\r?\n$/, "").split(/\r?\n/).map(parseLine);

function generatedWorksheet(d: EvalDataset): string {
  const rows = worksheetRows(d);
  if (rows.flat().some((v) => /[\r\n]/.test(v))) throw new Error("worksheet fields must not contain newlines");
  return toCsv([HEADER, ...rows]);
}

/** Every difference between a worksheet and what the dataset generates, by row and column. Empty = consistent. */
function worksheetDrift(d: EvalDataset, csv: string): string[] {
  const want = parseCsv(generatedWorksheet(d));
  const got = parseCsv(csv);
  const errors: string[] = [];
  if (got.length !== want.length) errors.push(`expected ${want.length - 1} rows, found ${got.length - 1}`);
  for (let r = 0; r < Math.max(got.length, want.length); r++) {
    if (got[r] && got[r].length !== HEADER.length) errors.push(`row ${r}: ${got[r].length} columns, expected ${HEADER.length}`);
    for (let c = 0; c < HEADER.length; c++) {
      const g = got[r]?.[c] ?? "<missing>";
      const w = want[r]?.[c] ?? "<missing>";
      if (g !== w) errors.push(`row ${r} ${HEADER[c]}: "${g}" != "${w}"`);
    }
  }
  return errors;
}

// Regenerate after a dataset edit (judging columns come out blank):
//   REGENERATE_JUDGING_WORKSHEET=1 npx vitest run src/lib/eval
if (process.env.REGENERATE_JUDGING_WORKSHEET === "1") {
  writeFileSync(JUDGING_WORKSHEET, generatedWorksheet(JSON.parse(readFileSync(JUDGING_DATASET, "utf8"))));
}

describe("human-judging-v1 package (judging pending)", () => {
  const loadD = (): EvalDataset => JSON.parse(readFileSync(JUDGING_DATASET, "utf8"));
  const csv = readFileSync(JUDGING_WORKSHEET, "utf8");

  it("is a valid synthetic dataset with no labels and pending provenance", () => {
    const d = loadD();
    expect(() => validateDataset(d)).not.toThrow();
    expect(d.synthetic).toBe(true);
    for (const p of d.profiles) {
      expect(p.labels, p.id).toEqual({});
      expect(p.labelProvenance).toMatch(/^pending/);
    }
  });

  it("worksheet matches the dataset in every field of every row", () => {
    expect(worksheetDrift(loadD(), csv)).toEqual([]);
    expect(parseCsv(csv)[0]).toEqual(HEADER);
    expect(parseCsv(csv).length - 1).toBe(31);
  });

  it("every ranker input in the dataset has a worksheet column, and no score or rank is shown", () => {
    const d = loadD();
    for (const p of d.profiles) {
      for (const k of Object.keys(p.answers ?? {})) expect(CANDIDATE_KEYS, `${p.id}.answers.${k}`).toContain(k);
      for (const k of Object.keys(p.answers?.resumeProfile ?? {})) expect(RESUME_KEYS, `${p.id}.resumeProfile.${k}`).toContain(k);
    }
    for (const j of d.jobs) for (const k of Object.keys(j)) expect(JOB_KEYS, `${j.id}.${k}`).toContain(k);
    expect(HEADER.join(",")).not.toMatch(/score|rank|position/i);
  });

  it("snapshot is deterministic and covers version, reference time, profile and job", () => {
    const d = loadD();
    const [p] = d.profiles;
    const job = d.jobs.find((j) => j.id === p.candidates[0])!;
    const base = snapshotOf(d, p, job);
    expect(snapshotOf(loadD(), loadD().profiles[0], job)).toBe(base);
    expect(snapshotOf(d, p, Object.fromEntries(Object.entries(job).reverse()) as Job)).toBe(base); // key order is not content
    expect(snapshotOf({ ...d, version: "other" }, p, job)).not.toBe(base);
    expect(snapshotOf({ ...d, referenceTime: "2027-01-01T00:00:00Z" }, p, job)).not.toBe(base);
    expect(snapshotOf(d, { ...p, id: "other" }, job)).not.toBe(base);
    expect(snapshotOf(d, { ...p, answers: { ...p.answers, minSalary: 1 } }, job)).not.toBe(base);
    expect(snapshotOf(d, p, { ...job, skills: ["COBOL"] })).not.toBe(base);
  });

  describe("drift detection: every altered fixture fails, every regenerated one passes", () => {
    const datasetMutations: [string, (d: EvalDataset) => void, RegExp][] = [
      ["candidate country", (d) => (d.profiles[0].answers!.countryCode = "US"), /candidate_country/],
      ["candidate answers: min salary", (d) => (d.profiles[3].answers!.minSalary = 90000), /candidate_min_salary/],
      ["candidate answers: work model", (d) => (d.profiles[1].answers!.remotePreference = "remote"), /candidate_work_model/],
      ["resume skills", (d) => d.profiles[6].answers!.resumeProfile!.skills!.push("Kafka"), /resume_skills/],
      ["profile summary", (d) => (d.profiles[0].description = "Junior designer."), /candidate_summary/],
      ["job skills", (d) => (d.jobs[0].skills = ["Angular"]), /job_skills/],
      ["job remote restriction", (d) => (d.jobs[0].remote_eligibility = "worldwide"), /job_remote_restriction/],
      ["job country", (d) => (d.jobs[2].country_code = "CA"), /job_country/],
      ["job salary", (d) => (d.jobs[16].salary_max = 200000), /job_salary/],
      ["reference time only (stale snapshot)", (d) => (d.referenceTime = "2026-12-31T00:00:00Z"), /reference_time/],
      ["dataset version only (stale snapshot)", (d) => (d.version = "human-judging-v2"), /dataset_version/],
    ];
    for (const [name, mutate, column] of datasetMutations) {
      it(`dataset edit: ${name}`, () => {
        const d = loadD();
        mutate(d);
        const drift = worksheetDrift(d, csv).join("\n");
        expect(drift).toMatch(column);
        expect(drift).toMatch(/ snapshot: /); // the old snapshot is invalidated too
        expect(worksheetDrift(d, generatedWorksheet(d))).toEqual([]);
      });
    }

    const editCell = (profileId: string, jobId: string, column: string, value: string) => {
      const rows = parseCsv(csv);
      const row = rows.find((r) => r[HEADER.indexOf("candidate_id")] === profileId && r[HEADER.indexOf("job_id")] === jobId)!;
      row[HEADER.indexOf(column)] = value;
      return toCsv(rows);
    };
    const csvMutations: [string, string, string, string, string][] = [
      ["job description", "hj-fe-senior-remote-in", "h03", "job_description", "Remote anywhere, no work authorization needed."],
      ["job salary", "hj-pm-lead-any-ca-minsalary", "h17", "job_salary", "170000-190000 CAD yearly"],
      ["job location", "hj-devops-mid-onsite-london", "h13", "job_location", "London, United Kingdom"],
      ["job skills", "hj-resume-only-java-backend", "h28", "job_skills", "Go"],
      ["job remote restriction", "hj-intern-swe-remote-anywhere", "h21", "job_remote_restriction", "worldwide"],
      ["candidate country", "hj-fe-senior-remote-in", "h01", "candidate_country", "US"],
      ["candidate summary", "hj-fe-senior-remote-in", "h01", "candidate_summary", "Junior designer."],
      ["stale snapshot", "hj-fe-senior-remote-in", "h01", "snapshot", "human-judging-v1/h01@5c8a8c18d517"],
    ];
    for (const [name, profileId, jobId, column, value] of csvMutations) {
      it(`worksheet edit: ${name}`, () => {
        const drift = worksheetDrift(loadD(), editCell(profileId, jobId, column, value));
        expect(drift).toHaveLength(1);
        expect(drift[0]).toMatch(new RegExp(`^row \\d+ ${column}: `));
      });
    }

    it("worksheet edit: a dropped row or an extra column fails", () => {
      const lines = csv.trimEnd().split("\n");
      expect(worksheetDrift(loadD(), lines.slice(0, -1).join("\n") + "\n").join("\n")).toMatch(/expected 31 rows, found 30/);
      expect(worksheetDrift(loadD(), lines.map((l) => l + ",x").join("\n") + "\n").join("\n")).toMatch(/columns, expected/);
    });
  });

  it("ships with every judging column blank and reports zero human-label coverage", () => {
    const rows = parseCsv(csv).slice(1);
    for (const name of JUDGING_COLUMNS) expect(rows.every((r) => r[HEADER.indexOf(name)] === ""), name).toBe(true);
    const r = evaluateDataset(loadD());
    expect(r.labelCoverage).toEqual({ pairs: 31, relevanceJudged: 0, eligibilityJudged: 0 });
    expect(r.macro.ndcgAtK).toMatchObject({ mean: null, included: 0 });
  });
});
