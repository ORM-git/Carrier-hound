import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// Guard for Backend sheet rank 72 (Uniform Error Shape): every direct
// NextResponse.json({ ... }, { status: 4xx/5xx }) literal in API routes must
// match the canonical rule or a sanctioned variant in docs/error-shape.md.
// A new unlisted shape fails CI. Existing bodies are never rewritten by
// this guard; it blocks NEW divergence only.

const ROOT = join(__dirname, "..", "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

// Sanctioned shape key-combos (sorted, comma-joined). Mirrors docs/error-shape.md.
const CANONICAL = new Set([
  "error",
  "code,error",
  "error,retryAfter",
  "error,ok",
]);
const LEGACY = new Set([
  "Forbidden,error",
  "access,error,message",
  "access,error,jobs,message",
  "access,error,jobs,message,total",
  "code,error,isPro",
  "error,jobs",
  "error,jobs,totalCount",
  "error,parameter",
  "error,ok,retryAfter",
]);
// Partial-content payloads (degraded job-list responses), not error bodies.
const PARTIAL_PAYLOAD = new Set([
  "degraded,hasMore,hasNextPage,jobs,nextCursor,totalCount",
  "jobs,totalCount",
]);

const RESPONSE_RE = /NextResponse\.json\(\s*\{([^}]*)\}\s*,\s*\{?\s*(?:\{\s*)?status:\s*(4\d\d|5\d\d)/g;

interface Hit { file: string; line: number; keys: string; status: string; }

function scan(file: string): Hit[] {
  const rel = relative(ROOT, file).split("\\").join("/");
  const src = readFileSync(file, "utf8");
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  RESPONSE_RE.lastIndex = 0;
  while ((m = RESPONSE_RE.exec(src)) !== null) {
    const keys = Array.from(m[1].matchAll(/(\w+)\s*:/g) as Iterable<RegExpMatchArray>)
      .map((k) => k[1])
      .sort()
      .join(",");
    const line = src.slice(0, m.index).split("\n").length;
    hits.push({ file: rel, line, keys, status: m[2] });
  }
  return hits;
}

describe("uniform error shape guard (Backend sheet rank 72)", () => {
  it("every error-body literal matches the canonical rule or a sanctioned variant", () => {
    const bad: string[] = [];
    walk(join(ROOT, "src", "app", "api")).forEach((file) => {
      scan(file).forEach((h) => {
        if (CANONICAL.has(h.keys) || LEGACY.has(h.keys) || PARTIAL_PAYLOAD.has(h.keys)) return;
        bad.push(`${h.file}:${h.line} (${h.status}) keys=[${h.keys}]`);
      });
    });
    expect(
      bad,
      `new unlisted error shape(s):\n${bad.join("\n")}\n` +
        `use { error } (+ sanctioned extras) or record a variant in docs/error-shape.md and this allowlist`,
    ).toEqual([]);
  });

  it("finds the documented baseline (sanity: scanner is not silently blind)", () => {
    let total = 0;
    walk(join(ROOT, "src", "app", "api")).forEach((file) => {
      total += scan(file).length;
    });
    // 127 literals at introduction (2026-11-07, post-merge main). A drop means responses moved
    // to helpers the guard cannot see - revisit coverage before lowering.
    expect(total).toBeGreaterThanOrEqual(100);
  });

  it("the doc records every sanctioned variant", () => {
    const doc = readFileSync(join(ROOT, "docs", "error-shape.md"), "utf8");
    const docOrder = [
      "error, Forbidden",
      "error, message, access",
      "error, message, access, jobs",
      "error, message, access, jobs, total",
      "error, isPro, code",
      "error, jobs",
      "error, jobs, totalCount",
      "error, parameter",
      "ok, error, retryAfter",
    ];
    expect(docOrder.length).toBe(LEGACY.size);
    docOrder.forEach((human) => {
      expect(doc.includes(human), `${human} missing from docs/error-shape.md`).toBe(true);
    });
  });
});
