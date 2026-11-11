export type SourceType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'recruitee'
  | 'workable'
  | 'breezy'
  | 'teamtailor'
  | 'personio'
  | 'bamboohr'
  | 'join'
  | 'adzuna'
  | 'remotive'
  | 'arbeitnow'
  | 'remoteok'
  | 'weworkremotely'
  | 'custom_rss';

export interface SourceConfig {
  id: string;
  name: string;
  type: SourceType;
  /** Company slug (for ATS endpoints) or custom URL (for RSS/APIs) */
  target: string;
  enabled: boolean;
  rateLimitMs?: number;
  /** Optional override for category / tags */
  category?: string;
}

export interface NormalizedJob {
  source: string;
  source_job_id: string;
  title: string;
  company: string;
  company_slug?: string;
  company_id?: string | null;
  location: string;
  country_code?: string | null;
  remote: boolean;
  remote_scope?: 'remote' | 'hybrid' | 'onsite' | 'any';
  remote_eligibility?: 'worldwide' | 'country_restricted' | 'unknown';
  job_type: 'job' | 'internship' | 'full-time' | 'part-time' | 'contract' | 'other';
  seniority?: 'entry' | 'mid' | 'senior' | 'staff' | 'lead' | 'director' | 'unknown';
  description?: string | null;
  skills?: string[];
  apply_url: string;
  source_url?: string | null;
  source_type?: 'ats' | 'api' | 'feed' | 'direct';
  salary_text?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  salary_period?: 'yearly' | 'monthly' | 'hourly';
  currency?: string;
  category?: string;
  country?: string;
  posted_at?: string; // ISO string
  expires_at?: string | null; // ISO string
  discovered_at?: string; // ISO string
  last_seen_at?: string; // ISO string
  is_active?: boolean;
  verified?: boolean;
  verified_at?: string | null;
}

export interface SourceStats {
  sourceId: string;
  sourceName: string;
  type: SourceType;
  board?: string;
  fetched: number;
  normalized: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  new_canonical?: number;
  reopened?: number;
  rejected?: number;
  duplicate?: number;
  unknown?: number;
  error?: string;
}

export interface IngestionRunSummary {
  startedAt: string;
  completedAt: string;
  durationSeconds: number;
  dryRun: boolean;
  totalFetched: number;
  totalInserted: number;
  totalUpdated: number;
  totalSkipped: number;
  totalFailed: number;
  totalNewCanonical?: number;
  totalReopened?: number;
  totalRejected?: number;
  totalDuplicate?: number;
  totalUnknown?: number;
  sources: SourceStats[];
  cleanup: {
    markedExpired: number;
    permanentlyDeleted: number;
  };
}
