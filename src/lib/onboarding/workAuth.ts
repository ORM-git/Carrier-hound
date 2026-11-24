/**
 * Work authorization: one contract for the onboarding UI, the onboarding API and saved preferences.
 *
 * Options: 1 = authorized, 2 = requires_sponsorship, 3 = other.
 * Valid non-empty sets are exactly {1}, {2}, {3} and {2,3}: option 1 is exclusive.
 * Stored as a single string (the `work_auth` text column): the option labels in option order,
 * joined by " + ". Parsing also accepts option ids and older label wording, so existing
 * saved values keep working.
 */
import { WORK_AUTH_OPTIONS } from "@/data/onboardingCategories";

export type WorkAuthId = "authorized" | "requires_sponsorship" | "other";

const ORDER: WorkAuthId[] = ["authorized", "requires_sponsorship", "other"];
const SEPARATOR = " + ";

/** Earlier display labels for the same options. Add the old label here whenever a label's copy changes. */
const LEGACY_LABELS: Record<string, WorkAuthId> = {
  "Authorized to work (No sponsorship required)": "authorized",
  "Requires visa sponsorship (e.g. H1B)": "requires_sponsorship",
  "Other / Work Permit": "other",
};

// Exact match only: e.g. the legacy seeded "Authorized" must not be read as the "authorized" option.
function idFor(token: string): WorkAuthId | null {
  const t = token.trim();
  if (!t) return null;
  const opt = WORK_AUTH_OPTIONS.find((o) => o.id === t || o.label === t);
  return opt ? (opt.id as WorkAuthId) : LEGACY_LABELS[t] ?? null;
}

export function isValidWorkAuthSet(ids: readonly string[]): boolean {
  const set = new Set(ids);
  if (set.size !== ids.length || set.size === 0) return false;
  if (!ids.every((id) => (ORDER as string[]).includes(id))) return false;
  return !(set.has("authorized") && set.size > 1);
}

/**
 * Returns the selected ids in option order, [] for an empty value,
 * or null when the value is not a string, has an unknown option or is an invalid combination.
 */
export function parseWorkAuth(value: unknown): WorkAuthId[] | null {
  if (typeof value !== "string") return null;
  if (!value.trim()) return [];
  const ids: WorkAuthId[] = [];
  for (const token of value.split(SEPARATOR)) {
    const id = idFor(token);
    if (!id) return null;
    ids.push(id);
  }
  if (!isValidWorkAuthSet(ids)) return null;
  return ORDER.filter((id) => ids.includes(id));
}

/** Canonical stored string for a valid set. Throws on an invalid set so it can never be persisted. */
export function serializeWorkAuth(ids: readonly WorkAuthId[]): string {
  if (!isValidWorkAuthSet(ids)) throw new Error("Invalid work authorization selection");
  return ORDER.filter((id) => ids.includes(id))
    .map((id) => WORK_AUTH_OPTIONS.find((o) => o.id === id)!.label)
    .join(SEPARATOR);
}

/** True only for a saved/selected value that is one of the four valid sets. */
export function isWorkAuthComplete(value: unknown): boolean {
  const ids = parseWorkAuth(value);
  return Boolean(ids && ids.length > 0);
}

/**
 * Applies one tap on an option and returns the new stored string ("" when nothing is selected).
 * Tapping a selected option clears it; option 1 clears 2/3; options 2/3 clear 1 and may coexist.
 */
export function toggleWorkAuth(current: string, id: WorkAuthId): string {
  const selected = parseWorkAuth(current) ?? [];
  let next: WorkAuthId[];
  if (selected.includes(id)) next = selected.filter((x) => x !== id);
  else if (id === "authorized") next = ["authorized"];
  else next = [...selected.filter((x) => x !== "authorized"), id];
  return next.length ? serializeWorkAuth(next) : "";
}
