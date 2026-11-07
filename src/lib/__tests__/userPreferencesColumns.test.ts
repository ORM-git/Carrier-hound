import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// Guard for DB sheet rank 72 (select-star narrowing): getUserPreferences used
// .select("*") and now names its columns. The column list must cover every
// row field the mapper reads, so narrowing can never silently drop a field.

const ROOT = join(__dirname, "..", "..", "..");

describe("getUserPreferences column list (DB sheet rank 72)", () => {
  const src = readFileSync(join(ROOT, "src/lib/auth/session.ts"), "utf8");
  const start = src.indexOf("export async function getUserPreferences");
  const end = src.indexOf("\n}\n", start);
  const body = src.slice(start, end);

  it("selects named columns, not *", () => {
    expect(body.includes('.from("user_preferences")')).toBe(true);
    expect(/\.from\("user_preferences"\)\s*\.select\("\*"\)/.test(body)).toBe(false);
  });

  it("the select list is exactly the set of row fields the mapper reads", () => {
    const m = /\.from\("user_preferences"\)\s*\.select\("([^"]+)"\)/.exec(body);
    expect(m, "named select list not found").not.toBeNull();
    const selected = (m as RegExpExecArray)[1].split(",").map((c) => c.trim()).sort();
    const read: string[] = [];
    const re = /\bdata\.([a-z_]+)/g;
    let r: RegExpExecArray | null;
    while ((r = re.exec(body)) !== null) {
      if (read.indexOf(r[1]) === -1) read.push(r[1]);
    }
    expect(selected).toEqual(read.sort());
  });
});
