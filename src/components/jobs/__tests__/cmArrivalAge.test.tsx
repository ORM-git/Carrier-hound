// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import JobCardContent, { cmArrivalAt } from "../JobCardContent";
import type { LiveJob } from "@/lib/jobs/service";

const NOW = Date.parse("2026-11-26T12:00:00Z");
const noop = () => {};
const base = { id: "j1", title: "Analyst", company: "Acme", location: "Remote", date: "", salary: "", category: "data", remote: true, country: "US", type: "full-time", directSource: true, applyUrl: "" } as unknown as LiveJob;
const fmt = (d?: string) => `age(${d})`;
const card = (job: Partial<LiveJob>) =>
  render(
    <JobCardContent job={{ ...base, ...job } as LiveJob} index={0} isPro isSaved={false} matchScore={null as any} cardZeroSkills={false} isRecent={false} postedRelative={null} companyPills={[]} locInfo={{ primary: "Remote", extraCount: 0, all: ["Remote"] }} jobLevel="" formattedJobType={null} getTagColorClass={() => ""} formatRelativeTime={fmt} handleHideJob={noop as any} handleToggleApplied={noop} handleSaveJob={noop as any} handleSelectJob={noop as any} handleLockedAction={noop as any} />
  );
afterEach(cleanup);

describe("CM arrival age (first_seen_at), never employer posting time", () => {
  it("valid arrival: normalized ISO", () => {
    expect(cmArrivalAt({ firstSeenAt: "2026-11-26T10:00:00Z" }, NOW)).toBe("2026-11-26T10:00:00.000Z");
  });
  it("missing, empty, non-string, unparseable or future arrival is null", () => {
    for (const v of [undefined, null, "", "  ", 123, "not-a-date", "2026-13-45T99:00:00Z", "2026-11-26T13:00:00Z"]) {
      expect(cmArrivalAt({ firstSeenAt: v as any }, NOW)).toBeNull();
    }
    expect(cmArrivalAt(null, NOW)).toBeNull();
  });
  it("tolerates small clock skew (under 5 min ahead)", () => {
    expect(cmArrivalAt({ firstSeenAt: "2026-11-26T12:03:00Z" }, NOW)).not.toBeNull();
  });
  it("mobile card footer shows the arrival age, not postedAt", () => {
    card({ firstSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString(), postedAt: "2026-10-01T00:00:00Z" });
    const age = screen.getByTestId("cm-arrival-age").textContent || "";
    expect(age).toContain("age(");
    expect(age).not.toContain("2026-10-01");
  });
  it("no arrival: footer is empty even when postedAt exists (no fallback, no invented date)", () => {
    card({ postedAt: "2026-10-01T00:00:00Z" });
    expect(screen.getByTestId("cm-arrival-age").textContent).toBe("");
  });
  it("invalid arrival: footer is empty", () => {
    card({ firstSeenAt: "garbage", postedAt: "2026-10-01T00:00:00Z" });
    expect(screen.getByTestId("cm-arrival-age").textContent).toBe("");
  });
});
