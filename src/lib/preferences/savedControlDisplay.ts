/**
 * What the Jobs filter controls show as pre-selected from the saved (onboarding) preferences.
 *
 * Display only. The Recommended feed already uses the saved row to RANK (and, for country, widen to
 * remote/worldwide); these values are never sent as hard filters, never counted as active filters and never
 * listed as removable filter pills. Only controls whose saved value has the same vocabulary are covered:
 * job type, work model (multi-value kept in full) and country. Roles and skills have no matching control.
 */
import type { UserPreferences } from "@/lib/auth/types";
import { SUPPORTED_COUNTRIES } from "@/lib/countries";
import { normalizeWorkModels, workModelsFromLegacy } from "./feedConstraints";

export interface SavedControlDisplay {
  countryCode?: string;
  jobType?: string;
  workModel?: string;
}

export type SavedControlKey = keyof SavedControlDisplay;
export const SAVED_CONTROL_KEYS: SavedControlKey[] = ["countryCode", "jobType", "workModel"];

const JOB_TYPE_IDS = ["full-time", "contract", "part-time", "internship"];

export function savedControlDisplay(prefs: UserPreferences | null | undefined): SavedControlDisplay {
  if (!prefs) return {};
  const out: SavedControlDisplay = {};
  const types = (prefs.employmentTypes || []).map((t) => String(t).toLowerCase().trim()).filter((t, i, a) => JOB_TYPE_IDS.includes(t) && a.indexOf(t) === i);
  if (types.length) out.jobType = types.join(",");
  const models = prefs.workModels ? normalizeWorkModels(prefs.workModels) : workModelsFromLegacy(prefs.remotePreference);
  if (models.length) out.workModel = models.join(",");
  const code = (prefs.countryCode || "").toUpperCase();
  if (code && SUPPORTED_COUNTRIES.some((c: { code: string }) => c.code === code)) out.countryCode = code;
  return out;
}

const MODEL_LABEL: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site", "on-site": "On-site" };
const part = (csv: string | undefined, label: (v: string) => string) => {
  const items = (csv || "").split(",").filter(Boolean);
  return items.length ? `${label(items[0])}${items.length > 1 ? ` +${items.length - 1}` : ""}` : "";
};

/** One line naming the saved priorities that rank the Recommended feed ("" when none). Never a filter. */
export function savedPrioritiesSummary(d: SavedControlDisplay): string {
  return [
    d.countryCode ? `Country ${d.countryCode}` : "",
    part(d.jobType, (v) => v),
    part(d.workModel, (v) => MODEL_LABEL[v] || v),
  ].filter(Boolean).join(", ");
}
