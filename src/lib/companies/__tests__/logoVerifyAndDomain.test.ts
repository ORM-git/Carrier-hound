import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { deriveCompanyDomain, fetchFreeLogoService } from "../logoResolver";
import { decodesAsRaster, verifyHostedLogo } from "../logoRepair";
import { makePng } from "./pngFixture";

const SB = "https://proj.supabase.co";
const ID = "11111111-1111-4111-8111-111111111111";
const URL_OK = `${SB}/storage/v1/object/public/company-logos/${ID}.png`;
const publicDns = async () => [{ address: "104.18.38.10", family: 4 }];
const serve = (body: Buffer | null, init: ResponseInit = { status: 200, headers: { "content-type": "image/png" } }) =>
  async () => new Response(body ? new Uint8Array(body) : null, init);

describe("verifyHostedLogo (sweep health check)", () => {
  it("accepts a decodable hosted PNG", async () => {
    expect(await verifyHostedLogo(URL_OK, SB, { customLookup: publicDns, customFetch: serve(makePng(32, 32, "x")) })).toBe("ok");
  });

  it("marks HTTP errors, non-images and undecodable bytes as broken", async () => {
    expect(await verifyHostedLogo(URL_OK, SB, { customLookup: publicDns, customFetch: serve(null, { status: 404 }) })).toBe("http-404");
    expect(await verifyHostedLogo(URL_OK, SB, { customLookup: publicDns, customFetch: serve(Buffer.from("<html>"), { status: 200, headers: { "content-type": "text/html" } }) })).toBe("not-a-raster-image");
    expect(await verifyHostedLogo(URL_OK, SB, { customLookup: publicDns, customFetch: serve(makePng(32, 32, "x").subarray(0, 40)) })).toBe("does-not-decode");
  });

  it("decodes every accepted format for real and rejects corrupt, header-only and oversized inputs", async () => {
    const rgba = { create: { width: 64, height: 64, channels: 4 as const, background: { r: 10, g: 120, b: 200, alpha: 1 } } };
    for (const fmt of ["png", "jpeg", "webp", "gif"] as const) {
      expect(await decodesAsRaster(await sharp(rgba).toFormat(fmt).toBuffer()), fmt).toBe(true);
    }
    // negative controls from the #698 re-review
    expect(await decodesAsRaster(makePng(128, 128, "x", 255)), "PNG filter byte 255").toBe(false);
    const gifHeader = Buffer.alloc(20);
    gifHeader.write("GIF89a", 0, "ascii");
    gifHeader.writeUInt16LE(64, 6);
    gifHeader.writeUInt16LE(64, 8);
    expect(gifHeader.length).toBe(20);
    expect(await decodesAsRaster(gifHeader), "20-byte header-only GIF").toBe(false);
    const jpeg = await sharp(rgba).jpeg().toBuffer();
    expect(await decodesAsRaster(jpeg.subarray(0, Math.floor(jpeg.length / 2))), "truncated JPEG").toBe(false);
    const webp = await sharp(rgba).webp().toBuffer();
    expect(await decodesAsRaster(webp.subarray(0, 30)), "header-only WebP").toBe(false);
    // bounded: a tiny compressed 4096x4096 image (decompression bomb shape) is refused, not expanded
    const bomb = await sharp({ create: { width: 4096, height: 4096, channels: 4, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(200_000);
    expect(await decodesAsRaster(bomb), "4096x4096 bomb").toBe(false);
  });

  it("the sweep marks HTTP-200 corrupt assets broken in every format", async () => {
    const gifHeader = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([64, 0, 64, 0]), Buffer.alloc(10)]);
    const gifUrl = `${SB}/storage/v1/object/public/company-logos/${ID}.gif`;
    expect(await verifyHostedLogo(gifUrl, SB, { customLookup: publicDns, customFetch: serve(gifHeader, { status: 200, headers: { "content-type": "image/gif" } }) })).not.toBe("ok");
    expect(await verifyHostedLogo(URL_OK, SB, { customLookup: publicDns, customFetch: serve(makePng(128, 128, "x", 255)) })).toBe("does-not-decode");
    const webp = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#123" } }).webp().toBuffer();
    const webpUrl = `${SB}/storage/v1/object/public/company-logos/${ID}.webp`;
    expect(await verifyHostedLogo(webpUrl, SB, { customLookup: publicDns, customFetch: serve(webp, { status: 200, headers: { "content-type": "image/webp" } }) })).toBe("ok");
  });

  it("never fetches anything outside this project's bucket", async () => {
    let fetched = false;
    const spy = async () => { fetched = true; return new Response(null); };
    for (const u of ["http://169.254.169.254/latest/meta-data", `https://other.supabase.co/storage/v1/object/public/company-logos/${ID}.png`, `${SB}/storage/v1/object/public/company-logos/%E0%A4%A.png`]) {
      expect(await verifyHostedLogo(u, SB, { customLookup: publicDns, customFetch: spy })).toBe("ineligible-url");
    }
    expect(fetched).toBe(false);
  });

  it("does not follow redirects and refuses a storage host resolving to a private address", async () => {
    const redirect = serve(null, { status: 302, headers: { location: "http://127.0.0.1/x.png" } });
    expect(await verifyHostedLogo(URL_OK, SB, { customLookup: publicDns, customFetch: redirect })).toMatch(/^fetch-error: Redirect limit/);
    const privateDns = async () => [{ address: "10.0.0.5", family: 4 }];
    expect(await verifyHostedLogo(URL_OK, SB, { customLookup: privateDns, customFetch: serve(makePng(32, 32, "x")) })).toMatch(/^fetch-error/);
  });
});

describe("employer-domain evidence and invalid candidates", () => {
  it("never takes the domain from an arbitrary link on an ATS page", () => {
    const html = `<html><a href="https://www.vendor-privacy.example/policy">Privacy</a><a href="https://twitter.com/x">t</a></html>`;
    expect(deriveCompanyDomain({ id: ID, name: "Acme", slug: "acme" } as any, [], null, html)).toBeNull();
    const withOrg = `<script type="application/ld+json">{"@type": "Organization", "url": "https://acme.com"}</script>${html}`;
    expect(deriveCompanyDomain({ id: ID, name: "Acme", slug: "acme" } as any, [], null, withOrg)).toBe("acme.com");
  });

  it("a candidate whose bytes do not decode is rejected and the chain continues", async () => {
    const headerOnly = makePng(128, 128, "a").subarray(0, 33);
    const good = makePng(128, 128, "acme-real");
    expect(await decodesAsRaster(headerOnly)).toBe(false);
    const f = async (url: string) => {
      const body = new URL(url).hostname === "unavatar.io" ? headerOnly : good;
      return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/png" } });
    };
    const r = await fetchFreeLogoService("acme.com", 32, f, async (b) => !(await decodesAsRaster(b)));
    expect(r?.serviceName).not.toBe("unavatar");
    expect(await decodesAsRaster(r!.buffer)).toBe(true);
  });
});
