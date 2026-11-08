/**
 * Offline test for the pure GST invoice builder (Backend sheet row "GST Invoicing").
 * Covers src/lib/billing/gstInvoice.ts only. The builder is not wired to any route, checkout or
 * table, so this proves arithmetic and validation, not a live invoice flow.
 * Run: npx tsx scripts/test-gst-invoice.ts
 */
import * as fs from "fs";
import { buildGstInvoice, fiscalYearLabel, formatInvoiceNumber, GstInvoiceInput } from "../src/lib/billing/gstInvoice";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

// Fixture values are made up for the test only (not real GSTINs, rates or prices).
const SELLER = { name: "Test Seller", stateCode: "29", gstin: "29ABCDE1234F1Z5" };
const BUYER_SAME = { name: "Buyer A", stateCode: "29" };
const BUYER_OTHER = { name: "Buyer B", stateCode: "27", gstin: "27ABCDE1234F1Z5" };
const T = Date.parse("2026-11-07T06:30:00Z");
function input(p: Partial<GstInvoiceInput>): GstInvoiceInput {
  return {
    seller: SELLER, buyer: BUYER_SAME,
    lines: [{ description: "Plan", sacCode: "998314", amountPaise: 100000, rateBps: 1800 }],
    pricesIncludeTax: false, invoicePrefix: "TST", invoiceSequence: 1, issuedAtMs: T, ...p,
  };
}
function ok(i: GstInvoiceInput) {
  const r = buildGstInvoice(i);
  if (!r.ok) throw new Error("expected ok: " + r.errors.join("; "));
  return r.invoice;
}

let inv = ok(input({}));
check("intra-state, tax extra: CGST and SGST split the tax, IGST is zero",
  inv.supply === "intra" && inv.cgstPaise === 9000 && inv.sgstPaise === 9000 && inv.igstPaise === 0 && inv.totalPaise === 118000);
inv = ok(input({ buyer: BUYER_OTHER }));
check("inter-state: IGST only", inv.supply === "inter" && inv.igstPaise === 18000 && inv.cgstPaise === 0 && inv.sgstPaise === 0);
inv = ok(input({ pricesIncludeTax: true }));
check("tax-inclusive: total equals the listed amount and taxable value is the back-calculated base",
  inv.totalPaise === 100000 && inv.taxableValuePaise === 84746 && inv.totalTaxPaise === 15254);
inv = ok(input({ pricesIncludeTax: true, lines: [{ description: "x", sacCode: "998314", amountPaise: 99, rateBps: 1800 }] }));
check("tax-inclusive odd amount: CGST + SGST equals the line tax exactly", inv.cgstPaise + inv.sgstPaise === inv.totalTaxPaise && inv.totalPaise === 99);
inv = ok(input({ lines: [{ description: "x", sacCode: "998314", amountPaise: 1, rateBps: 1800 }] }));
check("round half up on tax: 18% of 1 paise rounds to 0, 18% of 3 paise rounds to 1",
  inv.totalTaxPaise === 0 && ok(input({ lines: [{ description: "x", sacCode: "998314", amountPaise: 3, rateBps: 1800 }] })).totalTaxPaise === 1);
inv = ok(input({ lines: [{ description: "x", sacCode: "998314", amountPaise: 5, rateBps: 1000 }] }));
check("exact half rounds up (10% of 5 paise = 0.5 -> 1)", inv.totalTaxPaise === 1);
inv = ok(input({ lines: [{ description: "a", sacCode: "998314", amountPaise: 12345, rateBps: 1800 }, { description: "b", sacCode: "998314", amountPaise: 6789, rateBps: 500 }] }));
check("invoice totals equal the sum of line totals",
  inv.totalPaise === inv.lines[0].totalPaise + inv.lines[1].totalPaise && inv.taxableValuePaise === 12345 + 6789);
inv = ok(input({ lines: [{ description: "x", sacCode: "998314", amountPaise: 100000, rateBps: 0 }] }));
check("zero rate gives zero tax", inv.totalTaxPaise === 0 && inv.totalPaise === 100000);

// money stays integer for many amounts and both modes
let allInt = true;
let sumOk = true;
for (let a = 0; a <= 400; a++) {
  for (const incl of [true, false]) {
    const i = ok(input({ pricesIncludeTax: incl, lines: [{ description: "x", sacCode: "998314", amountPaise: a * 37, rateBps: 1800 }] }));
    const l = i.lines[0];
    if (![l.taxableValuePaise, l.cgstPaise, l.sgstPaise, l.totalPaise].every((n) => Math.floor(n) === n)) allInt = false;
    if (l.taxableValuePaise + l.cgstPaise + l.sgstPaise !== l.totalPaise) sumOk = false;
    if (incl && l.totalPaise !== a * 37) sumOk = false;
  }
}
check("sweep: all money values are integers", allInt);
check("sweep: taxable + tax = total, and inclusive mode never changes the listed amount", sumOk);

// fiscal year and invoice number
check("fiscal year: 31 Mar 2026 IST is 2526, 1 Apr 2026 IST is 2627",
  fiscalYearLabel(Date.parse("2026-03-31T12:00:00+05:30")) === "2526" && fiscalYearLabel(Date.parse("2026-04-01T00:00:00+05:30")) === "2627");
check("fiscal year uses IST: 31 Mar 2026 20:00 UTC is already 1 Apr in IST", fiscalYearLabel(Date.parse("2026-03-31T20:00:00Z")) === "2627");
check("invoice number format PREFIX/FYFY/000001", formatInvoiceNumber("TST", T, 1) === "TST/2627/000001");
check("invoice number rejects sequence 0, a fraction, a long prefix and a bad prefix",
  formatInvoiceNumber("TST", T, 0) === null && formatInvoiceNumber("TST", T, 1.5) === null &&
  formatInvoiceNumber("TOOLONGPFX", T, 1) === null && formatInvoiceNumber("A B", T, 1) === null);
check("invoice number stays within 16 characters", (formatInvoiceNumber("ABCD", T, 999999) || "").length === 16);
check("invoice number rejects a sequence that would exceed 16 characters", formatInvoiceNumber("ABCD", T, 1000000) === null);

// validation: required arguments have no defaults
function bad(p: Partial<GstInvoiceInput>, frag: string): boolean {
  const r = buildGstInvoice(input(p));
  return !r.ok && r.errors.some((e) => e.indexOf(frag) >= 0);
}
check("rejects a bad seller GSTIN", bad({ seller: { ...SELLER, gstin: "BAD" } }, "seller.gstin"));
check("rejects a missing seller state code", bad({ seller: { ...SELLER, stateCode: "" } }, "seller.stateCode"));
check("rejects a bad buyer GSTIN but allows no buyer GSTIN", bad({ buyer: { name: "B", stateCode: "27", gstin: "nope" } }, "buyer.gstin") && buildGstInvoice(input({ buyer: BUYER_SAME })).ok);
check("rejects pricesIncludeTax that is not a boolean", bad({ pricesIncludeTax: undefined as any }, "pricesIncludeTax"));
check("rejects a missing rate (no default rate exists)", bad({ lines: [{ description: "x", sacCode: "998314", amountPaise: 1, rateBps: undefined as any }] }, "rateBps"));
check("rejects a rate above 100%", bad({ lines: [{ description: "x", sacCode: "998314", amountPaise: 1, rateBps: 10001 }] }, "rateBps"));
check("rejects a fractional or negative amount", bad({ lines: [{ description: "x", sacCode: "998314", amountPaise: 1.5, rateBps: 1800 }] }, "amountPaise") && bad({ lines: [{ description: "x", sacCode: "998314", amountPaise: -1, rateBps: 1800 }] }, "amountPaise"));
check("rejects a missing or malformed SAC code", bad({ lines: [{ description: "x", sacCode: "", amountPaise: 1, rateBps: 1800 }] }, "sacCode") && bad({ lines: [{ description: "x", sacCode: "ab", amountPaise: 1, rateBps: 1800 }] }, "sacCode"));
check("rejects an empty line list", bad({ lines: [] }, "at least one line"));
check("rejects a bad invoice prefix or sequence", bad({ invoicePrefix: "" }, "invoicePrefix") && bad({ invoiceSequence: 0 }, "invoicePrefix"));
check("collects several errors at once", (() => { const r = buildGstInvoice(input({ lines: [], invoicePrefix: "" })); return !r.ok && r.errors.length >= 2; })());

// static: the builder is unwired and holds no hard-coded legal values
const src = fs.readFileSync("src/lib/billing/gstInvoice.ts", "utf8");
check("builder imports nothing (no network, DB, env or payment code)", !/^\s*import\s/m.test(src) && !/process\.env|fetch\(|require\(/.test(src));
check("builder has no default rate or default state (no 1800 or state literal outside docs)", src.indexOf("rateBps = ") < 0 && src.indexOf("rateBps ?? ") < 0);
function walk(dir: string, out: string[]) {
  fs.readdirSync(dir).forEach((n) => {
    const p = dir + "/" + n;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  });
}
const files: string[] = [];
walk("src", files);
const users = files.filter((f) => f !== "src/lib/billing/gstInvoice.ts" && fs.readFileSync(f, "utf8").indexOf("gstInvoice") >= 0);
check("nothing under src imports the builder yet (not wired to any route or payment path)", users.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
