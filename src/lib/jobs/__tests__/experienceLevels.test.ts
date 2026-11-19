import { describe, it, expect } from "vitest";
import {
  CANONICAL_EXPERIENCE_LEVELS,
  applyExperienceLevelQuery,
  buildExperienceLevelOrClause,
  classifyJobExperienceLevel,
  formatExperienceLevels,
  isExperienceLevelFilterActive,
  matchesExperienceLevelFilter,
  parseExperienceLevels,
  type CanonicalExperienceLevel,
} from "../experienceLevels";

import { matchesPostgrestOr } from "./postgrestLogicTree";

type Row = { title: string | null; job_type: string | null };
/** Rows the server returns for a selection (a top-level `or` filter keeps rows evaluating TRUE). */
const serverSelects = (rows: Row[], level: string) => {
  const clause = buildExperienceLevelOrClause(level);
  return clause === null ? rows : rows.filter((r) => matchesPostgrestOr(clause, r));
};

const CORPUS: Row[] = [
  { title: "Senior Backend Engineer", job_type: "full-time" },
  { title: "Sr. Frontend Engineer", job_type: null },
  { title: "Senior Staff Engineer", job_type: "full-time" }, // lead wins over senior
  { title: "Staff Software Engineer", job_type: "full-time" },
  { title: "Principal Architect", job_type: "contract" },
  { title: "Tech Lead, Payments", job_type: "full-time" },
  { title: "Junior Data Analyst", job_type: "full-time" },
  { title: "Associate Product Manager", job_type: null },
  { title: "Entry Level Support Engineer", job_type: "part-time" },
  { title: "Senior Associate", job_type: "full-time" }, // senior wins over entry
  { title: "Software Engineer", job_type: "full-time" },
  { title: "Backend Developer", job_type: null },
  { title: "Software Engineering Intern", job_type: "internship" },
  { title: "Senior Intern Program Lead", job_type: "internship" }, // intern (job_type) wins
  { title: "International Sales Manager", job_type: "full-time" }, // no title-based intern guess
  { title: "SENIOR DEVOPS ENGINEER", job_type: "Full-Time" },
];

const ALL_SUBSETS: CanonicalExperienceLevel[][] = [];
for (let mask = 1; mask < 1 << CANONICAL_EXPERIENCE_LEVELS.length; mask++) {
  ALL_SUBSETS.push(CANONICAL_EXPERIENCE_LEVELS.filter((_, i) => mask & (1 << i)));
}

describe("parseExperienceLevels", () => {
  it("normalizes, dedupes and orders comma-separated levels", () => {
    expect(parseExperienceLevels("senior,entry")).toEqual(["entry", "senior"]);
    expect(parseExperienceLevels("  ENTRY , Senior ,senior")).toEqual(["entry", "senior"]);
    expect(parseExperienceLevels(["junior,mid", "lead"])).toEqual(["entry", "mid", "lead"]);
  });

  it("accepts intern/lead aliases and legacy single-level URL values", () => {
    expect(parseExperienceLevels("internship")).toEqual(["intern"]);
    expect(parseExperienceLevels("Intern / New Grad")).toEqual(["intern"]);
    expect(parseExperienceLevels("staff")).toEqual(["lead"]);
    expect(parseExperienceLevels("Staff / Principal / Lead")).toEqual(["lead"]);
    for (const legacy of ["entry", "mid", "senior", "lead", "Senior Level", "Entry Level", "Mid Level"]) {
      expect(parseExperienceLevels(legacy)).toHaveLength(1);
    }
  });

  it("treats empty/all as no filter and drops invalid, unsupported (director) and injected values", () => {
    for (const none of ["", "   ", "all", null, undefined, ","]) expect(parseExperienceLevels(none)).toEqual([]);
    expect(parseExperienceLevels("entry,director,manager")).toEqual(["entry"]);
    expect(parseExperienceLevels("senior,title.ilike.%x%)") ).toEqual(["senior"]);
    expect(parseExperienceLevels("'; DROP TABLE jobs;--,or(id.gt.0)")).toEqual([]);
  });

  it("bounds input length and token count", () => {
    expect(parseExperienceLevels("x,".repeat(5000) + "senior")).toEqual([]);
    expect(parseExperienceLevels("senior," + "x,".repeat(5000))).toEqual(["senior"]);
  });

  it("isExperienceLevelFilterActive: 1-4 levels filter; empty/all/all five do not", () => {
    expect(isExperienceLevelFilterActive("entry,senior")).toBe(true);
    expect(isExperienceLevelFilterActive("all")).toBe(false);
    expect(isExperienceLevelFilterActive("intern,entry,mid,senior,lead")).toBe(false);
    expect(formatExperienceLevels(parseExperienceLevels("senior,entry"))).toBe("entry,senior");
  });
});

describe("classifyJobExperienceLevel (existing heuristic, no new title keywords)", () => {
  it("keeps the pre-existing keyword priority lead > senior > entry > mid", () => {
    expect(classifyJobExperienceLevel("Senior Staff Engineer")).toBe("lead");
    expect(classifyJobExperienceLevel("Senior Associate")).toBe("senior");
    expect(classifyJobExperienceLevel("Associate Product Manager")).toBe("entry");
    expect(classifyJobExperienceLevel("Software Engineer")).toBe("mid");
  });

  it("intern comes only from the existing job_type field, never a title guess", () => {
    expect(classifyJobExperienceLevel("Anything", "internship")).toBe("intern");
    expect(classifyJobExperienceLevel("Software Engineering Intern", "full-time")).toBe("mid");
    expect(classifyJobExperienceLevel("International Sales Manager", null)).toBe("mid");
  });
});

describe("server/client agreement", () => {
  it("for all 31 selections, the server clause returns exactly the jobs the client predicate accepts", () => {
    for (const subset of ALL_SUBSETS) {
      const level = subset.join(",");
      const server = serverSelects(CORPUS, level).map((r) => r.title);
      const client = CORPUS.filter((r) => matchesExperienceLevelFilter({ title: r.title, job_type: r.job_type }, level)).map(
        (r) => r.title
      );
      expect(server, level).toEqual(client);
    }
  });

  it("entry+senior is a true OR: both tiers returned, nothing else", () => {
    const got = serverSelects(CORPUS, "entry,senior").map((r) => r.title);
    expect(got).toEqual([
      "Senior Backend Engineer",
      "Sr. Frontend Engineer",
      "Junior Data Analyst",
      "Associate Product Manager",
      "Entry Level Support Engineer",
      "Senior Associate",
      "SENIOR DEVOPS ENGINEER",
    ]);
  });

  it("level selections partition the corpus (each job in exactly one tier)", () => {
    const counts = CANONICAL_EXPERIENCE_LEVELS.map((l) => serverSelects(CORPUS, l).length);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(CORPUS.length);
  });
});

describe("applyExperienceLevelQuery", () => {
  const mock = () => {
    const calls: string[] = [];
    const q = { or: (e: string) => (calls.push(e), q), calls };
    return q;
  };

  it("adds nothing for empty/all/all five; one .or() otherwise (AND-ed with other filters by the caller)", () => {
    for (const none of ["", "all", "intern,entry,mid,senior,lead", "director"]) {
      const q = mock();
      applyExperienceLevelQuery(q, none);
      expect(q.calls).toEqual([]);
    }
    const q = mock();
    applyExperienceLevelQuery(q, "entry,senior");
    expect(q.calls).toHaveLength(1);
  });

  it("injected values never reach the expression: output equals the clean selection's", () => {
    expect(buildExperienceLevelOrClause("senior,or(id.gt.0),title.ilike.*")).toBe(buildExperienceLevelOrClause("senior"));
    for (const subset of ALL_SUBSETS) {
      const clause = buildExperienceLevelOrClause(subset.join(","));
      if (clause === null) continue; // all five levels: no filter
      expect(clause).toMatch(/^[a-z_.%(),]+$/); // only allowlisted constant characters
    }
  });
});

describe("NEGATIVE CONTROL: the old behavior fails these contracts", () => {
  // Old client (jobs page): inferJobLevel(title).toLowerCase().includes(selectedLevel) on the whole string.
  const oldInfer = (t: string) => {
    const s = t.toLowerCase();
    if (s.includes("staff") || s.includes("principal") || s.includes("lead")) return "Staff / Lead";
    if (s.includes("senior") || s.includes("sr.")) return "Senior Level";
    if (s.includes("junior") || s.includes("entry") || s.includes("associate")) return "Entry Level";
    return "";
  };
  const oldClient = (t: string, level: string) => oldInfer(t).toLowerCase().includes(level.toLowerCase());
  // Old server: the first matching else-if branch only.
  const oldServerBranch = (level: string) => {
    const l = level.toLowerCase();
    if (l.includes("lead") || l.includes("staff")) return "lead";
    if (l.includes("senior")) return "senior";
    if (l.includes("entry") || l.includes("junior")) return "entry";
    if (l.includes("mid")) return "mid";
    return null;
  };

  it("old whole-string client check rejects both tiers of entry,senior; the new predicate accepts them", () => {
    expect(oldClient("Senior Backend Engineer", "entry,senior")).toBe(false);
    expect(oldClient("Junior Data Analyst", "entry,senior")).toBe(false);
    expect(matchesExperienceLevelFilter({ title: "Senior Backend Engineer" }, "entry,senior")).toBe(true);
    expect(matchesExperienceLevelFilter({ title: "Junior Data Analyst" }, "entry,senior")).toBe(true);
    // Old client "mid" never matched anything (inferJobLevel returned "" for mid titles).
    expect(oldClient("Software Engineer", "mid")).toBe(false);
    expect(matchesExperienceLevelFilter({ title: "Software Engineer" }, "mid")).toBe(true);
  });

  it("old first-branch server filter applies only one tier of entry,senior", () => {
    expect(oldServerBranch("entry,senior")).toBe("senior"); // entry silently dropped
    const server = serverSelects(CORPUS, "entry,senior").map((r) => r.title);
    expect(server).toContain("Junior Data Analyst");
  });
});
