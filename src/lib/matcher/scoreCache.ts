/**
 * Remembers the shared match score each job showed in the feed, so a detail opened later (or after a reload,
 * when that job is not in the loaded page) shows the same number as its card instead of a different fallback.
 *
 * Entries are keyed by job id + job revision; the whole store belongs to one snapshot
 * (scoring version + candidate profile version + saved preferences). Any snapshot change drops every entry together.
 */
import { MATCH_SCORE_VERSION } from "./scoring";

const KEY = "cm_match_scores";
const MAX_ENTRIES = 500;

type Store = { snap: string; scores: Record<string, number> };

/** FNV-1a 32-bit, hex. Enough to detect a changed profile/job; not a security hash. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

type CandidateLike = {
  confirmedAt?: string;
  updatedAt?: string;
  skills?: unknown;
  experience?: unknown;
  education?: unknown;
  certifications?: unknown;
  headline?: unknown;
  summary?: unknown;
  location?: unknown;
};

/** Version of the scoring-relevant candidate profile (CandidateProfile has no id): content hash + timestamps. */
export function candidateProfileVersion(c: CandidateLike): string {
  const { skills, experience, education, certifications, headline, summary, location, updatedAt, confirmedAt } = c;
  return fnv1a(JSON.stringify([skills, experience, education, certifications, headline, summary, location, updatedAt, confirmedAt]));
}

type JobLike = { id: string; postedAt?: string; title?: string; location?: string; category?: string; remote?: boolean; remoteScope?: string };

/**
 * Job revision from fields present in both the feed row and the detail fetch.
 * shortcut: the jobs API exposes no updated_at/revision; if one is added, key on it instead.
 */
export function jobRevisionKey(job: JobLike): string {
  return `${job.id}|${fnv1a(JSON.stringify([job.postedAt ?? "", job.title ?? "", job.location ?? "", job.category ?? "", Boolean(job.remote), job.remoteScope ?? ""]))}`;
}

export function matchScoreSnapshot(candidate: CandidateLike | null | undefined, prefsUpdatedAt?: string | null): string | null {
  if (!candidate?.confirmedAt) return null;
  return [MATCH_SCORE_VERSION, candidateProfileVersion(candidate), prefsUpdatedAt ?? ""].join("|");
}

function read(snap: string): Record<string, number> {
  try {
    const store = JSON.parse(localStorage.getItem(KEY) || "null") as Store | null;
    return store && store.snap === snap && store.scores && typeof store.scores === "object" ? store.scores : {};
  } catch {
    return {};
  }
}

export function rememberMatchScores(snap: string | null, jobs: readonly (JobLike & { matchScore?: number | null })[]): void {
  if (!snap) return;
  const scores = read(snap);
  let changed = false;
  for (const job of jobs) {
    if (typeof job.matchScore !== "number" || Number.isNaN(job.matchScore)) continue;
    const key = jobRevisionKey(job);
    if (scores[key] === job.matchScore) continue;
    delete scores[key]; // re-insert so the newest entries survive the cap
    scores[key] = job.matchScore;
    changed = true;
  }
  if (!changed) return;
  const keys = Object.keys(scores);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete scores[k];
  try {
    localStorage.setItem(KEY, JSON.stringify({ snap, scores } satisfies Store));
  } catch {
    // storage full or blocked: the detail falls back to its computed score
  }
}

export function recallMatchScore(snap: string | null, job: JobLike): number | null {
  if (!snap) return null;
  const score = read(snap)[jobRevisionKey(job)];
  return typeof score === "number" ? score : null;
}
