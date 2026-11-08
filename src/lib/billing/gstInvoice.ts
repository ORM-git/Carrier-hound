/**
 * Pure GST tax-invoice builder (Backend sheet row "GST Invoicing").
 *
 * Not wired to any route, checkout, webhook or database. Nothing calls it today, so it changes
 * no behavior. Every legal or commercial value is a REQUIRED argument: tax rate, seller details,
 * invoice prefix and sequence, and whether the listed price already includes tax. None of them has
 * a default, because the right values belong to the owner and their accountant.
 *
 * All money is integer paise. No floating point is used for money.
 */

export interface GstParty {
  name: string;
  /** Two-digit GST state code, for example "29". */
  stateCode: string;
  /** 15-character GSTIN. Required for the seller, optional for a B2C buyer. */
  gstin?: string;
}

export interface GstLineInput {
  description: string;
  /** HSN or SAC code. Required, no default. */
  sacCode: string;
  /** Integer paise for the whole line (quantity already applied). */
  amountPaise: number;
  /** GST rate in basis points (1800 = 18%). Required, no default. */
  rateBps: number;
}

export interface GstInvoiceInput {
  seller: GstParty & { gstin: string };
  buyer: GstParty;
  lines: GstLineInput[];
  /** True when amountPaise already contains GST. Required, no default. */
  pricesIncludeTax: boolean;
  /** Invoice number parts, see formatInvoiceNumber. */
  invoicePrefix: string;
  invoiceSequence: number;
  /** Issue instant, used for the Indian fiscal year (April to March, IST). */
  issuedAtMs: number;
}

export interface GstLineResult {
  description: string;
  sacCode: string;
  rateBps: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
}

export interface GstInvoice {
  invoiceNumber: string;
  fiscalYear: string;
  /** "intra" = CGST + SGST, "inter" = IGST. Decided by seller vs buyer state code. */
  supply: "intra" | "inter";
  lines: GstLineResult[];
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalTaxPaise: number;
  totalPaise: number;
}

export type GstInvoiceResult = { ok: true; invoice: GstInvoice } | { ok: false; errors: string[] };

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const STATE_RE = /^[0-9]{2}$/;
const INVOICE_NO_RE = /^[A-Za-z0-9/-]{1,16}$/;
const PREFIX_RE = /^[A-Za-z0-9-]{1,4}$/;
const IST_OFFSET_MS = 330 * 60 * 1000;

function isInt(n: unknown): n is number {
  return typeof n === "number" && isFinite(n) && Math.floor(n) === n;
}

/** Indian fiscal year label for an instant, for example "2627" for 1 Apr 2026 to 31 Mar 2027. */
export function fiscalYearLabel(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return String(start % 100).padStart(2, "0") + String((start + 1) % 100).padStart(2, "0");
}

/**
 * PREFIX/FYFY/000001. GST rules cap an invoice number at 16 characters and allow letters, digits,
 * slash and hyphen. The caller owns the sequence; this function never generates one.
 */
export function formatInvoiceNumber(prefix: string, issuedAtMs: number, sequence: number): string | null {
  if (!PREFIX_RE.test(prefix) || !isInt(sequence) || sequence < 1) return null;
  const number = prefix + "/" + fiscalYearLabel(issuedAtMs) + "/" + String(sequence).padStart(6, "0");
  return INVOICE_NO_RE.test(number) ? number : null;
}

/** Integer round-half-up of numerator / denominator for non-negative integers. */
function divRound(numerator: number, denominator: number): number {
  return Math.floor((2 * numerator + denominator) / (2 * denominator));
}

export function validateGstInvoiceInput(input: GstInvoiceInput): string[] {
  const errors: string[] = [];
  if (!input.seller || !GSTIN_RE.test(input.seller.gstin || "")) errors.push("seller.gstin must be a 15-character GSTIN");
  if (!input.seller || !STATE_RE.test(input.seller.stateCode || "")) errors.push("seller.stateCode must be two digits");
  if (!input.seller || !input.seller.name) errors.push("seller.name is required");
  if (!input.buyer || !STATE_RE.test(input.buyer.stateCode || "")) errors.push("buyer.stateCode must be two digits");
  if (!input.buyer || !input.buyer.name) errors.push("buyer.name is required");
  if (input.buyer && input.buyer.gstin !== undefined && !GSTIN_RE.test(input.buyer.gstin)) errors.push("buyer.gstin, when given, must be a 15-character GSTIN");
  if (typeof input.pricesIncludeTax !== "boolean") errors.push("pricesIncludeTax must be true or false");
  if (!Array.isArray(input.lines) || input.lines.length === 0) errors.push("at least one line is required");
  else {
    input.lines.forEach((l, i) => {
      if (!l.description) errors.push("lines[" + i + "].description is required");
      if (!l.sacCode || !/^[0-9]{4,8}$/.test(l.sacCode)) errors.push("lines[" + i + "].sacCode must be 4 to 8 digits");
      if (!isInt(l.amountPaise) || l.amountPaise < 0) errors.push("lines[" + i + "].amountPaise must be a non-negative integer");
      if (!isInt(l.rateBps) || l.rateBps < 0 || l.rateBps > 10000) errors.push("lines[" + i + "].rateBps must be an integer from 0 to 10000");
    });
  }
  if (!isFinite(input.issuedAtMs)) errors.push("issuedAtMs must be a finite number");
  else if (formatInvoiceNumber(input.invoicePrefix, input.issuedAtMs, input.invoiceSequence) === null) {
    errors.push("invoicePrefix (1-4 letters, digits, hyphen) and invoiceSequence (integer >= 1) must give a number of at most 16 characters");
  }
  return errors;
}

export function buildGstInvoice(input: GstInvoiceInput): GstInvoiceResult {
  const errors = validateGstInvoiceInput(input);
  if (errors.length > 0) return { ok: false, errors };

  const supply: "intra" | "inter" = input.seller.stateCode === input.buyer.stateCode ? "intra" : "inter";
  const lines: GstLineResult[] = input.lines.map((l) => {
    let taxable: number;
    let tax: number;
    if (input.pricesIncludeTax) {
      // amount = taxable + tax, tax = taxable * rate. Round the taxable value, tax is the remainder.
      taxable = divRound(l.amountPaise * 10000, 10000 + l.rateBps);
      tax = l.amountPaise - taxable;
    } else {
      taxable = l.amountPaise;
      tax = divRound(taxable * l.rateBps, 10000);
    }
    // Split intra-state tax so CGST + SGST equals the line tax exactly.
    const cgst = supply === "intra" ? Math.floor(tax / 2) : 0;
    const sgst = supply === "intra" ? tax - cgst : 0;
    const igst = supply === "inter" ? tax : 0;
    return {
      description: l.description,
      sacCode: l.sacCode,
      rateBps: l.rateBps,
      taxableValuePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst,
      totalPaise: taxable + tax,
    };
  });

  let taxable = 0;
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  lines.forEach((l) => {
    taxable += l.taxableValuePaise;
    cgst += l.cgstPaise;
    sgst += l.sgstPaise;
    igst += l.igstPaise;
  });
  const totalTax = cgst + sgst + igst;
  const number = formatInvoiceNumber(input.invoicePrefix, input.issuedAtMs, input.invoiceSequence) as string;
  return {
    ok: true,
    invoice: {
      invoiceNumber: number,
      fiscalYear: fiscalYearLabel(input.issuedAtMs),
      supply,
      lines,
      taxableValuePaise: taxable,
      cgstPaise: cgst,
      sgstPaise: sgst,
      igstPaise: igst,
      totalTaxPaise: totalTax,
      totalPaise: taxable + totalTax,
    },
  };
}
