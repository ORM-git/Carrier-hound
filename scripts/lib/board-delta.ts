/**
 * Incremental / Delta Ingestion Engine (Backend sheet row "Incremental / Delta Ingestion").
 *
 * Implements a per-board delta path:
 * - Persists high-water mark (last successful ingest timestamp) per board.
 * - Filters postings to only process new or updated postings since the high-water mark.
 * - Undated postings are kept (fail-open).
 * - On any error in delta selector, fails open to full fetch.
 * - Preserves existing unique-key dedupe as fallback.
 */

import * as fs from "fs";
import * as path from "path";

export interface BoardWatermarkEntry {
  lastIngestAt: string;
  jobsProcessed?: number;
  ats?: string;
}

export type BoardWatermarks = Record<string, BoardWatermarkEntry>;

export const DEFAULT_WATERMARKS_PATH = path.resolve(process.cwd(), "data", "ingest-watermarks.json");

/** Generate normalized key for board lookup: `<ats>:<token>` */
export function getBoardWatermarkKey(ats: string, token: string): string {
  const safeAts = (ats || "unknown").toLowerCase().trim();
  const safeToken = (token || "").toLowerCase().trim();
  return `${safeAts}:${safeToken}`;
}

/** Load persisted high-water marks from disk (fails open to empty record) */
export function loadBoardWatermarks(filePath: string = DEFAULT_WATERMARKS_PATH): BoardWatermarks {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8").trim();
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as BoardWatermarks;
      }
    }
  } catch (err) {
    console.warn(`[board-delta] Failed to read watermarks from ${filePath} (failing open to full fetch):`, err);
  }
  return {};
}

/** Save updated high-water marks to disk atomically (fails open) */
export function saveBoardWatermarks(watermarks: BoardWatermarks, filePath: string = DEFAULT_WATERMARKS_PATH): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempFile = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempFile, JSON.stringify(watermarks, null, 2), "utf8");
    fs.renameSync(tempFile, filePath);
  } catch (err) {
    console.warn(`[board-delta] Failed to persist watermarks to ${filePath} (fail-open):`, err);
  }
}

/** Get the high-water mark timestamp for a specific board */
export function getBoardWatermark(watermarks: BoardWatermarks, ats: string, token: string): string | null {
  const key = getBoardWatermarkKey(ats, token);
  const entry = watermarks[key];
  if (!entry || !entry.lastIngestAt) return null;
  const time = new Date(entry.lastIngestAt).getTime();
  return isNaN(time) ? null : entry.lastIngestAt;
}

/** Update or set the high-water mark for a board */
export function updateBoardWatermark(
  watermarks: BoardWatermarks,
  ats: string,
  token: string,
  timestamp: string = new Date().toISOString(),
  count?: number
): BoardWatermarks {
  const key = getBoardWatermarkKey(ats, token);
  watermarks[key] = {
    lastIngestAt: timestamp,
    jobsProcessed: count,
    ats,
  };
  return watermarks;
}

export interface DeltaFilterResult<T> {
  deltaJobs: T[];
  isDelta: boolean;
  skippedCount: number;
  error?: string;
}

/**
 * Filter jobs to only postings new or changed since the high-water mark.
 *
 * Rules:
 * - If no watermark exists: returns all jobs (full fetch, isDelta: false).
 * - If watermark exists: keeps jobs where posted_at/updated_at/discovered_at >= watermark.
 * - Undated jobs are always kept (fail-open, never drop postings lacking timestamp).
 * - On any error: fails open to full fetch (returns all jobs, isDelta: false).
 */
export function filterJobsByWatermark<T extends { [key: string]: any }>(
  jobs: T[],
  watermarkIso: string | null
): DeltaFilterResult<T> {
  if (!watermarkIso) {
    return { deltaJobs: jobs, isDelta: false, skippedCount: 0 };
  }

  try {
    const watermarkTime = new Date(watermarkIso).getTime();
    if (isNaN(watermarkTime)) {
      // Invalid watermark format; fail open to full fetch
      return { deltaJobs: jobs, isDelta: false, skippedCount: 0 };
    }

    const deltaJobs: T[] = [];
    let skippedCount = 0;

    for (const job of jobs) {
      if (!job || typeof job !== "object") continue;

      // Extract posting timestamp (check standard fields in order)
      const dateField = job.updated_at || job.posted_at || job.discovered_at || job.created_at;
      if (!dateField) {
        // Undated job: fail open, keep it
        deltaJobs.push(job);
        continue;
      }

      const jobTime = new Date(dateField).getTime();
      if (isNaN(jobTime)) {
        // Unparseable date: fail open, keep it
        deltaJobs.push(job);
        continue;
      }

      if (jobTime >= watermarkTime) {
        // New or updated since watermark
        deltaJobs.push(job);
      } else {
        // Older than watermark
        skippedCount++;
      }
    }

    return {
      deltaJobs,
      isDelta: true,
      skippedCount,
    };
  } catch (err: any) {
    console.warn(`[board-delta] Delta filter failed (failing open to full fetch):`, err?.message || err);
    return {
      deltaJobs: jobs,
      isDelta: false,
      skippedCount: 0,
      error: String(err?.message || err),
    };
  }
}
