// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readVersioned, writeVersioned } from "../storage/versioned";

const KEY = "test_versioned_key";

beforeEach(() => window.localStorage.clear());

describe("versioned storage", () => {
  it("round-trips an enveloped value at the current version", () => {
    writeVersioned(KEY, 2, { theme: "dark" });
    expect(readVersioned(KEY, { version: 2, fallback: { theme: "light" } })).toEqual({ theme: "dark" });
  });

  it("returns the fallback when nothing is stored", () => {
    expect(readVersioned(KEY, { version: 1, fallback: 42 })).toBe(42);
  });

  it("migrates a legacy raw (un-enveloped) value from v0", () => {
    window.localStorage.setItem(KEY, "true");
    const migrated = readVersioned(KEY, {
      version: 1,
      fallback: false,
      migrate: (from, raw) => (from === 0 ? raw === true || raw === "true" : raw),
    });
    expect(migrated).toBe(true);
  });

  it("chains migrations across multiple versions", () => {
    writeVersioned(KEY, 1, "a");
    const out = readVersioned(KEY, {
      version: 3,
      fallback: "none",
      migrate: (from, raw) => (typeof raw === "string" ? raw + ">" + from : raw),
    });
    expect(out).toBe("a>1>2");
  });

  it("falls back on corrupt JSON", () => {
    window.localStorage.setItem(KEY, "{not json");
    // Non-JSON strings are treated as legacy raw values; without a migrate fn they fall back.
    expect(readVersioned(KEY, { version: 1, fallback: "fb" })).toBe("fb");
  });

  it("falls back when the stored version is newer than this build", () => {
    writeVersioned(KEY, 9, "future");
    expect(readVersioned(KEY, { version: 2, fallback: "fb" })).toBe("fb");
  });

  it("falls back when validation rejects the payload", () => {
    writeVersioned(KEY, 1, 123);
    const out = readVersioned(KEY, {
      version: 1,
      fallback: "fb",
      validate: (d): d is string => typeof d === "string",
    });
    expect(out).toBe("fb");
  });

  it("falls back when migration throws", () => {
    window.localStorage.setItem(KEY, "x");
    const out = readVersioned(KEY, {
      version: 1,
      fallback: "fb",
      migrate: () => {
        throw new Error("bad");
      },
    });
    expect(out).toBe("fb");
  });
});
