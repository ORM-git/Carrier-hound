import { describe, expect, it, vi } from "vitest";
import { safeFetchCompanyPage } from "../safeFetch";

describe("company source SSRF guard", () => {
  it("rejects credentialed and non-HTTP targets before transport", async () => {
    const customFetch = vi.fn();
    await expect(safeFetchCompanyPage("file:///etc/passwd", { customFetch })).rejects.toThrow("HTTP(S)");
    await expect(safeFetchCompanyPage("https://user:pass@example.com/", { customFetch })).rejects.toThrow("HTTP(S)");
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("revalidates every redirect and refuses a redirect to loopback", async () => {
    const customFetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }));
    await expect(safeFetchCompanyPage("https://public.example/", {
      customLookup: async () => [{ address: "93.184.216.34", family: 4 }],
      customFetch,
    })).rejects.toThrow("Blocked private IP address");
    expect(customFetch).toHaveBeenCalledTimes(1);
  });

  it("limits accepted document types and body size", async () => {
    const customLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    await expect(safeFetchCompanyPage("https://public.example/", { customLookup, customFetch: async () => new Response("image", { headers: { "content-type": "image/png" } }) })).rejects.toThrow("content type");
  });
});
