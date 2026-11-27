/**
 * Remembers the shared match score each job showed in the feed, so a detail opened later (or after a reload,
 * when that job is not in the loaded page) shows the same number as its card instead of a different fallback.
 *
 * Entries are keyed by job id + the server's score-input revision (scoreInputRevision: every scoring input of
 * the job plus MATCH_SCORE_VERSION). The whole store belongs to one snapshot (scoring version + candidate profile
 * version + saved preferences); any snapshot change drops every entry together. No revision => never cached.
 */
import { MATCH_SCORE_VERSION, fnv1aHex } from "./scoring";
import { withFeedScore } from "@/lib/jobs/recommendations";

const KEY = "cm_match_scores";
const MAX_ENTRIES = 500;

type Store = { snap: string; scores: Record<string, number> };

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
  return fnv1aHex(JSON.stringify([skills, experience, education, certifications, headline, summary, location, updatedAt, confirmedAt]));
}

type JobLike = { id: string; scoreRevision?: string | null };

const entryKey = (job: JobLike) => (job.scoreRevision ? `${job.id}|${job.scoreRevision}` : null);

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
    const key = entryKey(job);
    if (!key || typeof job.matchScore !== "number" || Number.isNaN(job.matchScore) || scores[key] === job.matchScore) continue;
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
  const key = entryKey(job);
  if (!snap || !key) return null;
  const score = read(snap)[key];
  return typeof score === "number" ? score : null;
}

/**
 * When a detail fetch shows a newer score-input revision than the feed row for the same job, the feed's score is
 * stale: replace that row with the fetched job. Keep a finite authoritative detail score when supplied;
 * otherwise drop the old score so every surface falls back from the same data.
 * Returns the same array when nothing is stale.
 */
export function reconcileFeedWithDetail<T extends JobLike & { matchScore?: number | null }>(feed: T[], detail: T): T[] {
  const i = feed.findIndex((j) => j.id === detail.id);
  if (i < 0 || !detail.scoreRevision || feed[i].scoreRevision === detail.scoreRevision) return feed;
  const next = [...feed];
  next[i] = { ...detail, matchScore: typeof detail.matchScore === "number" && Number.isFinite(detail.matchScore) ? detail.matchScore : null };
  return next;
}

/**
 * Detail job for the current entitlement. Paid-only score (owner, 24 Nov): Free, guest or downgraded sessions never get a
 * stale Pro detail score, the feed score or a remembered score. Pro: feed score, else remembered score, else unchanged.
 */
export function detailJobForEntitlement<T extends { id: string; matchScore?: number | null; scoreRevision?: string | null }>(
  selected: T | null,
  feed: readonly { id: string; matchScore?: number | null; scoreRevision?: string | null }[],
  isPro: boolean,
  snap: string | null,
  recall: (snap: string | null, job: T) => number | null = recallMatchScore as any,
): T | null {
  if (!selected) return null;
  if (!isPro) return selected.matchScore == null ? selected : { ...selected, matchScore: null };
  const job = withFeedScore(selected, feed);
  if (typeof job.matchScore === "number") return job;
  const remembered = recall(snap, job);
  return remembered === null ? job : { ...job, matchScore: remembered };
}
