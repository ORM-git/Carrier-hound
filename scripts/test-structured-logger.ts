/**
 * Row test: structured JSON logging (Backend sheet - Structured JSON Logging).
 * Run: npx tsx scripts/test-structured-logger.ts
 */
import * as fs from "fs";
import {
  createLogger,
  redactContext,
  type LogLevel,
} from "../src/lib/observability/logger";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

function capture() {
  const lines: Array<{ line: string; level: LogLevel }> = [];
  return {
    lines,
    sink: (line: string, level: LogLevel) => { lines.push({ line, level }); },
    parsed() { return lines.map((l) => JSON.parse(l.line)); },
  };
}

const fixed = new Date("2026-11-06T10:00:00.000Z");
const now = () => fixed;

// 1. emits exactly one valid JSON line per call
{
  const c = capture();
  const log = createLogger({ sink: c.sink, now, level: "debug" });
  log.info("hello world", { route: "/api/ticker" });
  check("one line per call", c.lines.length === 1);
  const rec = c.parsed()[0];
  check("line is valid JSON with required fields",
    rec.ts === "2026-11-06T10:00:00.000Z" && rec.level === "info" && rec.msg === "hello world" && rec.route === "/api/ticker");
}

// 2. newline-safe: multi-line messages stay on one line
{
  const c = capture();
  const log = createLogger({ sink: c.sink, now, level: "debug" });
  log.warn("line one\nline two", { detail: "a\nb\nc" });
  check("multi-line msg/context never break the line", c.lines.length === 1 && !c.lines[0].line.includes("\n"));
}

// 3. level filtering
{
  const c = capture();
  const log = createLogger({ sink: c.sink, now, level: "warn" });
  log.debug("d"); log.info("i"); log.warn("w"); log.error("e");
  check("level filter drops debug+info, keeps warn+error", c.lines.length === 2 && c.lines[0].level === "warn" && c.lines[1].level === "error");
}

// 4. silent suppresses everything
{
  const c = capture();
  const log = createLogger({ sink: c.sink, now, level: "silent" });
  log.error("boom");
  check("silent suppresses all output", c.lines.length === 0);
}

// 5. LOG_LEVEL env honored when no explicit level
{
  const c = capture();
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "error";
  const log = createLogger({ sink: c.sink, now });
  log.warn("hidden"); log.error("shown");
  if (prev === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = prev;
  check("LOG_LEVEL env honored", c.lines.length === 1 && c.lines[0].level === "error");
}

// 6. secret redaction across key-name variants, nested
{
  const c = capture();
  const log = createLogger({ sink: c.sink, now, level: "debug" });
  log.info("auth", {
    password: "hunter2",
    API_KEY: "sk-live-123",
    nested: { authorization: "Bearer abc", session: "xyz", ok: 1 },
    headers: { Cookie: "session=abc" },
  });
  const rec = c.parsed()[0];
  const raw = c.lines[0].line;
  check("password/api-key redacted", rec.password === "[REDACTED]" && rec.API_KEY === "[REDACTED]");
  check("nested secrets redacted", rec.nested.authorization === "[REDACTED]" && rec.nested.session === "[REDACTED]" && rec.nested.ok === 1);
  check("headers.cookie redacted", rec.headers.Cookie === "[REDACTED]");
  check("no secret value leaks anywhere in the line",
    !raw.includes("hunter2") && !raw.includes("sk-live-123") && !raw.includes("Bearer abc") && !raw.includes("session=abc"));
}

// 7. child binds context, never mutates parent, child of child merges
{
  const c = capture();
  const log = createLogger({ sink: c.sink, now, level: "debug", context: { service: "api" } });
  const child = log.child({ requestId: "req-1" });
  const grandchild = child.child({ route: "/api/jobs" });
  child.info("child line");
  grandchild.info("grandchild line");
  log.info("parent line");
  const [cRec, gRec, pRec] = c.parsed();
  check("child carries bound context", cRec.service === "api" && cRec.requestId === "req-1");
  check("grandchild merges all context", gRec.service === "api" && gRec.requestId === "req-1" && gRec.route === "/api/jobs");
  check("parent unaffected by children", pRec.service === "api" && !("requestId" in pRec) && !("route" in pRec));
}

// 8. circular / hostile context never throws, always one line
{
  const c = capture();
  const log = createLogger({ sink: c.sink, now, level: "debug" });
  const circ: Record<string, unknown> = { a: 1 };
  circ.self = circ;
  let threw = false;
  try {
    log.error("circular", { circ, big: 10n, fn: () => 1, sym: Symbol("s"), undef: undefined, nan: NaN, inf: Infinity });
  } catch { threw = true; }
  const rec = c.parsed()[0];
  check("circular context does not throw", !threw && c.lines.length === 1);
  check("circular marker + non-JSON types stringified",
    rec.circ.self === "[CIRCULAR]" && rec.big === "10" && typeof rec.fn === "string" && rec.nan === "NaN" && rec.inf === "Infinity");
}

// 9. error level routes to the sink tagged as error
{
  const c = capture();
  const log = createLogger({ sink: c.sink, now, level: "debug" });
  log.error("failed", { err: "connection refused" });
  check("error records carry level=error and context", c.lines[0].level === "error" && c.parsed()[0].err === "connection refused");
}

// 10. redactContext is pure (input not mutated)
{
  const input = { password: "x", nested: { token: "y" } };
  redactContext(input);
  check("redactContext does not mutate input", input.password === "x" && input.nested.token === "y");
}

// 11. docs exist and describe redaction + LOG_LEVEL + adoption
{
  const doc = fs.readFileSync("docs/structured-logging.md", "utf8");
  check("doc marked INTERNAL", doc.includes("INTERNAL"));
  check("doc covers redaction", doc.includes("[REDACTED]") && doc.includes("redact"));
  check("doc covers LOG_LEVEL", doc.includes("LOG_LEVEL"));
  check("doc describes route adoption (opt-in)", doc.includes("Adoption") && doc.includes("createLogger"));
  check("doc cites repo evidence, no invented numbers", doc.includes("sentryErrorReporter.ts") && !doc.includes("Owner-confirmed"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
