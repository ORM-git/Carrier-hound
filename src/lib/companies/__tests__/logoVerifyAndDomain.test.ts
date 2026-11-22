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
    expect(decodesAsRaster(headerOnly)).toBe(false);
    const f = async (url: string) => {
      const body = new URL(url).hostname === "unavatar.io" ? headerOnly : good;
      return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/png" } });
    };
    const r = await fetchFreeLogoService("acme.com", 32, f, (b) => !decodesAsRaster(b));
    expect(r?.serviceName).not.toBe("unavatar");
    expect(decodesAsRaster(r!.buffer)).toBe(true);
  });
});
