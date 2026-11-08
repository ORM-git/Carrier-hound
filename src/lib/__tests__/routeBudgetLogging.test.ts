import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("route budget log-level discipline", () => {
  async function load(level?: string) {
    vi.resetModules();
    if (level === undefined) delete process.env.LOG_LEVEL;
    else vi.stubEnv("LOG_LEVEL", level);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let time = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const { measureRouteBudget } = await import("../api/routeBudget");
    return { warn, run: <T>(fn: () => Promise<T>) => measureRouteBudget("/api/ticker", fn), slow: () => { time += 1001; } };
  }
  it.each(["error", "silent"])("suppresses budget warnings at %s without changing successful values", async (level) => {
    const { warn, run, slow } = await load(level);
    const result = { ok: true };
    expect(await run(async () => { slow(); return result; })).toBe(result);
    expect(warn).not.toHaveBeenCalled();
  });
  it.each(["warn", "info", "debug", "unrecognized"])("emits one structured budget event at %s", async (level) => {
    const { warn, run, slow } = await load(level);
    await run(async () => { slow(); return 42; });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({ level: "warn", msg: "ROUTE_BUDGET_EXCEEDED", module: "api/routeBudget", event: "ROUTE_BUDGET_EXCEEDED", route: "/api/ticker", budgetMs: 1000, durationMs: 1001 });
  });
  it("does not warn for an under-budget request", async () => {
    const { warn, run } = await load("warn");
    expect(await run(async () => 42)).toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });
  it("preserves the thrown error even when a slow failure is suppressed", async () => {
    const { warn, run, slow } = await load("silent");
    const error = new Error("original failure");
    await expect(run(async () => { slow(); throw error; })).rejects.toBe(error);
    expect(warn).not.toHaveBeenCalled();
  });
  it("logs a slow failure once without replacing its error", async () => {
    const { warn, run, slow } = await load("warn");
    const error = new Error("original failure");
    await expect(run(async () => { slow(); throw error; })).rejects.toBe(error);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
