import { describe, expect, it } from "vitest";
import { compactSalaryDisplay } from "./display";
describe("compact Indian salary display", () => {
  it("uses crore/lakh without changing foreign currency", () => {
    expect(compactSalaryDisplay("₹1,23,45,678 - ₹1,98,76,543 /year")).toBe("₹1.2 Cr - ₹2 Cr /year");
    expect(compactSalaryDisplay("INR 1500000 - 2000000 /yr")).toBe("INR 15 Lakh - 20 Lakh /yr");
    expect(compactSalaryDisplay("USD $148,000 - $237,500 per year")).toBe("USD $148,000 - $237,500 per year");
    expect(compactSalaryDisplay("₹50 /hr")).toBe("₹50 /hr");
    expect(compactSalaryDisplay("₹15 Lakh /yr")).toBe("₹15 Lakh /yr");
  });
  it("labels missing salary without inventing a range", () => {
    expect(compactSalaryDisplay("")).toBe("Not disclosed");
    expect(compactSalaryDisplay(null)).toBe("Not disclosed");
  });
});
