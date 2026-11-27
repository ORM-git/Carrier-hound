import { describe, expect, it } from "vitest";
import { computeAdvancedCapabilities } from "@/lib/preferences/advancedFilters";

const base = { enforced: true, hasServiceKey: true, excludedSkillsRpcFlag: "1", preferredSkillsRankingFlag: "1" };
describe("advanced capabilities (server truth)", () => {
  it("excluded skills need the owner gate, the service key and the RPC flag", () => {
    expect(computeAdvancedCapabilities(base).excludedSkillsFilter).toBe(true);
    expect(computeAdvancedCapabilities({ ...base, enforced: false }).excludedSkillsFilter).toBe(false);
    expect(computeAdvancedCapabilities({ ...base, hasServiceKey: false }).excludedSkillsFilter).toBe(false);
    expect(computeAdvancedCapabilities({ ...base, excludedSkillsRpcFlag: undefined }).excludedSkillsFilter).toBe(false);
    expect(computeAdvancedCapabilities({ ...base, excludedSkillsRpcFlag: "true" }).excludedSkillsFilter).toBe(false);
  });
  it("preferred ranking is Pro-only by design and needs the gate, service key and its own flag", () => {
    expect(computeAdvancedCapabilities(base).preferredSkillsRanking).toBe(true);
    expect(computeAdvancedCapabilities({ ...base, preferredSkillsRankingFlag: undefined }).preferredSkillsRanking).toBe(false);
    expect(computeAdvancedCapabilities({ ...base, enforced: false }).preferredSkillsRanking).toBe(false);
    expect(computeAdvancedCapabilities({ ...base, hasServiceKey: false }).preferredSkillsRanking).toBe(false);
  });
});
