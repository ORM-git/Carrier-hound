/**
 * Shared timezone-safe date and posted-at display formatter (Frontend sheet row
 * "Timezone-safe date display").
 *
 * Ensures consistent rendering across client timezones while allowing explicit
 * local-mode rendering when preserving existing user-facing local dates.
 */

export interface FormatDateOptions {
  now?: Date | number;
  locale?: string;
  timeZone?: string;
  mode?: "utc" | "local";
  emptyFallback?: string;
  errorFallback?: string;
}

/**
 * Canonical shared posted-at formatter for job cards, ticker, radar, and feeds.
 * Relative formatting ("Just now", "Xh ago", "Yesterday", "Xd ago") is computed
 * from absolute epoch ms differences (timezone-invariant).
 *
 * Absolute calendar dates (>30 days):
 * - mode === "local": preserves the client's local timezone and locale defaults.
 * - mode === "utc" (default): formats in UTC ("en-US") to avoid date-boundary shifts.
 */
export function formatPostedAt(
  dateInput?: string | number | Date | null,
  options?: FormatDateOptions
): string {
  const emptyFallback = options?.emptyFallback ?? "Recently";
  const errorFallback = options?.errorFallback ?? "Recently";
  if (!dateInput) return emptyFallback;
  try {
    const d = typeof dateInput === "object" && dateInput instanceof Date ? dateInput : new Date(dateInput);
    const timeMs = d.getTime();
    if (Number.isNaN(timeMs)) return errorFallback;

    const nowMs = options?.now != null
      ? (typeof options.now === "number" ? options.now : options.now.getTime())
      : Date.now();
    const diffMs = nowMs - timeMs;

    // Clamp slight future clock skew within 5 minutes to "Just now"
    if (diffMs < 0) return "Just now";

    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 30) return `${diffDays}d ago`;

    // Beyond 30 days: format with explicit mode
    const mode = options?.mode || "utc";
    if (mode === "local") {
      const loc = options?.locale !== undefined ? options.locale : undefined;
      return d.toLocaleDateString(loc, {
        month: "short",
        day: "numeric",
        ...(options?.timeZone ? { timeZone: options.timeZone } : {}),
      });
    }

    const tz = options?.timeZone || "UTC";
    const loc = options?.locale || "en-US";
    return d.toLocaleDateString(loc, {
      month: "short",
      day: "numeric",
      timeZone: tz,
    });
  } catch {
    return errorFallback;
  }
}

/** Alias for formatDate compatibility across existing callsites */
export const formatDate = formatPostedAt;

export interface FormatCalendarDateOptions extends Intl.DateTimeFormatOptions {
  mode?: "utc" | "local";
  preserveRawOnInvalid?: boolean;
}

/**
 * Formats a date string or Date object safely with explicit timezone mode.
 * - mode === "utc" (default): enforces timeZone "UTC" and "en-US" to pin absolute instants.
 * - mode === "local": renders in the user's local timezone. When no format options are passed
 *   and locale is omitted, reproduces native `d.toLocaleDateString()` with no arguments.
 * - preserveRawOnInvalid: when true, returns the original input string on invalid date instead of "—".
 */
export function formatCalendarDate(
  dateInput: string | number | Date | null | undefined,
  opts?: FormatCalendarDateOptions,
  locale?: string
): string {
  if (!dateInput) return "—";
  try {
    const d = typeof dateInput === "object" && dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(d.getTime())) {
      return opts?.preserveRawOnInvalid ? String(dateInput) : "—";
    }

    const mode = opts?.mode || "utc";
    const { mode: _m, preserveRawOnInvalid: _p, ...rawFormatOpts } = opts || {};
    const hasExplicitFormatOpts = Object.keys(rawFormatOpts).length > 0;

    if (mode === "local") {
      if (!hasExplicitFormatOpts && locale === undefined) {
        return d.toLocaleDateString();
      }
      return d.toLocaleDateString(locale, hasExplicitFormatOpts ? rawFormatOpts : undefined);
    }

    // Default UTC mode
    const loc = locale || "en-US";
    return d.toLocaleDateString(loc, {
      timeZone: rawFormatOpts.timeZone || "UTC",
      month: rawFormatOpts.month || "short",
      day: rawFormatOpts.day || "numeric",
      ...(rawFormatOpts.year ? { year: rawFormatOpts.year } : {}),
      ...rawFormatOpts,
    });
  } catch {
    return opts?.preserveRawOnInvalid ? String(dateInput) : "—";
  }
}
