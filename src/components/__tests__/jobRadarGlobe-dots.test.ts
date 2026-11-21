import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("react-toastify", () => ({ toast: {} }));

describe("fibonacciLandDots", () => {
  it("keeps only land points, all on the requested radius", async () => {
    const { fibonacciLandDots } = await import("@/components/JobRadarGlobe");
    const all = fibonacciLandDots(1000, 5, () => true);
    expect(all.length).toBe(3000);
    const north = fibonacciLandDots(1000, 5, (lat) => lat > 0);
    expect(north.length).toBe(1500);
    for (let i = 0; i < north.length; i += 3) {
      expect(Math.hypot(north[i], north[i + 1], north[i + 2])).toBeCloseTo(5, 5);
      expect(north[i + 1]).toBeGreaterThan(0); // +y is north in latLngToVector3
    }
    expect(fibonacciLandDots(1000, 5, () => false).length).toBe(0);
  }, 30_000); // importing the full component is slow under the parallel suite
});
