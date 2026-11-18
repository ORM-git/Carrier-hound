/**
 * user_preferences.country / country_code arrive with migration
 * 20261117_user_preferences_country.sql. Until that migration is applied, a
 * read or write that names those columns fails. Readers may degrade (drop the
 * columns from the SELECT and carry on without a country); writers must NOT
 * silently drop them and report success.
 */
export const COUNTRY_MIGRATION = "20261117_user_preferences_country.sql";

export function isMissingCountryColumnError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  // 42703: Postgres undefined_column (SELECT). PGRST204: PostgREST schema cache miss (INSERT/UPSERT).
  return (code === "42703" || code === "PGRST204") && /country/i.test(message);
}
