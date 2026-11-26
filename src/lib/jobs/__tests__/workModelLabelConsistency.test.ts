import { describe, expect, it } from "vitest";
import { workModelLabel } from "../workModel";
import { matchesWorkModelFilter, workModelOrClause } from "../jobFilters";
import { matchesPostgrestOr } from "./postgrestLogicTree";

type Row = { remote: boolean | null; remote_scope: string | null; location: string | null };
const ROWS: Row[] = [
  { remote: true, remote_scope: "hybrid", location: "Remote (US)" },
  { remote: true, remote_scope: null, location: "Hybrid - Berlin" },
  { remote: false, remote_scope: "hybrid", location: "Austin, TX" },
  { remote: true, remote_scope: "worldwide", location: "Remote" },
  { remote: true, remote_scope: null, location: null },
  { remote: false, remote_scope: null, location: "Austin, TX" },
  { remote: true, remote_scope: "onsite", location: "Austin, TX" },
  { remote: false, remote_scope: "remote", location: "Remote" },
  { remote: true, remote_scope: "hybrid", location: null },
  { remote: null, remote_scope: null, location: "Onsite - Paris" },
];
const card = (r: Row) => ({ remote: Boolean(r.remote), remoteScope: r.remote_scope, location: r.location });
const LABEL: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" };

describe("work-model filter agrees with the card label", () => {
  for (const model of ["remote", "hybrid", "onsite"]) {
    it(`${model}: a job passing the filter is never labelled as a different mode (server clause == client mirror)`, () => {
      const clause = workModelOrClause(model)!;
      for (const r of ROWS) {
        const server = matchesPostgrestOr(clause, r);
        expect(server, JSON.stringify(r)).toBe(matchesWorkModelFilter(card(r), model));
        if (server) expect(workModelLabel(card(r)), JSON.stringify(r)).toBe(LABEL[model]);
      }
    });
  }
  it("the QA case: a Remote-flagged Hybrid job is under Hybrid only", () => {
    const r = ROWS[0];
    expect(matchesPostgrestOr(workModelOrClause("remote")!, r)).toBe(false);
    expect(matchesPostgrestOr(workModelOrClause("hybrid")!, r)).toBe(true);
  });
  it("a remote job with no location text still passes Remote (NULL is not hybrid)", () => {
    expect(matchesPostgrestOr(workModelOrClause("remote")!, ROWS[4])).toBe(true);
  });
  it("multi-select is the union", () => {
    const c = workModelOrClause("remote,hybrid")!;
    expect(matchesPostgrestOr(c, ROWS[0])).toBe(true);
    expect(matchesPostgrestOr(c, ROWS[5])).toBe(false);
  });
});
