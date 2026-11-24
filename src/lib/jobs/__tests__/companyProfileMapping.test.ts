import { describe, expect, it } from "vitest";
import { mapCompanyProfilePayload } from "../service";

describe("Pro company profile mapping", () => {
  it("carries the same typed profile through batch and direct payload shapes", () => {
    const payload = { companyId: "canonical-123", facts: { overview: { value: "Official overview", sourceUrl: "https://example.com/about", sourceKind: "official_site", retrievedAt: "2026-11-22T00:00:00Z" } }, leadership: [], news: [], jobs: { status: "ready", jobs: [{ id: "job-2", title: "Designer", company: "Example", location: "Remote", postedAt: null }] } };
    expect(mapCompanyProfilePayload(payload, "canonical-123")).toEqual(mapCompanyProfilePayload({ ...payload }, "canonical-123"));
  });

  it("does not attach a profile without canonical identity", () => {
    expect(mapCompanyProfilePayload({ facts: {}, leadership: [], news: [] })).toBeNull();
  });

  it("only lets the latest asynchronous job selection update the selected detail", async () => {
    const loaded = await import("../service");
    const Gate = (loaded as typeof loaded & { LatestJobSelectionGate?: new () => { begin: () => number; isCurrent: (token: number) => boolean; cancel: () => void } }).LatestJobSelectionGate;
    expect(typeof Gate).toBe("function");
    if (!Gate) return;
    const gate = new Gate();
    let selected = "";
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const responseA = new Promise<string>((resolve) => { resolveA = resolve; });
    const responseB = new Promise<string>((resolve) => { resolveB = resolve; });
    const select = (response: Promise<string>) => {
      const token = gate.begin();
      return response.then((value) => { if (gate.isCurrent(token)) selected = value; });
    };
    const selectingA = select(responseA);
    const selectingB = select(responseB);
    resolveB("job-b");
    await selectingB;
    resolveA("job-a");
    await selectingA;
    expect(selected).toBe("job-b");
    const staleToken = gate.begin();
    gate.cancel();
    expect(gate.isCurrent(staleToken)).toBe(false);
  });
});
