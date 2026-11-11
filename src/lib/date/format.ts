/**
 * Shared timezone-safe date and posted-at display formatter (Frontend sheet row
 * "Timezone-safe date display").
 *
 * Ensures consistent rendering of UTC instants without local midnight or
 * day-boundary shifts across all client timezones.
 */

export interface FormatDateOptions {
  now?: Date | number;
  locale?: string;
  timeZone?: string;
}

/**
 * Canonical shared posted-at formatter for job cards, ticker, radar, and feeds.
 * Relative formatting ("Just now", "Xh ago", "Yesterday", "Xd ago") is computed
 * from absolute epoch ms differences (timezone-invariant).
 * Absolute calendar dates (>30 days) format in UTC by default to avoid date-boundary jumps.
 */
export function formatPostedAt(
  dateInput?: string | number | Date | null,
  options?: FormatDateOptions
): string {
  if (!dateInput) return "Recently";
  try {
    const d = typeof dateInput === "object" && dateInput instanceof Date ? dateInput : new Date(dateInput);
    const timeMs = d.getTime();
    if (Number.isNaN(timeMs)) return "Recently";

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

    // Beyond 30 days: format with explicit timezone (default UTC) to prevent local day boundary shifts
    const tz = options?.timeZone || "UTC";
    const loc = options?.locale || "en-US";
    return d.toLocaleDateString(loc, {
      month: "short",
      day: "numeric",
      timeZone: tz,
    });
  } catch {
    return "Recently";
  }
}

/** Alias for formatDate compatibility across existing callsites */
export const formatDate = formatPostedAt;

/**
 * Formats a date string or Date object safely with explicit timezone (UTC by default).
 * Replaces direct calls to `new Date(...).toLocaleDateString()`.
 */
export function formatCalendarDate(
  dateInput: string | number | Date | null | undefined,
  opts?: Intl.DateTimeFormatOptions,
  locale = "en-US"
): string {
  if (!dateInput) return "—";
  try {
    const d = typeof dateInput === "object" && dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(locale, {
      timeZone: opts?.timeZone || "UTC",
      month: opts?.month || "short",
      day: opts?.day || "numeric",
      ...(opts?.year ? { year: opts.year } : {}),
      ...opts,
    });
  } catch {
    return "—";
  }
}
