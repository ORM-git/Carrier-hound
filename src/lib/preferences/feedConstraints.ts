/**
 * Saved feed constraints: the part of UserPreferences the Preferences sheet adds beyond the
 * original contract, and the ONE place that turns them into query predicates.
 *
 * Semantics (shared by /api/jobs/recommended, /api/jobs/search and the client that sends them):
 * - Each dimension is AND-ed with every other active filter.
 * - excludedTitles: a job is hidden when its title contains ANY entry (case-insensitive, literal).
 * - includedCompanies: OR inside the list; a job's company must equal one entry (case-insensitive, literal).
 * - excludedCompanies: a job is hidden when its company equals ANY entry. Include and exclude are both
 *   applied (AND), so a name in both lists is excluded and the inclusion list still limits the feed:
 *   include {Acme} + exclude {Acme} is an empty result, never "all employers".
 * - All matching is literal: every user character (quote, comma, %, _, parentheses, backslash, ...)
 *   means itself. Values travel as escaped case-insensitive regexes in plain PostgREST filters
 *   (`imatch`), never inside an `or=(...)` logic tree, so no value can change the filter structure.
 * - datePosted: posted_at >= now - window. A job without a source posting date (posted_at NULL,
 *   see #761) never matches an active window: unknown is not "new".
 * Policy gate: applying SAVED constraints to the feed is an owner decision (existing saved preferences
 * only rank). Until NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS=true, the client sends none of them;
 * they are stored and shown as "not applied". When enabled, they go only with the personalized feed
 * (Recommended tab / match sort). Browsing filters stay separate.
 */

/** Whether saved title/company/date constraints are applied to the feed (owner decision; default off). */
export function savedFeedConstraintsEnforced(
  env: Record<string, string | undefined> = { NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS: process.env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS }
): boolean {
  return env.NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS === "true";
}

export const DATE_POSTED_WINDOWS = ["24h", "3d", "7d", "30d"] as const;
export type DatePostedWindow = (typeof DATE_POSTED_WINDOWS)[number];

const WINDOW_MS: Record<DatePostedWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Canonical window for a stored or URL value (also the older "past week" style labels), else null. */
export function parseDatePosted(value?: string | null): DatePostedWindow | null {
  const v = (value || "").trim().toLowerCase();
  if (!v || v === "all" || v === "any") return null;
  if ((DATE_POSTED_WINDOWS as readonly string[]).includes(v)) return v as DatePostedWindow;
  if (v.includes("24")) return "24h";
  if (v.includes("3")) return v.includes("30") ? "30d" : "3d";
  if (v.includes("7") || v.includes("week")) return "7d";
  if (v.includes("month")) return "30d";
  return null;
}

/** ISO cutoff for posted_at >= cutoff, or null when no window applies. */
export function datePostedCutoff(value?: string | null, now: number = Date.now()): string | null {
  const w = parseDatePosted(value);
  return w ? new Date(now - WINDOW_MS[w]).toISOString() : null;
}

/** The narrower of two windows (a saved preference and a browsing filter both apply: AND). */
export function stricterDatePosted(a?: string | null, b?: string | null): DatePostedWindow | null {
  const wa = parseDatePosted(a);
  const wb = parseDatePosted(b);
  if (!wa || !wb) return wa || wb;
  return WINDOW_MS[wa] <= WINDOW_MS[wb] ? wa : wb;
}

export const WORK_MODELS = ["onsite", "hybrid", "remote"] as const;
export type WorkModel = (typeof WORK_MODELS)[number];

/** Valid, de-duplicated work models in canonical order. */
export function normalizeWorkModels(values: unknown): WorkModel[] {
  const set = new Set(Array.isArray(values) ? values.map((v) => String(v).trim().toLowerCase()) : []);
  return WORK_MODELS.filter((m) => set.has(m));
}

/** Reading a legacy row: the single remote_preference becomes a one-item set; "any"/empty is none. */
export function workModelsFromLegacy(remotePreference?: string | null): WorkModel[] {
  return normalizeWorkModels([remotePreference]);
}

/** The legacy single value written alongside work_models: the one selection, otherwise "any" (never remote-only). */
export function legacyRemotePreference(models: readonly WorkModel[]): WorkModel | "any" {
  return models.length === 1 ? models[0] : "any";
}

export const MAX_LIST_ITEMS = 50;
const MAX_ITEM_LENGTH = 100;

/** Trimmed, whitespace-collapsed, case-insensitively de-duplicated (first spelling kept), capped list. */
export function normalizeTextList(values: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(values) ? values : []) {
    if (typeof raw !== "string") continue;
    const v = raw.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_LENGTH);
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

export interface SavedFeedConstraints {
  excludedTitles: string[];
  includedCompanies: string[];
  excludedCompanies: string[];
  datePosted: DatePostedWindow | null;
}

/** Normalized constraints. Conflicts are kept: the query applies include AND exclude (exclusion wins). */
export function normalizeFeedConstraints(input: {
  excludedTitles?: unknown;
  includedCompanies?: unknown;
  excludedCompanies?: unknown;
  datePosted?: string | null;
} | null | undefined): SavedFeedConstraints {
  return {
    excludedTitles: normalizeTextList(input?.excludedTitles),
    includedCompanies: normalizeTextList(input?.includedCompanies),
    excludedCompanies: normalizeTextList(input?.excludedCompanies),
    datePosted: parseDatePosted(input?.datePosted),
  };
}

export function hasFeedConstraints(c: SavedFeedConstraints): boolean {
  return Boolean(c.excludedTitles.length || c.includedCompanies.length || c.excludedCompanies.length || c.datePosted);
}

export function companyConstraintsActive(c: SavedFeedConstraints): boolean {
  return Boolean(c.includedCompanies.length || c.excludedCompanies.length);
}

const PARAM = { excludeTitle: "excludeTitle", includeCompany: "includeCompany", excludeCompany: "excludeCompany" };

/** Adds the list constraints to request params (repeated keys, so names with commas survive). */
export function appendFeedConstraintParams(params: URLSearchParams, c: SavedFeedConstraints): void {
  c.excludedTitles.forEach((t) => params.append(PARAM.excludeTitle, t));
  c.includedCompanies.forEach((t) => params.append(PARAM.includeCompany, t));
  c.excludedCompanies.forEach((t) => params.append(PARAM.excludeCompany, t));
}

/** Server side: the list constraints from a request (date posted travels in the existing datePosted param). */
export function feedConstraintsFromParams(params: URLSearchParams): SavedFeedConstraints {
  return normalizeFeedConstraints({
    excludedTitles: params.getAll(PARAM.excludeTitle),
    includedCompanies: params.getAll(PARAM.includeCompany),
    excludedCompanies: params.getAll(PARAM.excludeCompany),
  });
}

// Postgres ARE: a backslash before a non-alphanumeric character makes it literal. Only ASCII
// punctuation/space is escaped (a backslash before a letter or digit would start an escape class);
// other characters, including non-ASCII letters, are not regex syntax and match themselves.
const literal = (s: string) => s.replace(/[\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/g, (c) => `\\${c}`);
const anyOf = (values: string[]) => `(${values.map(literal).join("|")})`;

interface FilterableQuery<Q> {
  not(column: string, operator: string, value: unknown): Q;
  filter(column: string, operator: string, value: unknown): Q;
}

/** Applies the list constraints to a jobs query (before ordering/pagination). Requires the `company` column. */
export function applyFeedConstraints<Q extends FilterableQuery<Q>>(query: Q, c: SavedFeedConstraints): Q {
  let q = query;
  if (c.excludedTitles.length) q = q.not("title", "imatch", anyOf(c.excludedTitles));
  if (c.includedCompanies.length) q = q.filter("company", "imatch", `^${anyOf(c.includedCompanies)}$`);
  if (c.excludedCompanies.length) q = q.not("company", "imatch", `^${anyOf(c.excludedCompanies)}$`);
  return q;
}

/** Client mirror of applyFeedConstraints + the date window, for tests and local predicates. */
export function matchesFeedConstraints(
  job: { title?: string | null; company?: string | null; postedAt?: string | null },
  c: SavedFeedConstraints,
  now: number = Date.now()
): boolean {
  const title = (job.title || "").toLowerCase();
  const company = (job.company || "").toLowerCase();
  if (c.excludedTitles.some((t) => title.includes(t.toLowerCase()))) return false;
  if (c.excludedCompanies.some((n) => company === n.toLowerCase())) return false;
  if (c.includedCompanies.length && !c.includedCompanies.some((n) => company === n.toLowerCase())) return false;
  const cutoff = datePostedCutoff(c.datePosted, now);
  if (cutoff) {
    if (!job.postedAt) return false;
    if (new Date(job.postedAt).getTime() < new Date(cutoff).getTime()) return false;
  }
  return true;
}
