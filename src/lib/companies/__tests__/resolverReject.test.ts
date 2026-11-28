import { describe, expect, it } from "vitest";
import { downloadAndValidateImage, fetchFreeLogoService } from "../logoResolver";
import { sha256Hex } from "../logoRepair";

/** Minimal valid PNG header (signature + IHDR) of the given size; the resolver sniffs headers only. */
function png(w: number, h: number, tag: string): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);
  ihdr.set([8, 6, 0, 0, 0], 16);
  return Buffer.concat([sig, ihdr, Buffer.from(tag)]);
}

const vendorDefault = png(128, 128, "vendor-default-mark");
const realMark = png(128, 128, "acme-real-mark");

function fetcher(map: Record<string, Buffer | null>) {
  return async (url: string) => {
    const host = new URL(url).hostname;
    const body = map[host];
    if (!body) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/png", "content-length": String(body.length) } });
  };
}

describe("resolver skips rejected (vendor/default) images and continues down the chain", () => {
  it("falls through from a rejected service image to the next free service", async () => {
    const f = fetcher({ "unavatar.io": vendorDefault, "www.google.com": realMark });
    const rejected = new Set([sha256Hex(vendorDefault)]);
    const r = await fetchFreeLogoService("acme.com", 32, f, (b) => rejected.has(sha256Hex(b)));
    expect(r?.serviceName).toBe("google");
    expect(sha256Hex(r!.buffer)).toBe(sha256Hex(realMark));
  });

  it("returns null (initials) when every service only offers rejected images", async () => {
    const f = fetcher({ "unavatar.io": vendorDefault, "www.google.com": vendorDefault, "icons.duckduckgo.com": vendorDefault });
    const r = await fetchFreeLogoService("acme.com", 32, f, () => true);
    expect(r).toBeNull();
  });

  it("without a rejection hook keeps the first valid image (unchanged default behaviour)", async () => {
    const f = fetcher({ "unavatar.io": realMark, "www.google.com": vendorDefault });
    const r = await fetchFreeLogoService("acme.com", 32, f);
    expect(r?.serviceName).toBe("unavatar");
  });
});

describe("constructed Google favicon exception stays endpoint-scoped", () => {
  it("allows the exact generated endpoint but rejects another Google path and ATS redirects", async () => {
    let calls = 0;
    const f = async (url: string, options?: { isDeniedUrl?: (s: string) => boolean }) => {
      calls++;
      if (new URL(url).hostname === "unavatar.io") return new Response(null, { status: 404 });
      expect(url).toBe("https://www.google.com/s2/favicons?domain=acme.com&sz=128");
      expect(options?.isDeniedUrl?.(url)).toBe(false);
      expect(options?.isDeniedUrl?.("https://www.google.com/another-image.png")).toBe(true);
      expect(options?.isDeniedUrl?.("https://boards.greenhouse.io/icon.png")).toBe(true);
      const r = new Response(new Uint8Array(realMark), { status: 200 });
      Object.defineProperty(r, "url", { value: url });
      return r;
    };
    expect((await fetchFreeLogoService("acme.com", 32, f))?.serviceName).toBe("google");
    expect(calls).toBe(2);
    let arbitraryFetched = false;
    expect(await downloadAndValidateImage("https://www.google.com/another-image.png", 32, async () => {
      arbitraryFetched = true; return new Response(new Uint8Array(realMark));
    })).toBeNull();
    expect(arbitraryFetched).toBe(false);
  });
  it("refuses a denied final response even when a custom fetcher ignored hop policy", async () => {
    const f = async (url: string) => {
      if (!url.includes("google.com")) return new Response(null, { status: 404 });
      const r = new Response(new Uint8Array(realMark), { status: 200 });
      Object.defineProperty(r, "url", { value: "https://remoteok.com/icon.png" });
      return r;
    };
    expect(await fetchFreeLogoService("acme.com", 32, f)).toBeNull();
  });
});
