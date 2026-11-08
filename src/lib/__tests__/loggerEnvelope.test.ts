import { describe, expect, it } from "vitest";
import { createLogger, type LogLevel } from "../observability/logger";
const fixed = new Date("2026-11-09T00:00:00Z");
describe("structured log reserved envelope", () => {
  it.each(["debug", "info", "warn", "error"] as LogLevel[])("keeps generated envelope for %s despite per-call collisions", (level) => {
    const lines: Array<{ line: string; level: LogLevel }> = [];
    const log = createLogger({ now: () => fixed, level: "debug", sink: (line, sinkLevel) => lines.push({ line, level: sinkLevel }) });
    log[level]("actual message", { ts: "wrong", level: "wrong", msg: "wrong", route: "/api/test" });
    expect(lines).toHaveLength(1); expect(lines[0].level).toBe(level);
    expect(JSON.parse(lines[0].line)).toMatchObject({ ts: fixed.toISOString(), level, msg: "actual message", route: "/api/test" });
  });
  it("protects envelope from base/child context without mutating input", () => {
    const lines: string[] = [];
    const base = { ts: "base", level: "base", msg: "base", service: "api" };
    const context = { ts: "child", level: "child", msg: "child", requestId: "one" };
    const log = createLogger({ now: () => fixed, sink: (line) => lines.push(line), context: base });
    log.child(context).warn("child warning"); log.info("parent message");
    expect(JSON.parse(lines[0])).toMatchObject({ ts: fixed.toISOString(), level: "warn", msg: "child warning", service: "api", requestId: "one" });
    expect(JSON.parse(lines[1])).toMatchObject({ level: "info", msg: "parent message", service: "api" });
    expect(JSON.parse(lines[1]).requestId).toBeUndefined();
    expect(base.msg).toBe("base"); expect(context.msg).toBe("child");
  });
  it("retains normal per-call override and nested secret redaction", () => {
    const lines: string[] = [];
    createLogger({ now: () => fixed, sink: (line) => lines.push(line), context: { route: "base" } })
      .error("failure", { route: "call", level: { password: "secret" }, nested: { token: "hidden", msg: "nested value" } });
    const record = JSON.parse(lines[0]);
    expect(record.route).toBe("call"); expect(record.level).toBe("error");
    expect(record.nested).toEqual({ token: "[REDACTED]", msg: "nested value" });
    expect(lines[0]).not.toContain("hidden"); expect(lines[0]).not.toContain("secret");
  });
});
