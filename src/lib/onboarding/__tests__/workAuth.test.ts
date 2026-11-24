import { describe, expect, it } from "vitest";
import {
  isValidWorkAuthSet,
  isWorkAuthComplete,
  parseWorkAuth,
  serializeWorkAuth,
  toggleWorkAuth,
  type WorkAuthId,
} from "../workAuth";

const A: WorkAuthId = "authorized"; // option 1
const S: WorkAuthId = "requires_sponsorship"; // option 2
const O: WorkAuthId = "other"; // option 3

describe("work authorization sets", () => {
  it.each<[WorkAuthId[]]>([[[A]], [[S]], [[O]], [[S, O]], [[O, S]]])("accepts %j and round-trips it", (ids) => {
    expect(isValidWorkAuthSet(ids)).toBe(true);
    const stored = serializeWorkAuth(ids);
    expect(parseWorkAuth(stored)).toEqual([A, S, O].filter((x) => ids.includes(x)));
    expect(isWorkAuthComplete(stored)).toBe(true);
  });

  it.each([[[A, S]], [[A, O]], [[A, S, O]], [[]], [[S, S]], [["unknown"]], [[A, "unknown"]]])(
    "rejects %j",
    (ids) => {
      expect(isValidWorkAuthSet(ids as string[])).toBe(false);
      expect(() => serializeWorkAuth(ids as WorkAuthId[])).toThrow();
    }
  );

  it("rejects invalid stored strings and non-string types", () => {
    const label1 = serializeWorkAuth([A]);
    const label2 = serializeWorkAuth([S]);
    const label3 = serializeWorkAuth([O]);
    for (const bad of [`${label1} + ${label2}`, `${label1} + ${label3}`, `${label1} + ${label2} + ${label3}`, "Authorized", "EU Work Permit", `${label2} + nope`]) {
      expect(parseWorkAuth(bad)).toBeNull();
      expect(isWorkAuthComplete(bad)).toBe(false);
    }
    for (const bad of [null, undefined, 1, true, ["authorized"], { id: "authorized" }]) {
      expect(parseWorkAuth(bad)).toBeNull();
      expect(isWorkAuthComplete(bad)).toBe(false);
    }
  });

  it("treats empty as incomplete, never as a default", () => {
    expect(parseWorkAuth("")).toEqual([]);
    expect(parseWorkAuth("   ")).toEqual([]);
    expect(isWorkAuthComplete("")).toBe(false);
  });

  it("parses labels saved before the first-person copy change", () => {
    expect(parseWorkAuth("Authorized to work (No sponsorship required)")).toEqual([A]);
    expect(parseWorkAuth("Requires visa sponsorship (e.g. H1B)")).toEqual([S]);
    expect(parseWorkAuth("Other / Work Permit")).toEqual([O]);
    expect(parseWorkAuth("Requires visa sponsorship (e.g. H1B) + Other / Work Permit")).toEqual([S, O]);
    expect(parseWorkAuth("Authorized to work (No sponsorship required) + Other / Work Permit")).toBeNull();
    // Re-saving a legacy value writes the current wording.
    expect(serializeWorkAuth(parseWorkAuth("Requires visa sponsorship (e.g. H1B)")!)).toBe("I need visa sponsorship.");
  });

  it("uses the first-person labels, kept separate from the stable ids", () => {
    expect(serializeWorkAuth([A])).toBe("I am authorized to work without sponsorship.");
    expect(serializeWorkAuth([S])).toBe("I need visa sponsorship.");
    expect(serializeWorkAuth([O])).toBe("I have another work permit or authorization.");
    expect(serializeWorkAuth([S, O])).toBe("I need visa sponsorship. + I have another work permit or authorization.");
  });

  it("parses legacy single values stored as ids or current labels", () => {
    expect(parseWorkAuth("authorized")).toEqual([A]);
    expect(parseWorkAuth("requires_sponsorship")).toEqual([S]);
    expect(parseWorkAuth("other")).toEqual([O]);
    expect(parseWorkAuth("requires_sponsorship + other")).toEqual([S, O]);
    expect(parseWorkAuth(`  ${serializeWorkAuth([O])}  `)).toEqual([O]);
  });
});

describe("toggleWorkAuth (one tap)", () => {
  const s = (...ids: WorkAuthId[]) => serializeWorkAuth(ids);

  it("selects from empty", () => {
    expect(toggleWorkAuth("", A)).toBe(s(A));
    expect(toggleWorkAuth("", S)).toBe(s(S));
    expect(toggleWorkAuth("", O)).toBe(s(O));
  });

  it("option 1 clears 2 and 3; 2 or 3 clear 1", () => {
    expect(toggleWorkAuth(s(S, O), A)).toBe(s(A));
    expect(toggleWorkAuth(s(S), A)).toBe(s(A));
    expect(toggleWorkAuth(s(A), S)).toBe(s(S));
    expect(toggleWorkAuth(s(A), O)).toBe(s(O));
  });

  it("2 and 3 coexist, in option order regardless of tap order", () => {
    expect(toggleWorkAuth(s(S), O)).toBe(s(S, O));
    expect(toggleWorkAuth(s(O), S)).toBe(s(S, O));
  });

  it("tapping a selected option clears it", () => {
    expect(toggleWorkAuth(s(A), A)).toBe("");
    expect(toggleWorkAuth(s(S, O), S)).toBe(s(O));
    expect(toggleWorkAuth(s(S, O), O)).toBe(s(S));
  });

  it("starts fresh from an unparseable current value", () => {
    expect(toggleWorkAuth("Authorized", S)).toBe(s(S));
  });
});
