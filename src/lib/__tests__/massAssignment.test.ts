import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { pickAllowed, SERVER_OWNED_FIELDS, PROTOTYPE_KEYS } from "@/lib/security/pickFields";

// Backend sheet rank 72 (Mass Assignment): the repo's convention is that
// writes pick fields explicitly; pickFields.ts is the global whitelist for
// free-form objects; the static scan below fails if any API route ever
// spreads a request-body-derived object into a DB write without going
// through a sanitizer.

describe("pickAllowed", () => {
  it("keeps only allowlisted own keys", () => {
    const { picked } = pickAllowed({ name: "a", role: "x", extra: 1 }, ["name", "extra"]);
    expect(picked).toEqual({ name: "a", extra: 1 });
  });

  it("strips server-owned fields even when allowlisted", () => {
    const { picked, strippedServerOwned } = pickAllowed(
      { display: "x", role: "admin", is_blocked: false, plan: "pro" },
      ["display", "role", "is_blocked", "plan"]
    );
    expect(picked).toEqual({ display: "x" });
    expect(strippedServerOwned.sort()).toEqual(["is_blocked", "plan", "role"]);
  });

  it("never copies prototype-polluting keys", () => {
    const input = JSON.parse('{"name":"a","__proto__":{"polluted":true},"constructor":"x"}');
    const { picked } = pickAllowed(input, ["name", "__proto__", "constructor"]);
    expect(picked).toEqual({ name: "a" });
    expect(({} as any).polluted).toBeUndefined();
  });

  it("rejects non-object input and skips undefined", () => {
    expect(pickAllowed(null, ["a"]).picked).toEqual({});
    expect(pickAllowed([1, 2], ["a"]).picked).toEqual({});
    expect(pickAllowed("str", ["a"]).picked).toEqual({});
    expect(pickAllowed({ a: undefined, b: 1 }, ["a", "b"]).picked).toEqual({ b: 1 });
  });

  it("documents the server-owned and prototype key sets", () => {
    for (const k of ["role", "is_admin", "is_blocked", "plan", "user_id"]) {
      expect(SERVER_OWNED_FIELDS.has(k)).toBe(true);
    }
    for (const k of ["__proto__", "constructor", "prototype"]) {
      expect(PROTOTYPE_KEYS.has(k)).toBe(true);
    }
  });
});

// Static guard: no API route may spread a client-derived object into a
// .insert/.update/.upsert argument unless the spread source is an
// approved sanitizer product.
const APPROVED_SPREAD_SOURCES = new Set([
  "attribution", // output of sanitizeAttribution() - itself an allowlist
]);

function collectRoutes(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectRoutes(full));
    else if (entry.name === "route.ts" || entry.name === "route.tsx") out.push(full);
  }
  return out;
}

describe("API route mass-assignment guard", () => {
  it("no route spreads an unsanitized object into a DB write", () => {
    const apiDir = path.resolve(__dirname, "../../app/api");
    const violations: string[] = [];
    const WRITE_RE = /\.(insert|update|upsert)\s*\(\s*\{([^}]*)\}/g;
    const SPREAD_RE = /\.\.\.([A-Za-z_$][\w$]*)/g;
    for (const file of collectRoutes(apiDir)) {
      const src = fs.readFileSync(file, "utf8");
      WRITE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = WRITE_RE.exec(src)) !== null) {
        const arg = match[2];
        SPREAD_RE.lastIndex = 0;
        let spread: RegExpExecArray | null;
        while ((spread = SPREAD_RE.exec(arg)) !== null) {
          if (!APPROVED_SPREAD_SOURCES.has(spread[1])) {
            violations.push(`${path.relative(apiDir, file)} spreads ...${spread[1]} into .${match[1]}()`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("guard itself is wired to the real routes directory", () => {
    const apiDir = path.resolve(__dirname, "../../app/api");
    expect(collectRoutes(apiDir).length).toBeGreaterThan(10);
  });
});
