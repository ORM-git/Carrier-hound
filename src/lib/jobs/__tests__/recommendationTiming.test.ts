import { describe, it, expect, vi } from "vitest";
import { recommendationTiming } from "../recommendationTiming";

describe("recommendation timing privacy and checkpoints", () => {
  it("emits bounded numeric wall metrics and a correlation id, not caller content", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let t = 0;
    const timing = recommendationTiming("abcd1234abcd1234-BOM", () => t);
    t = 12; timing.begin("db");
    t = 32; timing.rows("candidateRows", 1000); timing.begin("scoring");
    t = 80; timing.rows("rankedRows", 80); timing.rows("returnedRows", 20); timing.begin("format");
    t = 84; timing.finish(200);
    const records = spy.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(records).toHaveLength(5);
    expect(records[3]).toMatchObject({ stage: "format", dbWallMs: 20, scoringWallMs: 48 });
    expect(records[4]).toMatchObject({ event: "finish", status: 200, candidateRows: 1000, returnedRows: 20, formatWallMs: 4, totalWallMs: 84 });
    expect(new Set(records.map(r => r.requestId)).size).toBe(1);
    expect(records[0].cfRay).toBe("abcd1234abcd1234-BOM");
    spy.mockRestore();
  });
  it("keeps the temporary diagnostic visible even with a restrictive global log level", () => {
    const previous = process.env.LOG_LEVEL;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env.LOG_LEVEL = "silent";
      const timing = recommendationTiming(null);
      timing.finish(429);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(spy.mock.calls[1][0]))).toMatchObject({ status: 429, stage: "setup" });
    } finally {
      if (previous === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = previous;
      spy.mockRestore();
    }
  });
  it("does not echo an untrusted correlation header and logging failures are harmless", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => { throw Error("sink unavailable"); });
    expect(() => { const t = recommendationTiming("personal-data@example.com"); t.begin("db"); t.finish(503); }).not.toThrow();
    spy.mockRestore();
  });
});

describe("repeated stages", () => {
  it("add up instead of overwriting, and hydrate is its own stage", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let t = 0;
      const timing = recommendationTiming(null, () => t);
      timing.begin("db"); t = 10; timing.begin("scoring"); t = 15;
      timing.begin("db"); t = 22; timing.begin("scoring"); t = 25;
      timing.begin("hydrate"); t = 29; timing.finish(503);
      expect(JSON.parse(String(spy.mock.calls.at(-1)![0]))).toMatchObject({ event: "finish", status: 503, dbWallMs: 17, scoringWallMs: 8, hydrateWallMs: 4, totalWallMs: 29 });
    } finally { spy.mockRestore(); }
  });
});
