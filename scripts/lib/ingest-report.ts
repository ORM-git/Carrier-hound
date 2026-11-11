/**
 * scripts/lib/ingest-report.ts
 *
 * Generates per-source and per-board aggregate summary reports for ingestion runs.
 * Outputs machine-readable JSON, Markdown tables, and writes to GITHUB_STEP_SUMMARY.
 * Strictly aggregate data only - zero candidate, personal, or raw job listings.
 */

import fs from "fs";
import path from "path";
import { IngestionRunSummary, SourceStats } from "../types";

export interface AggregateTotals {
  fetched: number;
  new_canonical: number;
  updated: number;
  reopened: number;
  rejected: number;
  duplicate: number;
  failed: number;
}

export function computeSummaryTotals(summary: IngestionRunSummary): AggregateTotals {
  let fetched = 0;
  let new_canonical = 0;
  let updated = 0;
  let reopened = 0;
  let rejected = 0;
  let duplicate = 0;
  let failed = 0;

  for (const s of summary.sources) {
    fetched += s.fetched || 0;
    new_canonical += s.new_canonical ?? s.inserted ?? 0;
    updated += s.updated || 0;
    reopened += s.reopened || 0;
    rejected += s.rejected || 0;
    duplicate += s.duplicate || 0;
    failed += s.failed || 0;
  }

  return {
    fetched: summary.totalFetched || fetched,
    new_canonical,
    updated: summary.totalUpdated || updated,
    reopened,
    rejected,
    duplicate,
    failed: summary.totalFailed || failed,
  };
}

export function generateIngestReportJson(summary: IngestionRunSummary): string {
  const totals = computeSummaryTotals(summary);
  const report = {
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    durationSeconds: summary.durationSeconds,
    dryRun: summary.dryRun,
    sourcesCount: summary.sources.length,
    totals,
    sources: summary.sources.map((s) => ({
      sourceId: s.sourceId,
      board: s.board || s.sourceId,
      sourceName: s.sourceName,
      type: s.type,
      fetched: s.fetched || 0,
      new_canonical: s.new_canonical ?? s.inserted ?? 0,
      updated: s.updated || 0,
      reopened: s.reopened || 0,
      rejected: s.rejected || 0,
      duplicate: s.duplicate || 0,
      failed: s.failed || 0,
      error: s.error,
    })),
  };

  return JSON.stringify(report, null, 2);
}

export function generateIngestReportMarkdown(summary: IngestionRunSummary): string {
  const totals = computeSummaryTotals(summary);
  const modeLabel = summary.dryRun ? "DRY RUN (No DB Writes)" : "LIVE PRODUCTION";

  const lines: string[] = [
    `## 📊 CareerMonke Scheduled Ingest Report`,
    ``,
    `- **Run Mode**: ${modeLabel}`,
    `- **Started**: \`${summary.startedAt}\``,
    `- **Completed**: \`${summary.completedAt || new Date().toISOString()}\``,
    `- **Duration**: ${summary.durationSeconds}s`,
    `- **Sources Processed**: ${summary.sources.length}`,
    ``,
    `### Aggregate Supply Totals`,
    `| Metric | Count |`,
    `| --- | ---: |`,
    `| **Total Fetched** | ${totals.fetched} |`,
    `| **New Canonical (Never Seen)** | ${totals.new_canonical} |`,
    `| **Updated (Active Rows)** | ${totals.updated} |`,
    `| **Reopened (Expired -> Active)** | ${totals.reopened} |`,
    `| **Rejected (Invalid / Filtered)** | ${totals.rejected} |`,
    `| **Duplicates (Intra-run / Cross-Source)** | ${totals.duplicate} |`,
    `| **Errors / Failures** | ${totals.failed} |`,
    ``,
    `### Per-Source / Per-Board Breakdown`,
    `| Board / Target | Source Name | Type | Fetched | New Canonical | Updated | Reopened | Rejected | Duplicate | Failed |`,
    `| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
  ];

  for (const s of summary.sources) {
    const board = s.board || s.sourceId;
    const newCount = s.new_canonical ?? s.inserted ?? 0;
    const reopenedCount = s.reopened || 0;
    const rejectedCount = s.rejected || 0;
    const dupCount = s.duplicate || 0;
    lines.push(
      `| \`${board}\` | ${s.sourceName} | ${s.type} | ${s.fetched} | ${newCount} | ${s.updated} | ${reopenedCount} | ${rejectedCount} | ${dupCount} | ${s.failed} |`
    );
  }

  lines.push(``);
  lines.push(`*Aggregate metrics generated automatically by CareerMonke ingestion measurement pipeline.*`);
  return lines.join("\n");
}

export function writeIngestReports(
  summary: IngestionRunSummary,
  reportsDir: string = "reports"
): { jsonPath: string; mdPath: string; stepSummaryWritten: boolean } {
  const resolvedDir = path.isAbsolute(reportsDir) ? reportsDir : path.resolve(process.cwd(), reportsDir);
  if (!fs.existsSync(resolvedDir)) {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  const jsonContent = generateIngestReportJson(summary);
  const mdContent = generateIngestReportMarkdown(summary);

  const jsonPath = path.join(resolvedDir, "ingest-report.json");
  const mdPath = path.join(resolvedDir, "ingest-report.md");

  fs.writeFileSync(jsonPath, jsonContent, "utf8");
  fs.writeFileSync(mdPath, mdContent, "utf8");

  let stepSummaryWritten = false;
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    try {
      fs.appendFileSync(summaryFile, `\n\n${mdContent}\n`, "utf8");
      stepSummaryWritten = true;
    } catch (err) {
      console.warn(`[Ingest Report] Warning: Could not write to GITHUB_STEP_SUMMARY:`, err);
    }
  }

  return { jsonPath, mdPath, stepSummaryWritten };
}
