/**
 * Remembers the shared match score each job showed in the feed, so a detail opened later (or after a reload,
 * when that job is not in the loaded page) shows the same number as its card instead of a different fallback.
 * One store per snapshot (scoring version + candidate + saved preferences): any change drops every entry together.
 */
import { MATCH_SCORE_VERSION } from "./scoring";

const KEY = "cm_match_scores";
const MAX_ENTRIES = 500;

type Store = { snap: string; scores: Record<string, number> };

export function matchScoreSnapshot(
  candidate: { id?: string; updatedAt?: string; confirmedAt?: string } | null | undefined,
  prefsUpdatedAt?: string | null
): string | null {
  if (!candidate?.confirmedAt) return null;
  return [MATCH_SCORE_VERSION, candidate.id ?? "", candidate.updatedAt ?? "", candidate.confirmedAt, prefsUpdatedAt ?? ""].join("|");
}

function read(snap: string): Record<string, number> {
  try {
    const store = JSON.parse(localStorage.getItem(KEY) || "null") as Store | null;
    return store && store.snap === snap && store.scores && typeof store.scores === "object" ? store.scores : {};
  } catch {
    return {};
  }
}

export function rememberMatchScores(snap: string | null, jobs: readonly { id: string; matchScore?: number | null }[]): void {
  if (!snap) return;
  const scores = read(snap);
  let changed = false;
  for (const job of jobs) {
    if (typeof job.matchScore !== "number" || Number.isNaN(job.matchScore) || scores[job.id] === job.matchScore) continue;
    delete scores[job.id]; // re-insert so the newest entries survive the cap
    scores[job.id] = job.matchScore;
    changed = true;
  }
  if (!changed) return;
  const ids = Object.keys(scores);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES))) delete scores[id];
  try {
    localStorage.setItem(KEY, JSON.stringify({ snap, scores } satisfies Store));
  } catch {
    // storage full or blocked: the detail falls back to its computed score
  }
}

export function recallMatchScore(snap: string | null, jobId: string): number | null {
  if (!snap) return null;
  const score = read(snap)[jobId];
  return typeof score === "number" ? score : null;
}
