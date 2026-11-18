import { describe, it, expect } from "vitest";
import { dedupeKey, planDuplicateExpiry, type DedupeRow } from "../jobs/highVolumeEnrichment";

const row = (id: string, company: string, title: string, descLen = 0): DedupeRow => ({
  id,
  company,
  title,
  country: "IN",
  location: "Mumbai",
  last_seen_at: "2026-11-01T00:00:00Z",
  descLen,
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

  it("caps each run at maxExpire", () => {
    const many = Array.from({ length: 6 }, (_, i) => row(`x${i}`, "Acme", "Engineer"));
    const plan = planDuplicateExpiry(many, { maxExpire: 2, allowOverOnePercent: true });
    expect(plan.candidates).toHaveLength(5);
    expect(plan.toExpire).toHaveLength(2);
  });
});
