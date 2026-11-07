/**
 * Deterministic seeded fuzz over the input validators (Testing row
 * "Fuzz Testing": injection/cursor-payload tests were the only targeted
 * fuzzing). Zero-dependency seeded harness - package-lock.json cannot be
 * updated from the web flow, so fast-check adoption is an owner-side
 * step (docs/pbt.md); the properties below are the ones fast-check
 * would encode. Runs under the existing vitest CI gate.
 */
import { describe, it, expect } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  UUID_REGEX,
  POSTED_AT_REGEX,
} from "../pagination/cursor";
import {
  validateIdempotencyKey,
  IDEMPOTENCY_KEY_REGEX,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from "../ai/idempotency";

// Chosen defaults (same pattern as scripts/test-pbt-sanitizers.ts):
// fixed seed keeps CI deterministic; a few thousand iterations per
// property catches regressions while keeping the suite fast.
const SEED = 0x5eed;
const ITERATIONS = 4000;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_POOL =
  "abcXYZ019 <>&\"'=/\\;:.-_@#\t\n" +
  "\x00\x01\x08\x0b\x0c\x0e\x1f\x7f" +
  "é日🚀" +
  "[]{},:%$^*()!~`";
const INJECTION_FRAGMENTS = [
  "'; DROP TABLE jobs;--",
  "\" OR \"1\"=\"1",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "../../../etc/passwd",
  "${process.env.SECRET}",
  "{{7*7}}",
  "%00",
  "W10=", // "[]" base64
  "bnVsbA==", // "null" base64
  "WzEsMl0=", // "[1,2]" base64
];

function randString(rng: () => number, maxLen: number): string {
  const len = Math.floor(rng() * maxLen);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += HOSTILE_POOL[Math.floor(rng() * HOSTILE_POOL.length)];
  }
  return out;
}

function fuzzCursorInput(rng: () => number): string {
  const mode = Math.floor(rng() * 5);
  if (mode === 0) return randString(rng, 200);
  if (mode === 1) return INJECTION_FRAGMENTS[Math.floor(rng() * INJECTION_FRAGMENTS.length)] + randString(rng, 40);
  if (mode === 2) {
    // Mutate a valid cursor: flip, drop, or duplicate characters.
    const valid = encodeCursor("2026-11-07T08:30:00.123456Z", randomUuid(rng));
    const chars = valid.split("");
    const edits = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < edits; i++) {
      const idx = Math.floor(rng() * chars.length);
      const op = rng();
      if (op < 0.4) chars[idx] = HOSTILE_POOL[Math.floor(rng() * HOSTILE_POOL.length)];
      else if (op < 0.7) chars.splice(idx, 1);
      else chars.splice(idx, 0, chars[idx] || "A");
    }
    return chars.join("");
  }
  if (mode === 3) {
    // Structurally JSON-ish but wrong shapes.
    const shapes = ["[]", "[null]", "[1,2]", '["a"]', "[null,null]", '{"a":1}', '"str"', "123", "null", "true"];
    const s = shapes[Math.floor(rng() * shapes.length)];
    return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Valid shape, invalid field values (bad UUID, bad timestamp, year out of bounds).
  const badId = randString(rng, 36);
  const badTs = randString(rng, 30);
  const payload = JSON.stringify([rng() < 0.5 ? badTs : "1850-01-01T00:00:00Z", badId]);
  return Buffer.from(payload, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomUuid(rng: () => number): string {
  const hex = "0123456789abcdef";
  const seg = (n: number) => Array.from({ length: n }, () => hex[Math.floor(rng() * 16)]).join("");
  return `${seg(8)}-${seg(4)}-${seg(4)}-${seg(4)}-${seg(12)}`;
}

function randomPostedAt(rng: () => number): string {
  const year = 1970 + Math.floor(rng() * 130); // within the decoder's 1970-2100 bound
  const month = String(1 + Math.floor(rng() * 12)).padStart(2, "0");
  const day = String(1 + Math.floor(rng() * 28)).padStart(2, "0");
  const sub = rng() < 0.5 ? `.${Math.floor(rng() * 1000000)}` : "";
  const zone = rng() < 0.5 ? "Z" : "+05:30";
  return `${year}-${month}-${day}T10:15:30${sub}${zone}`;
}

describe("decodeCursor fuzz", () => {
  it("never throws and only returns structurally valid payloads", () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < ITERATIONS; i++) {
      const input = fuzzCursorInput(rng);
      let out: ReturnType<typeof decodeCursor>;
      expect(() => { out = decodeCursor(input); }).not.toThrow();
      out = decodeCursor(input);
      if (out !== null) {
        expect(UUID_REGEX.test(out.id)).toBe(true);
        if (out.posted_at !== null) {
          expect(POSTED_AT_REGEX.test(out.posted_at)).toBe(true);
          expect(Number.isNaN(Date.parse(out.posted_at))).toBe(false);
        }
      }
    }
  });

  it("round-trips valid payloads exactly (post-second precision preserved)", () => {
    const rng = mulberry32(SEED ^ 0x1);
    for (let i = 0; i < 1000; i++) {
      const postedAt = randomPostedAt(rng);
      const id = randomUuid(rng);
      const back = decodeCursor(encodeCursor(postedAt, id));
      expect(back).not.toBeNull();
      expect(back!.id).toBe(id);
      expect(back!.posted_at).toBe(postedAt);
    }
  });
});

describe("validateIdempotencyKey fuzz", () => {
  it("treats an absent key as valid (key is optional)", () => {
    expect(validateIdempotencyKey(null)).toEqual({ valid: true, key: "" });
    expect(validateIdempotencyKey(undefined)).toEqual({ valid: true, key: "" });
  });

  it("never throws; accepted keys satisfy the real regex and length cap", () => {
    const rng = mulberry32(SEED ^ 0x2);
    for (let i = 0; i < ITERATIONS; i++) {
      const mode = rng();
      const candidate: unknown =
        mode < 0.05 ? null :
        mode < 0.1 ? undefined :
        mode < 0.15 ? 42 :
        mode < 0.2 ? { key: "x" } :
        mode < 0.5 ? randString(rng, 300) :
        randString(rng, 130).replace(/[^A-Za-z0-9_.:-]/g, "a");
      let res: ReturnType<typeof validateIdempotencyKey>;
      expect(() => { res = validateIdempotencyKey(candidate); }).not.toThrow();
      res = validateIdempotencyKey(candidate);
      if (res.valid) {
        // Absent key (null/undefined) is valid with an empty key: the
        // idempotency key is optional. A present string key is always
        // non-empty, within the cap, and matches the real regex.
        if (typeof candidate === "string") {
          expect(res.key.length).toBeGreaterThan(0);
        }
        if (res.key.length > 0) {
          expect(res.key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
          expect(IDEMPOTENCY_KEY_REGEX.test(res.key)).toBe(true);
        }
      }
    }
  });
});
