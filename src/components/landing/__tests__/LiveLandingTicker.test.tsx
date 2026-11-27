// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LiveLandingTicker, { safeTickerLogo, TICKER_REFRESH_MS } from "../LiveLandingTicker";
const rows = (company: string) => Array.from({ length: 5 }, (_, i) => ({ company: `${company} ${i}`, title: `Role ${i}`, posted_at: "2026-11-24T08:00:00Z", logo_url: i === 0 ? "https://fixture.supabase.co/storage/v1/object/public/company-logos/logo.png" : null }));
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-24T10:00:00Z")); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("live landing ticker", () => {
  it("fetches validated current rows, preserves strip classes and hides duplicate links from tab order", async () => {
    const fetcher = vi.fn(async (...args: [string, unknown?]) => { void args; return { ok: true, json: async () => rows("Today") }; }); vi.stubGlobal("fetch", fetcher);
    const { container } = render(<LiveLandingTicker />); await flush();
    expect(fetcher.mock.calls[0][0]).toBe("/api/ticker");
    expect(container.querySelectorAll(".ls-set")).toHaveLength(2);
    expect(container.querySelectorAll('.ls-set[aria-hidden="true"] a[tabindex="-1"]')).toHaveLength(5);
    expect(container.textContent).toContain("Today 0"); expect(container.textContent).not.toContain("Lumen Labs");
  });
  it("refresh replaces old rows and updates elapsed time; failed refresh clears stale entries", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => rows("Old") }).mockResolvedValueOnce({ ok: true, json: async () => rows("New") }).mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetcher); const { container } = render(<LiveLandingTicker />); await flush();
    await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS)); await flush(); expect(container.textContent).toContain("New 0"); expect(container.textContent).not.toContain("Old 0");
    await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS)); await flush(); expect(container.textContent).toBe("");
  });
  it("keeps initials while loading or on broken logos and rejects external/script URLs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows("Logo") })));
    const { container } = render(<LiveLandingTicker />); await flush();
    expect(container.querySelector(".ls-logo")?.textContent).toBe("L"); fireEvent.error(screen.getAllByAltText("Logo 0 logo")[0]);
    expect(container.querySelector(".ls-logo")?.textContent).toBe("L");
    for (const url of ["javascript:alert(1)", "https://evil.test/company-logos/a.png", "https://fixture.supabase.co/other/a.png"]) expect(safeTickerLogo(url)).toBeNull();
  });
  it("recovers the same failed URL only on an existing successful refresh and leaves loaded images alone", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => rows("GitLab") }));
    vi.stubGlobal("fetch", fetcher);
    render(<LiveLandingTicker />); await flush();
    const [failedImage, healthyImage] = screen.getAllByAltText("GitLab 0 logo");
    Object.defineProperty(healthyImage, "naturalWidth", { configurable: true, value: 1620 }); fireEvent.load(healthyImage);
    const src = failedImage.getAttribute("src"); fireEvent.error(failedImage);
    expect(screen.getAllByAltText("GitLab 0 logo")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS - 1)); await flush();
    expect(screen.getAllByAltText("GitLab 0 logo")).toHaveLength(1);
    await act(async () => vi.advanceTimersByTime(1)); await flush();
    const recovered = screen.getAllByAltText("GitLab 0 logo")[0];
    expect(recovered).not.toBe(failedImage); expect(recovered.getAttribute("src")).toBe(src);
    expect(screen.getAllByAltText("GitLab 0 logo")[1]).toBe(healthyImage);
    Object.defineProperty(recovered, "naturalWidth", { configurable: true, value: 1620 }); fireEvent.load(recovered);
    expect((recovered as HTMLElement).style.opacity).toBe("1");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("visibility bursts do not bypass the five-minute image retry bound", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows("GitLab") })));
    render(<LiveLandingTicker />); await flush();
    for (const img of screen.getAllByAltText("GitLab 0 logo")) fireEvent.error(img);
    for (let i=0;i<4;i++) { await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await flush(); }
    expect(screen.queryAllByAltText("GitLab 0 logo")).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS)); await flush();
    expect(screen.getAllByAltText("GitLab 0 logo")).toHaveLength(2);
  });
  it("caps persistent failures at two refresh retries and never retries in a hidden tab", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => rows("GitLab") })); vi.stubGlobal("fetch", fetcher);
    const view = render(<LiveLandingTicker />); await flush();
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const img of screen.getAllByAltText("GitLab 0 logo")) fireEvent.error(img);
      expect(screen.queryAllByAltText("GitLab 0 logo")).toHaveLength(0);
      if (attempt < 2) { await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS)); await flush(); }
    }
    await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS * 3)); await flush();
    expect(screen.queryAllByAltText("GitLab 0 logo")).toHaveLength(0);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const count = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS)); await flush(); expect(fetcher).toHaveBeenCalledTimes(count);
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it("gives loaded transparent brand images a white backing at every viewport", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows("Intercom") })));
    const { container } = render(<LiveLandingTicker />); await flush();
    const image = screen.getAllByAltText("Intercom 0 logo")[0];
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 5000 });
    fireEvent.load(image);
    expect((container.querySelector(".ls-logo") as HTMLElement).style.backgroundColor).toBe("rgb(255, 255, 255)");
    fireEvent.error(image);
    expect((container.querySelector(".ls-logo") as HTMLElement).style.backgroundColor).toBe("");
    expect(container.querySelector(".ls-logo")?.textContent).toBe("I");
  });
  it("skips hidden intervals and refreshes on visibility, cleaning up on unmount", async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => rows("Visible") })); vi.stubGlobal("fetch", fetcher);
    const view = render(<LiveLandingTicker />); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS)); expect(fetcher).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange"))); await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
    view.unmount(); await act(async () => vi.advanceTimersByTime(TICKER_REFRESH_MS)); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("hides malformed/future/short responses and aborts pending reads on unmount", async () => {
    let signal: AbortSignal | undefined; vi.stubGlobal("fetch", vi.fn((_url, opts) => { signal = opts.signal; return new Promise(() => {}); }));
    const view = render(<LiveLandingTicker />); expect(view.container.textContent).toBe(""); view.unmount(); expect(signal?.aborted).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => rows("Bad").map(r => ({ ...r, posted_at: "2999-01-01" })) })));
    const second = render(<LiveLandingTicker />); await flush(); expect(second.container.textContent).toBe("");
  });
});
