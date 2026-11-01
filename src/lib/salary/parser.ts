/**
 * Robust Salary Parser & Normalizer
 *
 * Implements strict multi-currency detection (ISO codes), international digit grouping
 * (Western 50,000 / 1,000,000 and Indian 1,00,000 / 50,00,000, suffixes k/lakh/m/cr),
 * pay period detection (yearly, monthly, hourly), and plausibility filters
 * (rejecting years 1990-2035, employee counts, user traffic, and corrupt ratios).
 */

import { convertCurrency } from './fx';

export type SalaryPeriod = 'yearly' | 'monthly' | 'hourly';

export interface ParsedSalary {
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  currency: string;
  salary_period: SalaryPeriod;
}

export interface ParseSalaryOptions {
  title?: string;
  location?: string;
  countryCode?: string;
  isExplicitSalaryField?: boolean;
}

/**
 * Formats structured numeric values into clean, locale-appropriate text.
 * E.g.:
 * - USD: "$120,000 - $160,000 /yr"
 * - INR: "₹12,00,000 - ₹18,00,000 /yr"
 * - EUR: "€65,000 - €85,000 /yr"
 * - GBP: "£50,000 - £70,000 /yr"
 * - Hourly: "$45 - $65 /hr"
 */
export function formatSalary(
  min: number | null | undefined,
  max: number | null | undefined,
  currency: string = 'USD',
  period: SalaryPeriod | string = 'yearly',
  optionsOrDisplayCurrency?: { omitSuffix?: boolean; displayCurrency?: string } | string
): string | null {
  if ((min === null || min === undefined) && (max === null || max === undefined)) {
    return null;
  }

  const options = typeof optionsOrDisplayCurrency === 'string'
    ? { displayCurrency: optionsOrDisplayCurrency }
    : optionsOrDisplayCurrency;

  const cleanPeriod = (period === 'monthly' || period === 'hourly' ? period : 'yearly') as SalaryPeriod;
  const periodSuffix = options?.omitSuffix
    ? ''
    : cleanPeriod === 'hourly'
      ? ' /hr'
      : cleanPeriod === 'monthly'
        ? ' /mo'
        : ' /yr';

  const sourceCurr = (currency || 'USD').toUpperCase().trim();
  const targetCurr = (options?.displayCurrency || sourceCurr).toUpperCase().trim();

  let formattedMin: number | null | undefined = min;
  let formattedMax: number | null | undefined = max;
  let isConverted = false;

  if (targetCurr && targetCurr !== sourceCurr) {
    const convertedMin = min != null ? convertCurrency(min, sourceCurr, targetCurr) : null;
    const convertedMax = max != null ? convertCurrency(max, sourceCurr, targetCurr) : null;

    if (convertedMin !== null || convertedMax !== null) {
      const roundConverted = (val: number | null): number | null => {
        if (val === null) return null;
        if (targetCurr === 'INR') {
          // INR to nearest thousand
          return Math.round(val / 1000) * 1000;
        }
        if (cleanPeriod === 'hourly' && val < 500) {
          // Keep whole integer for hourly rate under 500 to avoid rounding to 0
          return Math.round(val);
        }
        // Others to nearest hundred
        return Math.round(val / 100) * 100;
      };

      const roundedMin = roundConverted(convertedMin);
      const roundedMax = roundConverted(convertedMax);

      if (roundedMin !== null || roundedMax !== null) {
        formattedMin = roundedMin;
        formattedMax = roundedMax;
        isConverted = true;
      }
    }
  }

  const activeCurrency = isConverted ? targetCurr : sourceCurr;
  const approxPrefix = isConverted ? '~' : '';

  const formatNumber = (num: number, curr: string): string => {
    if (curr === 'INR') {
      return num.toLocaleString('en-IN', { maximumFractionDigits: 0 });
    }
    return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
  };

  const getCurrencyPrefix = (curr: string): string => {
    switch (curr.toUpperCase()) {
      case 'USD':
        return '$';
      case 'EUR':
        return '€';
      case 'GBP':
        return '£';
      case 'INR':
        return '₹';
      case 'CAD':
        return 'CA$';
      case 'AUD':
        return 'AU$';
      case 'SGD':
        return 'SG$';
      case 'CHF':
        return 'CHF ';
      default:
        return `${curr} `;
    }
  };

  const prefix = getCurrencyPrefix(activeCurrency);

  if (formattedMin != null && formattedMax != null && formattedMin !== formattedMax) {
    return `${approxPrefix}${prefix}${formatNumber(formattedMin, activeCurrency)} - ${prefix}${formatNumber(formattedMax, activeCurrency)}${periodSuffix}`;
  }

  const singleVal = formattedMin != null ? formattedMin : formattedMax!;
  return `${approxPrefix}${prefix}${formatNumber(singleVal, activeCurrency)}${periodSuffix}`;
}

/**
 * Extracts a candidate salary snippet from full text if given a long job description.
 */
function extractSalarySnippet(rawText: string): string | null {
  if (rawText.length <= 300) {
    return rawText;
  }

  // Pre-strip HTML tags
  const clean = rawText
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

  // Strip 401(k) mentions to avoid false positives
  const noRetirement = clean.replace(/401\s*\(?\s*k\s*\)?/gi, 'retirement_plan');

  // 1. Look for explicit salary/compensation labeled sections
  const labelPatterns = [
    /\b(?:base\s+salary|annual\s+base|salary\s+range|compensation\s+range|pay\s+range|base\s+pay|annual\s+salary|hourly\s+rate|compensation|salary|pay)\s*(?:is|of|:|-|–|—)?\s*([^\n\r;.]{5,140})/i,
    /\b(?:OTE|on-target\s+earnings)\s*(?:is|of|:|-|–|—)?\s*([^\n\r;.]{5,100})/i,
    /\b(?:expected\s+salary|remuneration)\s*(?:is|of|:|-|–|—)?\s*([^\n\r;.]{5,100})/i,
  ];

  for (const regex of labelPatterns) {
    const match = regex.exec(noRetirement);
    if (match && match[1]) {
      // Must contain at least one digit
      if (/\d/.test(match[1])) {
        return match[1].trim();
      }
    }
  }

  // 2. Look for explicit currency amounts with ranges (e.g. "$120,000 - $160,000" or "£60k - £80k")
  const currencyRangePattern =
    /(?:[$€£₹]|(?:USD|EUR|GBP|CAD|AUD|INR)\s*)\s*\d{1,3}(?:[.,]\d{3})*(?:\s*(?:k|lakh|lac|m))?\s*(?:[-–—]|to)\s*(?:[$€£₹]|(?:USD|EUR|GBP|CAD|AUD|INR)\s*)?\s*\d{1,3}(?:[.,]\d{3})*(?:\s*(?:k|lakh|lac|m))?(?:\s*(?:\/|per\s+)?(?:yr|year|annum|hr|hour|mo|month|pa))?/i;

  const rangeMatch = currencyRangePattern.exec(noRetirement);
  if (rangeMatch) {
    return rangeMatch[0].trim();
  }

  // 3. Look for explicit LPA / Lakhs pattern (e.g. "15 - 25 LPA")
  const lpaPattern = /\b\d{1,2}(?:\.\d+)?\s*(?:[-–—]|to)\s*\d{1,2}(?:\.\d+)?\s*(?:LPA|lakhs?|lac)\b/i;
  const lpaMatch = lpaPattern.exec(noRetirement);
  if (lpaMatch) {
    return lpaMatch[0].trim();
  }

  return null;
}

/**
 * Detects currency ISO code from snippet and context hints.
 */
function detectCurrency(text: string, context?: ParseSalaryOptions): { currency: string; confident: boolean } {
  const upper = text.toUpperCase();

  // Explicit symbols and unambiguous currency tokens
  if (text.includes('₹') || /\bINR\b/i.test(text) || /\b(?:lakh|lakhs|lac|lacs|crore|crores|lpa)\b/i.test(text)) {
    return { currency: 'INR', confident: true };
  }
  if (text.includes('€') || /\bEUR\b/i.test(text)) {
    return { currency: 'EUR', confident: true };
  }
  if (text.includes('£') || /\bGBP\b/i.test(text)) {
    return { currency: 'GBP', confident: true };
  }
  if (/\b(?:CAD|C\$|CA\$)\b/i.test(text)) {
    return { currency: 'CAD', confident: true };
  }
  if (/\b(?:AUD|A\$|AU\$)\b/i.test(text)) {
    return { currency: 'AUD', confident: true };
  }
  if (/\b(?:SGD|S\$)\b/i.test(text)) {
    return { currency: 'SGD', confident: true };
  }
  if (/\bCHF\b/i.test(text)) {
    return { currency: 'CHF', confident: true };
  }
  if (text.includes('$') || /\bUSD\b/i.test(text)) {
    // Check if location hints override to CAD or AUD
    const loc = (context?.location || '').toLowerCase();
    if (loc.includes('canada') || context?.countryCode === 'CA') {
      return { currency: 'CAD', confident: true };
    }
    if (loc.includes('australia') || context?.countryCode === 'AU') {
      return { currency: 'AUD', confident: true };
    }
    return { currency: 'USD', confident: true };
  }

  // If no symbol or ISO in text, check location hints
  const loc = (context?.location || '').toLowerCase();
  if (context?.countryCode === 'IN' || loc.includes('india') || loc.includes('bengaluru') || loc.includes('bangalore')) {
    return { currency: 'INR', confident: false };
  }
  if (context?.countryCode === 'GB' || loc.includes('united kingdom') || loc.includes('london')) {
    return { currency: 'GBP', confident: false };
  }
  if (context?.countryCode === 'CA' || loc.includes('canada')) {
    return { currency: 'CAD', confident: false };
  }
  if (context?.countryCode === 'AU' || loc.includes('australia')) {
    return { currency: 'AUD', confident: false };
  }

  // Default to USD only if explicit salary field was provided
  return { currency: 'USD', confident: false };
}

/**
 * Detects pay period from snippet.
 */
function detectPayPeriod(text: string): SalaryPeriod | null {
  if (/\b(?:per\s+hour|\/hr|\/hour|hourly|an\s+hour)\b/i.test(text)) {
    return 'hourly';
  }
  if (/\b(?:per\s+month|\/mo|\/month|monthly|a\s+month|p\.m\.|pm)\b/i.test(text)) {
    return 'monthly';
  }
  if (/\b(?:per\s+year|per\s+annum|\/yr|\/year|annually|annual|yearly|p\.a\.|pa|lpa)\b/i.test(text)) {
    return 'yearly';
  }
  return null;
}

/**
 * Parses numeric compensation amounts from a snippet.
 */
function parseNumericAmounts(text: string, currency: string): number[] {
  // Check for LPA format: e.g. "15 - 25 LPA" or "18 LPA"
  const lpaRegex = /(\d+(?:\.\d+)?)\s*(?:[-–—]|to)?\s*(\d+(?:\.\d+)?)?\s*LPA\b/gi;
  let lpaMatch: RegExpExecArray | null;
  const lpaNumbers: number[] = [];
  while ((lpaMatch = lpaRegex.exec(text)) !== null) {
    if (lpaMatch[1]) lpaNumbers.push(Math.round(parseFloat(lpaMatch[1]) * 100000));
    if (lpaMatch[2]) lpaNumbers.push(Math.round(parseFloat(lpaMatch[2]) * 100000));
  }
  if (lpaNumbers.length > 0) return lpaNumbers;

  // Normalize range separators and commas
  // First, strip isolated 401(k) and year-like keywords
  let clean = text
    .replace(/401\s*\(?\s*k\s*\)?/gi, '')
    .replace(/\b(?:since|founded\s+in|class\s+of|expected\s+graduation)\s*20\d\d\b/gi, '');

  const amounts: number[] = [];

  // Match numbers with optional suffix k, m, l, lakh, lac, cr, crore
  // Supports Western (120,000) and Indian (12,00,000) grouping
  const numberRegex = /(\d{1,3}(?:[.,]\d{2,3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|l|lac|lakh|lakhs|cr|crore|crores)?\b/gi;
  let match: RegExpExecArray | null;

  while ((match = numberRegex.exec(clean)) !== null) {
    let rawStr = match[1];
    const suffix = (match[2] || '').toLowerCase();

    // Check if this looks like European style e.g. 65.000 or 65.000,00
    if (/^\d{1,3}\.\d{3}(?:,\d+)?$/.test(rawStr)) {
      rawStr = rawStr.replace(/\./g, '').replace(/,/g, '.');
    } else {
      // Normal comma-separated
      rawStr = rawStr.replace(/,/g, '');
    }

    let val = parseFloat(rawStr);
    if (isNaN(val) || val <= 0) continue;

    if (suffix === 'k') val *= 1000;
    else if (suffix === 'm') val *= 1000000;
    else if (suffix === 'l' || suffix === 'lac' || suffix === 'lakh' || suffix === 'lakhs') val *= 100000;
    else if (suffix === 'cr' || suffix === 'crore' || suffix === 'crores') val *= 10000000;

    val = Math.round(val);

    // Filter out obvious calendar years (e.g. 1990-2035) IF no multiplier was attached
    const isBareYear = !suffix && val >= 1990 && val <= 2035;
    if (isBareYear) {
      continue;
    }

    amounts.push(val);
  }

  return amounts;
}

/**
 * Validates parsed range for scale, plausible tech salary ranges, and ratio sanity.
 */
function validateSalaryScale(
  min: number,
  max: number,
  currency: string,
  period: SalaryPeriod
): { valid: boolean; adjustedPeriod: SalaryPeriod } {
  // Ratio sanity: maximum salary should not be > 5x minimum salary
  if (min > 0 && max / min > 5) {
    return { valid: false, adjustedPeriod: period };
  }

  // Reject if both min and max fall into suspicious calendar year range
  if (min >= 1990 && min <= 2035 && max >= 1990 && max <= 2035) {
    return { valid: false, adjustedPeriod: period };
  }

  // Check based on period
  if (period === 'hourly') {
    if (currency === 'INR') {
      if (min >= 100 && max <= 25000) return { valid: true, adjustedPeriod: 'hourly' };
    } else {
      if (min >= 10 && max <= 600) return { valid: true, adjustedPeriod: 'hourly' };
    }
    return { valid: false, adjustedPeriod: period };
  }

  if (period === 'monthly') {
    if (currency === 'INR') {
      if (min >= 8000 && max <= 2500000) return { valid: true, adjustedPeriod: 'monthly' };
    } else {
      if (min >= 800 && max <= 50000) return { valid: true, adjustedPeriod: 'monthly' };
    }
    return { valid: false, adjustedPeriod: period };
  }

  // Yearly
  if (currency === 'INR') {
    // 1 Lakh to 3 Crore per year
    if (min >= 100000 && max <= 35000000) {
      return { valid: true, adjustedPeriod: 'yearly' };
    }
    return { valid: false, adjustedPeriod: period };
  }

  // Western currencies (USD, EUR, GBP, CAD, AUD, etc.)
  // Detect if actually hourly despite missing tag (e.g. $45 - $80)
  if (min >= 12 && max <= 500 && max < 1000) {
    return { valid: true, adjustedPeriod: 'hourly' };
  }

  // Plausible yearly range: $15k to $1.5M
  if (min >= 15000 && max <= 1500000) {
    return { valid: true, adjustedPeriod: 'yearly' };
  }

  return { valid: false, adjustedPeriod: period };
}

/**
 * Main Salary Parser
 *
 * Parses any raw salary string or full job description and extracts
 * normalized salary_min, salary_max, currency, salary_period, and salary_text.
 * Never invents defaults: returns null if no valid salary exists.
 */
export function parseSalary(
  rawSalary: string | null | undefined,
  options: ParseSalaryOptions = {}
): ParsedSalary {
  const nullResult: ParsedSalary = {
    salary_text: null,
    salary_min: null,
    salary_max: null,
    currency: 'USD',
    salary_period: 'yearly',
  };

  if (!rawSalary || !rawSalary.trim()) {
    return nullResult;
  }

  const raw = rawSalary.trim();

  // Extract relevant snippet (avoids full-description false positives)
  const snippet = extractSalarySnippet(raw);
  if (!snippet) {
    return nullResult;
  }

  // Detect currency
  const { currency, confident } = detectCurrency(snippet, options);

  // If text is not an explicit salary field and has neither confident currency nor currency symbol, reject
  const hasCurrencySymbol = /[$€£₹]|\b(?:USD|EUR|GBP|INR|CAD|AUD|SGD|CHF|LPA)\b/i.test(snippet);
  if (!options.isExplicitSalaryField && !hasCurrencySymbol && !confident) {
    return nullResult;
  }

  // Detect pay period (defaults to yearly unless hourly/monthly detected)
  const explicitPeriod = detectPayPeriod(snippet);
  const initialPeriod = explicitPeriod || 'yearly';

  // Parse numbers
  const amounts = parseNumericAmounts(snippet, currency);
  if (amounts.length === 0) {
    return nullResult;
  }

  amounts.sort((a, b) => a - b);
  let min = amounts[0];
  let max = amounts[amounts.length - 1];

  // If multiple numbers, take the most plausible pair (avoid outliers)
  if (amounts.length > 2) {
    // If smallest is < 1000 and largest is > 15000, filter out the small number if not hourly
    const bigNumbers = amounts.filter((n) => n >= 15000);
    if (bigNumbers.length >= 2) {
      min = bigNumbers[0];
      max = bigNumbers[bigNumbers.length - 1];
    } else if (bigNumbers.length === 1) {
      min = bigNumbers[0];
      max = bigNumbers[0];
    }
  }

  // If only a single number was matched:
  if (min === max) {
    const hasExplicitLabel = /\b(?:salary|compensation|pay|rate|remuneration|ote)\b/i.test(snippet);
    const hasExplicitPeriod = explicitPeriod !== null;
    const hasKOrL = /\b\d+\s*(?:k|lakh|lac|m|cr|lpa)\b/i.test(snippet);
    // If it's a bare number without label, without period, and without suffix (e.g. "$20,000", "$500,000" from org/user counts), reject
    if (!hasExplicitLabel && !hasExplicitPeriod && !hasKOrL) {
      return nullResult;
    }
  }

  // Plausibility check
  const { valid, adjustedPeriod } = validateSalaryScale(min, max, currency, initialPeriod);
  if (!valid) {
    return nullResult;
  }

  const salary_text = formatSalary(min, max, currency, adjustedPeriod);

  return {
    salary_text,
    salary_min: min,
    salary_max: max,
    currency,
    salary_period: adjustedPeriod,
  };
}
