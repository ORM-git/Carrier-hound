/**
 * Frontend sheet row "Client schema validation (zod/yup)".
 * Small hand-written runtime validators for the public JSON payloads the
 * browser consumes (/api/stats and /api/ticker). No schema library: this
 * module is imported by landing client code, which has a first-load budget.
 * A malformed response is dropped or normalised to null instead of reaching
 * component state. No rendered output changes for well-formed payloads.
 */

export class ClientSchemaValidationError extends Error {
  readonly schema: string;
  readonly reason: string;

  constructor(schema: string, reason: string) {
    super(`Client schema validation failed (${schema}): ${reason}`);
    this.name = "ClientSchemaValidationError";
    this.schema = schema;
    this.reason = reason;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function optStringOrNull(
  row: Record<string, unknown>,
  field: string,
  schema: string,
  index: number
): string | null {
  if (!(field in row) || row[field] === undefined || row[field] === null) {
    return null;
  }
  const value = row[field];
  if (typeof value !== "string") {
    throw new ClientSchemaValidationError(
      schema,
      `row[${index}].${field} must be a string or null`
    );
  }
  return value;
}

function optBooleanOrNull(
  row: Record<string, unknown>,
  field: string,
  schema: string,
  index: number
): boolean | null {
  if (!(field in row) || row[field] === undefined || row[field] === null) {
    return null;
  }
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new ClientSchemaValidationError(
      schema,
      `row[${index}].${field} must be a boolean or null`
    );
  }
  return value;
}

function reqNonEmptyString(
  row: Record<string, unknown>,
  field: string,
  schema: string,
  index: number
): string {
  const value = row[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClientSchemaValidationError(
      schema,
      `row[${index}].${field} must be a non-empty string`
    );
  }
  return value;
}

function reqString(
  row: Record<string, unknown>,
  field: string,
  schema: string,
  index: number
): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new ClientSchemaValidationError(
      schema,
      `row[${index}].${field} must be a string`
    );
  }
  return value;
}

export interface ParsedStats {
  activeJobs: number | null;
  companies: number | null;
  jobsToday: number | null;
  totalJobs: number | null;
  companiesScanned: number | null;
  updatedAt?: string;
}

/** Null when the payload is not an object; bad counts become null (jobsToday defaults to 0). */
export function parseStatsResponse(raw: unknown): ParsedStats | null {
  if (!isRecord(raw)) return null;
  const activeJobs = numOrNull(raw.activeJobs) ?? numOrNull(raw.totalJobs);
  const companies = numOrNull(raw.companies) ?? numOrNull(raw.companiesScanned);
  return {
    activeJobs,
    companies,
    jobsToday: numOrNull(raw.jobsToday) ?? 0,
    totalJobs: activeJobs,
    companiesScanned: companies,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  };
}

/** Landing globe strip: counts stay null when absent (no invented figures). */
export function parseGlobeStats(raw: unknown): {
  jobsToday: number;
  totalJobs: number | null;
  companiesScanned: number | null;
} | null {
  if (!isRecord(raw)) return null;
  return {
    jobsToday: numOrNull(raw.jobsToday) ?? 0,
    totalJobs: numOrNull(raw.totalJobs),
    companiesScanned: numOrNull(raw.companiesScanned),
  };
}

export interface TickerItemParsed {
  company: string;
  title: string;
  posted_at: string;
  logo_url: string | null;
}

function parseTickerItem(item: unknown): TickerItemParsed | null {
  if (!isRecord(item)) return null;
  const { company, title, posted_at } = item;
  if (typeof company !== "string") return null;
  if (typeof title !== "string") return null;
  if (typeof posted_at !== "string") return null;
  // Missing logo_url -> null; present but not string|null -> drop the item.
  const logo = "logo_url" in item ? item.logo_url : null;
  if (logo !== null && typeof logo !== "string") return null;
  return { company, title, posted_at, logo_url: logo };
}

/** Accepts a bare array or { jobs: [...] }; drops malformed items; anything else -> []. */
export function parseTickerResponse(raw: unknown): TickerItemParsed[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.jobs)
      ? raw.jobs
      : [];
  const out: TickerItemParsed[] = [];
  for (const item of list) {
    const parsed = parseTickerItem(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export interface SearchJobRowParsed {
  id: string;
  title: string;
  company: string;
  location: string | null;
  date: string | null;
  first_seen_at: string | null;
  salary_text: string | null;
  category: string | null;
  remote: boolean | null;
  remote_scope: string | null;
  country_code: string | null;
  country: string | null;
  job_type: string | null;
  apply_url: string | null;
}

/** Validates Supabase rows returned by searchJobs() primary query. */
export function parseSearchJobsRows(raw: unknown): SearchJobRowParsed[] {
  const schema = "searchJobs.rows";
  if (!Array.isArray(raw)) {
    throw new ClientSchemaValidationError(schema, "expected an array of job rows");
  }
  const out: SearchJobRowParsed[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!isRecord(row)) {
      throw new ClientSchemaValidationError(schema, `row[${i}] must be an object`);
    }
    out.push({
      id: reqNonEmptyString(row, "id", schema, i),
      title: reqString(row, "title", schema, i),
      company: reqString(row, "company", schema, i),
      location: optStringOrNull(row, "location", schema, i),
      date: optStringOrNull(row, "date", schema, i),
      first_seen_at: optStringOrNull(row, "first_seen_at", schema, i),
      salary_text: optStringOrNull(row, "salary_text", schema, i),
      category: optStringOrNull(row, "category", schema, i),
      remote: optBooleanOrNull(row, "remote", schema, i),
      remote_scope: optStringOrNull(row, "remote_scope", schema, i),
      country_code: optStringOrNull(row, "country_code", schema, i),
      country: optStringOrNull(row, "country", schema, i),
      job_type: optStringOrNull(row, "job_type", schema, i),
      apply_url: optStringOrNull(row, "apply_url", schema, i),
    });
  }
  return out;
}

export interface SearchJobFacetRowParsed {
  category: string | null;
  country: string | null;
}

/** Validates Supabase rows returned by searchJobs() facet query. */
export function parseSearchJobsFacetRows(raw: unknown): SearchJobFacetRowParsed[] {
  const schema = "searchJobs.facets";
  if (!Array.isArray(raw)) {
    throw new ClientSchemaValidationError(schema, "expected an array of facet rows");
  }
  const out: SearchJobFacetRowParsed[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!isRecord(row)) {
      throw new ClientSchemaValidationError(schema, `row[${i}] must be an object`);
    }
    out.push({
      category: optStringOrNull(row, "category", schema, i),
      country: optStringOrNull(row, "country", schema, i),
    });
  }
  return out;
}

export interface WorldwideCompanyRowParsed {
  name: string;
  slug: string;
  country: string | null;
  active_job_count: number;
}

function reqNonNegativeCount(
  row: Record<string, unknown>,
  field: string,
  schema: string,
  index: number
): number {
  const value = row[field];
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new ClientSchemaValidationError(
        schema,
        `row[${index}].${field} must be a non-negative finite number`
      );
    }
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new ClientSchemaValidationError(
    schema,
    `row[${index}].${field} must be a non-negative finite number or integer string`
  );
}

/** Validates Supabase rows returned by getWorldwideCompanies() view query. */
export function parseWorldwideCompanyRows(raw: unknown): WorldwideCompanyRowParsed[] {
  const schema = "worldwideCompanyCounts.rows";
  if (!Array.isArray(raw)) {
    throw new ClientSchemaValidationError(schema, "expected an array of company count rows");
  }
  const out: WorldwideCompanyRowParsed[] = [];
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    if (!isRecord(row)) {
      throw new ClientSchemaValidationError(schema, `row[${i}] must be an object`);
    }
    out.push({
      name: reqString(row, "name", schema, i),
      slug: reqNonEmptyString(row, "slug", schema, i),
      country: optStringOrNull(row, "country", schema, i),
      active_job_count: reqNonNegativeCount(row, "active_job_count", schema, i),
    });
  }
  return out;
}
