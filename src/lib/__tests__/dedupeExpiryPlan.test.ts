import { describe, it, expect } from "vitest";
import {
  assertCanonicalSourceIds,
  boardRoleKey,
  boardSourceId,
  buildSourceId,
  dedupeKey,
  isCrossRoleDuplicate,
  planDuplicateExpiry,
  type DedupeRow,
} from "../jobs/highVolumeEnrichment";

/** Each row defaults to its own source (cross-source copy); same apply URL unless overridden. */
const row = (id: string, company: string, title: string, descLen = 0, extra: Partial<DedupeRow> = {}): DedupeRow => ({
  id,
  company,
  title,
  country: "IN",
  location: "Mumbai",
  last_seen_at: "2026-11-01T00:00:00Z",
  source: `src-${id}`,
  source_job_id: `job-${id}`,
  apply_url: "https://jobs.example.com/apply",
  descLen,
  ...extra,
});

/** n unique filler rows so the 1% limit is meaningful. */
const filler = (n: number) => Array.from({ length: n }, (_, i) => row(`f${i}`, `Company ${i}`, `Role ${i}`));

describe("dedupeKey", () => {
  it("never dedupes empty or 1-char company/title, including all-emoji titles", () => {
    expect(dedupeKey("Acme", "")).toBeNull();
    expect(dedupeKey("", "Engineer")).toBeNull();
    expect(dedupeKey("Inc.", "Engineer")).toBeNull(); // only a legal suffix
    expect(dedupeKey("Acme", "😀")).toBeNull();
    expect(dedupeKey("Acme", "  x  ")).toBeNull();
  });

  it("keeps non-Latin titles distinct and folds case/whitespace/NFKC", () => {
    expect(dedupeKey("टाटा", "सॉफ्टवेयर इंजीनियर")).not.toBe(dedupeKey("टाटा", "डेटा विश्लेषक"));
    expect(dedupeKey("阿里巴巴", "软件工程师")).not.toBe(dedupeKey("阿里巴巴", "产品经理"));
    expect(dedupeKey("  ACME Inc. ", " Senior  ENGINEER ")).toBe(dedupeKey("acme", "senior engineer"));
    expect(dedupeKey("Ｍüller", "ﬁnance Straße")).toBe(dedupeKey("müller", "finance strasse"));
  });
});

describe("planDuplicateExpiry", () => {
  const dupes = [
    row("keep", "Acme", "Engineer", 500),
    row("d1", "ACME", "engineer", 10),
    row("hi1", "टाटा", "सॉफ्टवेयर इंजीनियर"),
    row("hi2", "टाटा", "डेटा विश्लेषक"),
    row("e1", "Acme", ""),
    row("e2", "Acme", ""),
  ];

  it("expires only true duplicates, keeps the longest description, skips empty keys", () => {
    const plan = planDuplicateExpiry([...dupes, ...filler(200)], { maxExpire: 100, allowOverOnePercent: false });
    expect(plan.candidates).toEqual([{ id: "d1", keptId: "keep", key: expect.any(String) }]);
    expect(plan.toExpire.map((c) => c.id)).toEqual(["d1"]);
    expect(plan.ineligible).toBe(2);
    expect(plan.blocked).toBe(false);
  });

  it("refuses when duplicates exceed 1% of active rows unless overridden", () => {
    const many = Array.from({ length: 5 }, (_, i) => row(`x${i}`, "Acme", "Engineer"));
    const rows = [...many, ...filler(95)]; // 100 active -> 1% = 1, 4 duplicates
    const blocked = planDuplicateExpiry(rows, { maxExpire: 100, allowOverOnePercent: false });
    expect(blocked.blocked).toBe(true);
    expect(blocked.toExpire).toEqual([]);
    expect(blocked.candidates).toHaveLength(4);

    const allowed = planDuplicateExpiry(rows, { maxExpire: 100, allowOverOnePercent: true });
    expect(allowed.blocked).toBe(false);
    expect(allowed.toExpire).toHaveLength(4);
  });

  it("never expires two REQ IDs from the same source with identical listing text", () => {
    const reqA = row("reqA", "Acme", "Engineer", 500, { source: "greenhouse", source_job_id: "acme-REQ-1" });
    const reqB = row("reqB", "Acme", "Engineer", 10, { source: "greenhouse", source_job_id: "acme-REQ-2" });
    const plan = planDuplicateExpiry([reqA, reqB], { maxExpire: 100, allowOverOnePercent: true });
    expect(plan.candidates).toEqual([]);
    expect(plan.distinctRequisitions).toBe(2);
  });

  it("never expires identical listing text with different apply URLs", () => {
    const a = row("a", "Acme", "Engineer", 500, { apply_url: "https://boards.greenhouse.io/acme/jobs/1" });
    const b = row("b", "Acme", "Engineer", 10, { apply_url: "https://boards.greenhouse.io/acme/jobs/2" });
    expect(planDuplicateExpiry([a, b], { maxExpire: 100, allowOverOnePercent: true }).candidates).toEqual([]);
  });

  it("still expires a cross-source copy of the same apply URL (fragment/trailing slash ignored, query kept)", () => {
    const a = row("a", "Acme", "Engineer", 500, { apply_url: "https://x.com/jobs/1/?gh_jid=9" });
    const b = row("b", "Acme", "Engineer", 10, { apply_url: "https://x.com/jobs/1?gh_jid=9#apply" });
    const c = row("c", "Acme", "Engineer", 10, { apply_url: "https://x.com/jobs/1?gh_jid=10" });
    const plan = planDuplicateExpiry([a, b, c], { maxExpire: 100, allowOverOnePercent: true });
    expect(plan.candidates).toEqual([{ id: "b", keptId: "a", key: expect.any(String) }]);
  });

  it("caps each run at maxExpire", () => {
    const many = Array.from({ length: 6 }, (_, i) => row(`x${i}`, "Acme", "Engineer"));
    const plan = planDuplicateExpiry(many, { maxExpire: 2, allowOverOnePercent: true });
    expect(plan.candidates).toHaveLength(5);
    expect(plan.toExpire).toHaveLength(2);
  });
});

describe("board-ingest cross-role skip", () => {
  const job = (source: string, apply_url: string) => ({ company: "Acme", title: "Engineer", location: "Pune", apply_url, source });

  it("never skips a second REQ ID from the same source with identical listing text", () => {
    const held = new Map([[boardRoleKey(job("greenhouse-board", "https://a/1"))!, new Set(["greenhouse-board"])]]);
    const reqB = job("greenhouse-board", "https://a/1");
    expect(isCrossRoleDuplicate(held, boardRoleKey(reqB), reqB.source)).toBe(false);
  });

  it("never skips identical listing text with a different apply URL", () => {
    const held = new Map([[boardRoleKey(job("greenhouse", "https://a/1"))!, new Set(["greenhouse"])]]);
    const other = job("greenhouse-board", "https://a/2");
    expect(isCrossRoleDuplicate(held, boardRoleKey(other), other.source)).toBe(false);
  });

  it("skips the same apply URL already held by another source", () => {
    const held = new Map([[boardRoleKey(job("greenhouse", "https://a/1"))!, new Set(["greenhouse"])]]);
    const copy = job("greenhouse-board", "https://a/1");
    expect(isCrossRoleDuplicate(held, boardRoleKey(copy), copy.source)).toBe(true);
  });
});

describe("canonical source_id write gate", () => {
  it("rejects a write with a null/empty source_id row (would bypass the partial unique index)", () => {
    expect(() => assertCanonicalSourceIds([{ source_id: "greenhouse:acme" }, { source_id: null }])).toThrow(/1 row\(s\)/);
    expect(() => assertCanonicalSourceIds([{}])).toThrow();
    expect(() => assertCanonicalSourceIds([{ source_id: "  " }])).toThrow();
    expect(() => assertCanonicalSourceIds([{ source_id: "greenhouse:acme" }])).not.toThrow();
  });

  it("builds board source_id as <vendor>:<board_token> and refuses a missing board slug", () => {
    expect(boardSourceId({ source: "greenhouse-board", company_slug: "Stripe" })).toBe("greenhouse:stripe");
    expect(buildSourceId("greenhouse", "stripe")).toBe(boardSourceId({ source: "greenhouse-board", company_slug: "stripe" }));
    expect(() => boardSourceId({ source: "greenhouse-board" })).toThrow();
  });
});
