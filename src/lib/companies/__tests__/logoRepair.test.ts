import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { classifyLogoUrl, eligibleLogoUrl, firstEligibleLogo, logoObjectKey } from "../logoEligibility";
import { decodesAsRaster, MAX_LOGO_ATTEMPTS, nextAttempt, repairCompanyLogo, type ClaimedCompany, type LogoRepairDeps } from "../logoRepair";
import { makePng } from "./pngFixture";

const SB = "https://proj.supabase.co";
const ID = "11111111-1111-4111-8111-111111111111";
const PNG = makePng(64, 64, "acme");
const SHA = crypto.createHash("sha256").update(PNG).digest("hex");
const HOSTED = `${SB}/storage/v1/object/public/company-logos/${ID}/${SHA}.png`;

const company = (over: Partial<ClaimedCompany> = {}): ClaimedCompany => ({
  id: ID, name: "Acme", slug: "acme", domain: "acme.com", careers_url: null, ats_type: "greenhouse",
  logo_url: null, logo_attempts: 0, claim_token: "tok-1", ...over,
});

function deps(over: Partial<LogoRepairDeps> = {}) {
  const store = new Map<string, Buffer>();
  const rows = new Map<string, { logo_url: string | null; token: string }>([[ID, { logo_url: null, token: "tok-1" }]]);
  const d: LogoRepairDeps & { store: Map<string, Buffer>; rows: typeof rows } = {
    store, rows,
    supabaseUrl: SB,
    resolve: vi.fn(async () => ({ imageUrl: "https://boards.greenhouse.io/acme/logo.png", source: "ats-board" as const, domain: "acme.com", buffer: PNG, contentType: "image/png", ext: "png", width: 256, height: 256 })),
    jobsFor: vi.fn(async () => [{ apply_url: "https://boards.greenhouse.io/acme/jobs/1" }]),
    knownDefaultHashes: new Set<string>(),
    rejectedHashes: vi.fn(async () => new Set<string>()),
    companiesSharingHash: vi.fn(async () => 0),
    upload: vi.fn(async (key: string, bytes: Buffer) => { if (store.has(key)) return "exists" as const; store.set(key, bytes); return "created" as const; }),
    commitHosted: vi.fn(async (a) => { const r = rows.get(a.id)!; if (r.token !== a.token || r.logo_url !== a.expectedLogoUrl) return false; r.logo_url = a.logoUrl; return true; }),
    recordFailure: vi.fn(async (a) => { const r = rows.get(a.id)!; if (r.token !== a.token) return false; if (a.clearLogoUrl) r.logo_url = null; return true; }),
    markAlreadyEligible: vi.fn(async () => undefined),
    now: () => new Date("2026-11-22T10:00:00Z"),
    ...over,
  };
  return d;
}

describe("logo eligibility contract", () => {
  it("accepts only this project's company-logos objects with id-scoped raster keys", () => {
    expect(eligibleLogoUrl(HOSTED, SB)).toBe(HOSTED);
    expect(eligibleLogoUrl(`${SB}/storage/v1/object/public/company-logos/${ID}.webp`, SB)).not.toBeNull(); // legacy key
    for (const bad of [
      "https://www.google.com/s2/favicons?domain=acme.com&sz=128",
      "https://unavatar.io/acme.com?fallback=false",
      "https://s2-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/1/acme.png",
      "https://other.supabase.co/storage/v1/object/public/company-logos/" + ID + ".png",
      `${SB}/storage/v1/object/public/other-bucket/${ID}.png`,
      `${SB}/storage/v1/object/public/company-logos/${ID}.svg`,
      `${SB}/storage/v1/object/public/company-logos/acme.png`,
      `${HOSTED}?x=1`,
      `http://proj.supabase.co/storage/v1/object/public/company-logos/${ID}.png`,
      "javascript:alert(1)", "", null, 42,
    ]) expect(eligibleLogoUrl(bad, SB)).toBeNull();
    expect(classifyLogoUrl(null, SB)).toBe("null");
    expect(classifyLogoUrl("https://unavatar.io/a.com", SB)).toBe("external");
    expect(classifyLogoUrl(HOSTED, SB)).toBe("hosted");
    // malformed %-escapes fall back to initials instead of throwing into a list/detail/ticker render
    expect(eligibleLogoUrl(`${SB}/storage/v1/object/public/company-logos/bad%E0%A4%A.png`, SB)).toBeNull();
    expect(() => firstEligibleLogo([`${SB}/storage/v1/object/public/company-logos/%zz.png`, HOSTED], SB)).not.toThrow();
    expect(firstEligibleLogo([null, "https://unavatar.io/a.com", HOSTED], SB)).toBe(HOSTED);
  });

  it("builds deterministic content-hashed keys and refuses unsafe parts", () => {
    expect(logoObjectKey(ID, SHA, "PNG")).toBe(`${ID}/${SHA}.png`);
    expect(logoObjectKey(ID, SHA, "jpeg")).toBe(`${ID}/${SHA}.jpg`);
    expect(() => logoObjectKey("../x", SHA, "png")).toThrow();
    expect(() => logoObjectKey(ID, "abc", "png")).toThrow();
    expect(() => logoObjectKey(ID, SHA, "svg")).toThrow();
  });
});

describe("repairCompanyLogo", () => {
  it("uploads verified bytes to a content-hashed key and commits the hosted URL + verified domain", async () => {
    const d = deps();
    const out = await repairCompanyLogo(company(), d);
    expect(out).toMatchObject({ status: "repaired", logoUrl: HOSTED, source: "ats-board", sha256: SHA });
    expect(d.store.has(`${ID}/${SHA}.png`)).toBe(true);
    expect(d.commitHosted).toHaveBeenCalledWith(expect.objectContaining({ logoUrl: HOSTED, domain: "acme.com", expectedLogoUrl: null, token: "tok-1" }));
    expect(d.rows.get(ID)!.logo_url).toBe(HOSTED);
  });

  it("never passes a stored logo to the resolver and never stores an external URL", async () => {
    const d = deps();
    d.rows.get(ID)!.logo_url = "https://www.google.com/s2/favicons?domain=acme.com&sz=128";
    await repairCompanyLogo(company({ logo_url: "https://www.google.com/s2/favicons?domain=acme.com&sz=128" }), d);
    expect((d.resolve as any).mock.calls[0][0].logo_url).toBeNull();
    expect(d.rows.get(ID)!.logo_url).toBe(HOSTED);
  });

  it("is idempotent: re-running with identical bytes reuses the object (no second upload of new content)", async () => {
    const d = deps();
    await repairCompanyLogo(company(), d);
    d.rows.get(ID)!.logo_url = null; // simulate a later re-check
    const again = await repairCompanyLogo(company(), d);
    expect(again.status).toBe("repaired");
    expect(d.store.size).toBe(1);
    await expect((d.upload as any).mock.results[1].value).resolves.toBe("exists");
  });

  it("skips companies that already have an eligible hosted logo", async () => {
    const d = deps();
    const out = await repairCompanyLogo(company({ logo_url: HOSTED }), d);
    expect(out.status).toBe("already-eligible");
    expect(d.resolve).not.toHaveBeenCalled();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("when every source fails: keeps logo null, clears an external URL, records the reason and a backoff", async () => {
    const d = deps({ resolve: vi.fn(async () => null) });
    d.rows.get(ID)!.logo_url = "https://unavatar.io/acme.com";
    const out = await repairCompanyLogo(company({ logo_url: "https://unavatar.io/acme.com" }), d);
    expect(out.status).toBe("missing");
    expect(out.reason).toMatch(/^no-source/);
    expect(out.nextAttemptAt).toBe("2026-11-22T11:00:00.000Z");
    expect(d.rows.get(ID)!.logo_url).toBeNull();
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("rejects known default branding and images shared with other companies", async () => {
    const def = await repairCompanyLogo(company(), deps({ knownDefaultHashes: new Set([SHA]) }));
    expect(def).toMatchObject({ status: "missing", reason: expect.stringMatching(/^default-branding/) });
    const shared = await repairCompanyLogo(company(), deps({ companiesSharingHash: vi.fn(async () => 1) }));
    expect(shared).toMatchObject({ status: "missing", reason: expect.stringMatching(/^shared-image/) });
  });

  it("an upload failure is a transient failure with retry; nothing is committed", async () => {
    const d = deps({ upload: vi.fn(async () => { throw new Error("503 storage unavailable"); }) });
    const out = await repairCompanyLogo(company(), d);
    expect(out).toMatchObject({ status: "failed", reason: expect.stringMatching(/^upload-failed/) });
    expect(d.commitHosted).not.toHaveBeenCalled();
    expect(d.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", attempts: 1 }));
  });

  it("a commit whose response is lost keeps the (now live) object and reports a retryable failure", async () => {
    const d = deps();
    // the DB applies the update, then the response is lost
    d.commitHosted = vi.fn(async (a) => { d.rows.get(a.id)!.logo_url = a.logoUrl; throw new Error("socket hang up"); });
    const out = await repairCompanyLogo(company(), d);
    expect(out).toMatchObject({ status: "failed", reason: expect.stringMatching(/^db-update-failed/) });
    expect(d.rows.get(ID)!.logo_url).toBe(HOSTED);
    expect(d.store.has(`${ID}/${SHA}.png`)).toBe(true); // the referenced object was NOT deleted
  });

  it("a definite non-commit (row changed / lease lost) never deletes the object either", async () => {
    const d = deps({ commitHosted: vi.fn(async () => false) });
    const out = await repairCompanyLogo(company(), d);
    expect(out.reason).toMatch(/^db-update-skipped/);
    expect(d.store.size).toBe(1);
  });

  it("a pending (verified-broken) hosted logo is repaired for real, not re-blessed by URL shape", async () => {
    const d = deps();
    const broken = `${SB}/storage/v1/object/public/company-logos/${ID}.png`;
    d.rows.get(ID)!.logo_url = broken;
    const out = await repairCompanyLogo(company({ logo_url: broken, logo_status: "pending" }), d);
    expect(d.resolve).toHaveBeenCalledTimes(1);
    expect(d.markAlreadyEligible).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: "repaired", logoUrl: HOSTED });
    expect(d.rows.get(ID)!.logo_url).toBe(HOSTED);

    // and if nothing resolves, the broken URL is cleared so the UI shows initials
    const d2 = deps({ resolve: vi.fn(async () => null) });
    d2.rows.get(ID)!.logo_url = broken;
    const out2 = await repairCompanyLogo(company({ logo_url: broken, logo_status: "pending" }), d2);
    expect(out2.status).toBe("missing");
    expect(d2.rows.get(ID)!.logo_url).toBeNull();
  });

  it("only bytes that decode are hosted: a bare PNG header is rejected as corrupt", async () => {
    const headerOnly = PNG.subarray(0, 33); // signature + IHDR (claims 64x64), no IDAT payload
    expect(await decodesAsRaster(PNG)).toBe(true);
    expect(await decodesAsRaster(headerOnly)).toBe(false);
    const d = deps({ resolve: vi.fn(async () => ({ imageUrl: "https://acme.com/i.png", source: "homepage-icon" as const, domain: "acme.com", buffer: headerOnly, contentType: "image/png", ext: "png", width: 64, height: 64 })) });
    const out = await repairCompanyLogo(company(), d);
    expect(out).toMatchObject({ status: "missing", reason: expect.stringMatching(/^corrupt-image/) });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("a CRC-correct PNG with an illegal row filter (255) is never hosted", async () => {
    const corrupt = makePng(128, 128, "acme", 255);
    expect(await decodesAsRaster(corrupt)).toBe(false);
    const d = deps({ resolve: vi.fn(async () => ({ imageUrl: "https://acme.com/i.png", source: "homepage-icon" as const, domain: "acme.com", buffer: corrupt, contentType: "image/png", ext: "png", width: 128, height: 128 })) });
    expect(await repairCompanyLogo(company(), d)).toMatchObject({ status: "missing", reason: expect.stringMatching(/^corrupt-image/) });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("two workers racing on one company: only the claim holder commits", async () => {
    const d = deps();
    const [a, b] = await Promise.all([
      repairCompanyLogo(company({ claim_token: "tok-1" }), d),
      repairCompanyLogo(company({ claim_token: "stale-token" }), d),
    ]);
    expect([a.status, b.status].sort()).toEqual(["failed", "repaired"]);
    expect([a, b].find((o) => o.status === "failed")!.reason).toMatch(/db-update-skipped/);
    expect(d.rows.get(ID)!.logo_url).toBe(HOSTED);
    expect(d.store.size).toBe(1);
  });

  it("backs off 1h, 6h, 24h, 72h, 7d, then rechecks a missing logo after 30 days", () => {
    const now = new Date("2026-11-22T00:00:00Z");
    const hours = [1, 2, 3, 4, 5, 6].map((a) => (nextAttempt(a, now, true).at.getTime() - now.getTime()) / 3600_000);
    expect(hours).toEqual([1, 6, 24, 72, 168, 720]);
    expect(nextAttempt(MAX_LOGO_ATTEMPTS + 1, now, true).status).toBe("missing");
  });

  it("rejects banner-sized images (e.g. a homepage og:image social card) as not-a-logo", async () => {
    const d = deps({ resolve: vi.fn(async () => ({ imageUrl: "https://acme.com/og.png", source: "homepage-icon" as const, domain: "acme.com", buffer: PNG, contentType: "image/png", ext: "png", width: 2996, height: 1955 })) });
    const out = await repairCompanyLogo(company(), d);
    expect(out).toMatchObject({ status: "missing", reason: expect.stringMatching(/^not-a-logo: 2996x1955/) });
    expect(d.upload).not.toHaveBeenCalled();
  });

  it("a resolver crash never throws into ingestion", async () => {
    const d = deps({ resolve: vi.fn(async () => { throw new Error("ECONNRESET"); }) });
    await expect(repairCompanyLogo(company(), d)).resolves.toMatchObject({ status: "failed", reason: expect.stringMatching(/^resolver-error/) });
  });
});
