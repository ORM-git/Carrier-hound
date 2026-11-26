// Real Postgres (PGlite) evaluates the exact imatch pattern the server clause sends; JS must agree row by row.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { directorPgPattern, isDirectorTitle } from "../experienceLevels";
import { buildExperienceLevelOrClause } from "../experienceLevels";
import { matchesPostgrestOr } from "./postgrestLogicTree";

const PHRASES = ["director", "vp", "vice president", "head of", "chief"];
const TITLES = [
  "Director of Engineering", "Engineering Director", "Associate Director, Frontend", "VP Engineering", "vp, sales", "Vice President of Sales",
  "Head of Frontend", "Chief Technology Officer", "Directorate Analyst", "Directory Admin", "Misdirector", "Édirector Group", "Directeur Général",
  "Director\u00e9 Lead", "Naïve VPN Engineer", "VPN Engineer", "Chiefly Engineer", "Ahead of Time Dev", "Réchief", "Frontend Engineer", "Senior Engineer", "director", "DIRECTOR", "Sub-director ops", "director_ops", "director2", "Direktör",
];

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
});
afterAll(async () => {
  await db.close();
});

describe("Director classification: JS and Postgres agree on identical explicit boundaries", () => {
  for (const title of TITLES) {
    it(JSON.stringify(title), async () => {
      let pg = false;
      for (const ph of PHRASES) {
        const r = await db.query<{ m: boolean }>("select $1::text ~* $2::text as m", [title, directorPgPattern(ph)]);
        pg = pg || r.rows[0].m;
      }
      expect(pg).toBe(isDirectorTitle(title));
    });
  }
  it("the clause the route sends classifies the same rows as the client for a Director-only selection", () => {
    const clause = buildExperienceLevelOrClause("director")!;
    for (const t of TITLES) {
      expect(matchesPostgrestOr(clause, { title: t, job_type: "full-time" }), t).toBe(isDirectorTitle(t));
    }
  });
});
