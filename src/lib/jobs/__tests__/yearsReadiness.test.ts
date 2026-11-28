import { describe, expect, it, vi } from "vitest";
import { probeRequiredYearsColumns } from "../yearsReadiness";
import { computeAdvancedCapabilities } from "@/lib/preferences/advancedFilters";

const client = (result: () => Promise<{ error: unknown }>) => {
  const limit = vi.fn(result);
  const select = vi.fn(() => ({ limit }));
  return { c: { from: vi.fn(() => ({ select })) } as any, select, limit };
};

const opts = {} as const;
describe("required-years readiness probe", () => {
  it("ready only when a head select of both columns answers with error null", async () => {
    const { c, select } = client(async () => ({ error: null }));
    expect(await probeRequiredYearsColumns(c, opts)).toBe(true);
    expect(select).toHaveBeenCalledWith("min_experience_years,max_experience_years", { head: true });
  });
  it("missing columns, throws, no client, missing or malformed response and timeouts are all false", async () => {
    expect(await probeRequiredYearsColumns(client(async () => ({ error: { code: "42703" } })).c, opts)).toBe(false);
    expect(await probeRequiredYearsColumns(client(async () => { throw new Error("net"); }).c, opts)).toBe(false);
    expect(await probeRequiredYearsColumns(null, opts)).toBe(false);
    expect(await probeRequiredYearsColumns(client(async () => undefined as any).c, opts)).toBe(false);
    expect(await probeRequiredYearsColumns(client(async () => ({}) as any).c, opts)).toBe(false);
    expect(await probeRequiredYearsColumns(client(async () => ({ error: undefined }) as any).c, opts)).toBe(false);
    expect(await probeRequiredYearsColumns(client(() => new Promise(() => {})).c, { timeoutMs: 20 })).toBe(false);
  });
  it("one client's success is never reused for another client", async () => {
    expect(await probeRequiredYearsColumns(client(async () => ({ error: null })).c)).toBe(true);
    expect(await probeRequiredYearsColumns(client(async () => ({ error: { code: "42703" } })).c)).toBe(false);
  });
  it("a timeout aborts the underlying request when the client supports abort", async () => {
    let signal: AbortSignal | undefined;
    const builder: any = { then: () => new Promise(() => {}), abortSignal(sig: AbortSignal) { signal = sig; return builder; } };
    const c = { from: () => ({ select: () => ({ limit: () => builder }) }) } as any;
    expect(await probeRequiredYearsColumns(c, { timeoutMs: 20 })).toBe(false);
    expect(signal?.aborted).toBe(true);
  });
  it("capability needs the owner gate, the service key and a passing probe", () => {
    const base = { excludedSkillsRpcFlag: null, preferredSkillsRankingFlag: null };
    expect(computeAdvancedCapabilities({ ...base, enforced: true, hasServiceKey: true, requiredYearsQueryable: true }).requiredYearsFilter).toBe(true);
    expect(computeAdvancedCapabilities({ ...base, enforced: false, hasServiceKey: true, requiredYearsQueryable: true }).requiredYearsFilter).toBe(false);
    expect(computeAdvancedCapabilities({ ...base, enforced: true, hasServiceKey: false, requiredYearsQueryable: true }).requiredYearsFilter).toBe(false);
    expect(computeAdvancedCapabilities({ ...base, enforced: true, hasServiceKey: true }).requiredYearsFilter).toBe(false);
  });
});
