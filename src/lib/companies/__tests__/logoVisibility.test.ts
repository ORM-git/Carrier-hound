import crypto from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { candidateRejection, repairCompanyLogo, type ClaimedCompany, type LogoRepairDeps } from "../logoRepair";
import type { ResolvedLogoResult } from "../logoResolver";
import { LOGO_TILE_BACKGROUNDS, logoVisibility, MIN_VISIBLE_COVERAGE } from "../logoVisibility";

// Representative candidate images (RGBA, 64x64 unless noted), painted into a transparent canvas.
type Px = [number, number, number, number];
async function image(paint: (x: number, y: number) => Px | null, w = 64, h = 64, fmt: "png" | "webp" | "jpeg" = "png"): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(paint(x, y) ?? [0, 0, 0, 0], (y * w + x) * 4);
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).toFormat(fmt).toBuffer();
}
const box = (x0: number, y0: number, x1: number, y1: number, c: Px) => (x: number, y: number) => (x >= x0 && x < x1 && y >= y0 && y < y1 ? c : null);
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const none = new Set<string>();

describe("logo visibility thresholds (documented in logoVisibility.ts)", () => {
  it("measures the light tiles we really render: bg-white, slate-50 and the ticker's #F4F4F5", () => {
    expect(LOGO_TILE_BACKGROUNDS).toEqual([[255, 255, 255], [248, 250, 252], [244, 244, 245]]);
    expect(MIN_VISIBLE_COVERAGE).toBe(0.02);
  });

  it("works on raw pixel arrays (the browser canvas path)", () => {
    const px = (c: Px, n: number) => Array.from({ length: n }, () => c).flat();
    expect(logoVisibility(px([0, 0, 0, 0], 100), 10, 10)).toMatchObject({ ok: false, reason: expect.stringMatching(/^transparent/) });
    expect(logoVisibility(px([250, 250, 250, 255], 100), 10, 10)).toMatchObject({ ok: false, reason: expect.stringMatching(/^invisible-on-tile/) });
    expect(logoVisibility(px([17, 24, 39, 255], 100), 10, 10)).toMatchObject({ ok: true, visible: 1 });
    expect(logoVisibility([], 0, 0)).toMatchObject({ ok: false, reason: "empty-image" });
  });
});

describe("candidate images: decode + readable-on-tile + fingerprints, before upload", () => {
  const cases: [string, () => Promise<Buffer>, RegExp | null][] = [
    ["fully transparent", () => image(() => null), /^invisible-logo: transparent/],
    ["all-white opaque square", () => image(() => [255, 255, 255, 255]), /^invisible-logo: invisible-on-tile/],
    ["faint white mark on transparent", () => image(box(8, 8, 56, 56, [255, 255, 255, 230])), /^invisible-logo: invisible-on-tile/],
    ["near-white (#F0F0F0) mark", () => image(box(8, 8, 56, 56, [240, 240, 240, 255])), /^invisible-logo: invisible-on-tile/],
    ["tiny visible speck (3x3 of 64x64)", () => image(box(30, 30, 33, 33, [0, 0, 0, 255])), /^invisible-logo: transparent/],
    ["valid dark mark", () => image(box(16, 16, 48, 48, [17, 24, 39, 255])), null],
    ["valid light mark (gray-400)", () => image(box(12, 12, 52, 52, [156, 163, 175, 255])), null],
    ["white glyph on a brand-coloured square", () => image((x, y) => (x > 24 && x < 40 && y > 16 && y < 48 ? [255, 255, 255, 255] : [37, 99, 235, 255])), null],
    ["wide wordmark (256x64 webp)", () => image(box(8, 20, 248, 44, [15, 23, 42, 255]), 256, 64, "webp"), null],
    ["opaque JPEG, dark mark on white", () => image((x, y) => (x > 16 && x < 48 && y > 16 && y < 48 ? [0, 0, 0, 255] : [255, 255, 255, 255]), 64, 64, "jpeg"), null],
    ["corrupt PNG (truncated)", async () => (await image(box(16, 16, 48, 48, [0, 0, 0, 255]))).subarray(0, 60), /^corrupt-image/],
    ["SVG disguised as a raster", async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#000"/></svg>'), /^corrupt-image/],
  ];
  for (const [name, make, want] of cases) {
    it(`${want ? "rejects" : "accepts"} ${name}`, async () => {
      const r = await candidateRejection(await make(), none, none);
      if (want) expect(r).toMatch(want);
      else expect(r).toBeNull();
    });
  }

  it("rejects a vendor/default fingerprint and an owner-rejected fingerprint, whatever the pixels", async () => {
    const good = await image(box(16, 16, 48, 48, [17, 24, 39, 255]));
    expect(await candidateRejection(good, new Set([sha(good)]), none)).toBe("default-branding");
    expect(await candidateRejection(good, none, new Set([sha(good)]))).toBe("rejected-image");
  });
});

describe("an owner-rejected image never returns, from any source", () => {
  const ID = "33333333-3333-4333-8333-333333333333";
  const company: ClaimedCompany = { id: ID, name: "Rejco", slug: "rejco", domain: "rej.co", careers_url: null, ats_type: "lever", logo_url: null, logo_attempts: 0, claim_token: "t" };
  const hit = (buffer: Buffer, source: ResolvedLogoResult["source"]): ResolvedLogoResult => ({ imageUrl: `https://rej.co/${source}.png`, source, domain: "rej.co", buffer, contentType: "image/png", ext: "png", width: 64, height: 64 });
  const deps = (resolve: LogoRepairDeps["resolve"], rejected: Set<string>): LogoRepairDeps => ({
    supabaseUrl: "https://proj.supabase.co",
    resolve,
    jobsFor: async () => [],
    knownDefaultHashes: none,
    rejectedHashes: async () => rejected,
    companiesSharingHash: async () => 0,
    upload: async () => "created",
    commitHosted: async () => true,
    recordFailure: async () => true,
    markAlreadyEligible: async () => undefined,
    now: () => new Date("2026-11-23T00:00:00Z"),
  });

  it("the resolver skips the rejected bytes (here from the homepage) and the next tier's different image is hosted", async () => {
    const rejectedBytes = await image(box(8, 8, 56, 56, [20, 20, 20, 255]));
    const changed = await image(box(10, 10, 54, 54, [30, 64, 175, 255])); // same company, changed image
    const out = await repairCompanyLogo(company, deps(async (_c, _j, opts) => {
      for (const cand of [hit(rejectedBytes, "homepage-icon"), hit(changed, "free-service")]) if (!(await opts.isRejected!(cand.buffer))) return cand;
      return null;
    }, new Set([sha(rejectedBytes)])));
    expect(out).toMatchObject({ status: "repaired", sha256: sha(changed) });
  });

  it("if every source returns the rejected bytes, the company keeps initials", async () => {
    const rejectedBytes = await image(box(8, 8, 56, 56, [20, 20, 20, 255]));
    for (const source of ["ats-board", "homepage-icon", "free-service"] as const) {
      // even a resolver that ignores isRejected cannot get them past the final check
      const out = await repairCompanyLogo(company, deps(async () => hit(rejectedBytes, source), new Set([sha(rejectedBytes)])));
      expect(out).toMatchObject({ status: "missing", reason: expect.stringMatching(/^rejected-image/) });
    }
  });

  it("a transparent candidate is never uploaded: initials instead", async () => {
    let uploads = 0;
    const transparent = await image(() => null);
    const out = await repairCompanyLogo(company, { ...deps(async () => hit(transparent, "ats-board"), new Set()), upload: async () => (uploads++, "created") });
    expect(out).toMatchObject({ status: "missing", reason: expect.stringMatching(/^invisible-logo/) });
    expect(uploads).toBe(0);
  });
});
