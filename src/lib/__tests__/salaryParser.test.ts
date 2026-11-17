import { describe, it, expect } from "vitest";
import { parseSalary, formatSalary, detectPayPeriod, normalizeSalaryPeriod } from "@/lib/salary/parser";
import { convertCurrency } from "@/lib/salary/fx";

describe("Salary Parser & Formatter Unit Tests", () => {
  it("rejects corrupted years, team counts, retirement plans, and user traffic", () => {
    expect(parseSalary("EUR 2,007 - 50,00,000").salary_text).toBeNull();
    expect(parseSalary("$2,025 - 5,00,00,000").salary_text).toBeNull();
    expect(parseSalary("CAD 2,027 - 2,027").salary_text).toBeNull();
    expect(parseSalary("$2,022").salary_text).toBeNull();
    expect(parseSalary("AUD 1,00,000 - 80,00,000").salary_text).toBeNull();
    expect(parseSalary("Join our 2,500+ team members worldwide").salary_text).toBeNull();
    expect(parseSalary("401(k) matching up to 4%").salary_text).toBeNull();
    expect(parseSalary("Over 50,00,000 active users").salary_text).toBeNull();
    expect(parseSalary("Founded in 2015 with $50M Series B").salary_text).toBeNull();
  });

  it("parses valid salary expressions across USD, GBP, EUR, INR, CAD, AUD, and hourly rates", () => {
    const usRange = parseSalary("$120,000 - $160,000");
    expect(usRange.salary_min).toBe(120000);
    expect(usRange.salary_max).toBe(160000);
    expect(usRange.currency).toBe("USD");
    expect(usRange.salary_period).toBe("yearly");
    expect(usRange.salary_text).toBe("$120,000 - $160,000 /yr");

    const kSuffix = parseSalary("$140k - $180k / year");
    expect(kSuffix.salary_min).toBe(140000);
    expect(kSuffix.salary_max).toBe(180000);

    const singleVal = parseSalary("Base Salary: $150,000 USD");
    expect(singleVal.salary_min).toBe(150000);
    expect(singleVal.salary_max).toBe(150000);

    const gbpRange = parseSalary("£60,000 - £80,000 per year");
    expect(gbpRange.currency).toBe("GBP");
    expect(gbpRange.salary_min).toBe(60000);

    const eurRange = parseSalary("€65,000 - €85,000");
    expect(eurRange.currency).toBe("EUR");

    const inrRange = parseSalary("₹18,00,000 - ₹25,00,000 per annum");
    expect(inrRange.currency).toBe("INR");
    expect(inrRange.salary_min).toBe(1800000);

    const lpaRange = parseSalary("20 - 35 LPA");
    expect(lpaRange.currency).toBe("INR");
    expect(lpaRange.salary_min).toBe(2000000);
    expect(lpaRange.salary_max).toBe(3500000);

    const hourlyRange = parseSalary("$45 - $65 / hour");
    expect(hourlyRange.salary_period).toBe("hourly");
    expect(hourlyRange.salary_min).toBe(45);
    expect(hourlyRange.salary_max).toBe(65);

    const cadRange = parseSalary("CAD $110,000 - $140,000");
    expect(cadRange.currency).toBe("CAD");

    const audRange = parseSalary("AUD $120,000 - $150,000");
    expect(audRange.currency).toBe("AUD");
  });

  it("extracts compensation from full text descriptions and ignores irrelevant descriptions", () => {
    const fullText = `About the Role:
We are looking for a Staff Software Engineer to join our Platform team.
Founded in 2015, we have over 2,500 team members and 50,000,000 active users.

Compensation:
The base salary range for this role is $180,000 - $225,000 USD per year.

Benefits:
- 401(k) matching up to 4%
- Comprehensive health, dental, and vision insurance`;
    const res = parseSalary(fullText);
    expect(res.salary_min).toBe(180000);
    expect(res.salary_max).toBe(225000);

    const noSalaryText = `About Figma:
We are looking for a Recruiter based in Singapore.
In this role you will partner with hiring managers.
Founded in 2012. We have 1,500 employees worldwide.
© 2022 Figma, Inc. All rights reserved.`;
    expect(parseSalary(noSalaryText).salary_text).toBeNull();
  });

  it("formats salaries correctly with periods, currencies, and conversion options", () => {
    expect(formatSalary(null, null)).toBeNull();
    expect(formatSalary(120000, 160000, "USD", "yearly")).toBe("$120,000 - $160,000 /yr");
    expect(formatSalary(45, 65, "USD", "hourly")).toBe("$45 - $65 /hr");
    expect(formatSalary(50000, 80000, "INR", "monthly")).toBe("₹50,000 - ₹80,000 /mo");
    expect(formatSalary(120000, 160000, "USD", undefined, { omitSuffix: true })).toBe("$120,000 - $160,000");
    expect(formatSalary(150000, null, "USD")).toBe("$150,000 /yr");

    // Currency conversions
    const inrConverted = formatSalary(100000, 150000, "USD", "yearly", { displayCurrency: "INR" });
    expect(inrConverted).toContain("₹");
    expect(inrConverted).toContain("~");

    const hourlyInr = formatSalary(50, 75, "USD", "hourly", { displayCurrency: "INR" });
    expect(hourlyInr).toContain("₹");
    expect(hourlyInr).toContain("/hr");

    const monthlyInr = formatSalary(5000, 8000, "USD", "monthly", { displayCurrency: "INR" });
    expect(monthlyInr).toContain("₹");
    expect(monthlyInr).toContain("/mo");

    const eurConverted = formatSalary(100000, 120000, "USD", "yearly", { displayCurrency: "EUR" });
    expect(eurConverted).toContain("€");

    // FX direct conversion check
    expect(convertCurrency(100, "USD", "EUR")).toBeGreaterThan(0);
    expect(convertCurrency(100, "UNKNOWN", "USD")).toBeNull();
  });

  it("detects and normalizes pay period aliases across year, month, and hour variants", () => {
    // Yearly aliases
    const yearlyAliases = ["year", "yearly", "annual", "annum", "yr", "pa", "p.a.", "lpa", "per year", "/yr", "per annum", "annually"];
    for (const alias of yearlyAliases) {
      expect(detectPayPeriod(alias)).toBe("yearly");
      expect(normalizeSalaryPeriod(alias)).toBe("yearly");
    }

    // Monthly aliases
    const monthlyAliases = ["month", "monthly", "mo", "pm", "p.m.", "per month", "/mo", "a month"];
    for (const alias of monthlyAliases) {
      expect(detectPayPeriod(alias)).toBe("monthly");
      expect(normalizeSalaryPeriod(alias)).toBe("monthly");
    }

    // Hourly aliases
    const hourlyAliases = ["hour", "hourly", "hr", "per hour", "/hr", "an hour"];
    for (const alias of hourlyAliases) {
      expect(detectPayPeriod(alias)).toBe("hourly");
      expect(normalizeSalaryPeriod(alias)).toBe("hourly");
    }

    // Non-period and empty strings
    expect(detectPayPeriod("")).toBeNull();
    expect(detectPayPeriod(null)).toBeNull();
    expect(detectPayPeriod(undefined)).toBeNull();
    expect(detectPayPeriod("unspecified")).toBeNull();
    expect(detectPayPeriod("401(k) matching")).toBeNull();
  });
});
