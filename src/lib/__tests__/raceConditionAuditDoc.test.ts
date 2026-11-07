/**
 * Race-condition row: the audit in docs/race-condition-audit.md must stay
 * truthful against the guards it names, so documented protections cannot
 * rot away from the code.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";

const doc = fs.readFileSync("docs/race-condition-audit.md", "utf8");
const jobs = fs.readFileSync("src/app/jobs/page.tsx", "utf8");
const adminUsers = fs.readFileSync("src/app/admin/users/page.tsx", "utf8");
const tracker = fs.readFileSync("src/lib/tracker/storage.ts", "utf8");
const swr = fs.readFileSync("src/lib/cache/swr.ts", "utf8");

describe("race-condition audit doc", () => {
  it("names the real guards on the jobs page", () => {
    expect(doc).toContain("inFlightSaveRef");
    expect(jobs).toContain("inFlightSaveRef");
    expect(jobs).toContain("inFlightAppliedRef");
    expect(jobs).toContain("cancelled = true");
  });

  it("names the tracker generation token against the real constant", () => {
    expect(doc).toContain("activeTrackerGenToken");
    expect(tracker).toContain("activeTrackerGenToken");
  });

  it("names the admin users sequence guards against the real refs", () => {
    expect(doc).toContain("fetchSeqRef");
    expect(doc).toContain("activitySeqRef");
    expect(adminUsers).toContain("fetchSeqRef.current");
    expect(adminUsers).toContain("activitySeqRef.current");
  });

  it("names the SWR dedupe guard against the real export", () => {
    expect(doc).toContain("swrFetch");
    expect(swr).toContain("export async function swrFetch");
  });

  it("names a guard for every row of its own table", () => {
    const rows = doc.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| ---") && !l.startsWith("| Surface"));
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
      expect(cells.length).toBe(3);
      expect(cells[2].length).toBeGreaterThan(10);
    }
  });
});
