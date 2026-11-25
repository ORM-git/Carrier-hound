/**
 * Offline ranking-quality evaluation (checklist #62). Runs the production recommendation ranker on a labelled
 * fixture dataset and writes machine-readable results plus a short report. No database, network or writes
 * outside --out.
 *
 * Run: npx tsx scripts/eval-ranking.ts [--dataset scripts/eval/ranking/synthetic-v1.json] [--split eval] [--out out/ranking-eval]
 * Format and metric conventions: docs/ranking-eval.md
 */
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { evaluateDataset, type EvalDataset, type EvalResult, type Split } from "../src/lib/eval/rankingEval";
import { MATCH_SCORE_VERSION } from "../src/lib/matcher/scoring";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sha256 = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex");

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(4));

function report(r: EvalResult, meta: Record<string, string>): string {
  const lines = [
    `# Ranking evaluation: ${r.dataset.version} (${r.split} split)`,
    "",
    r.dataset.synthetic
      ? "**SYNTHETIC dataset.** Labels were written by the harness author. These numbers show the harness works; they say nothing about real recommendation quality. Real-world quality is not yet measured (no human-judged dataset exists)."
      : "Human-judged dataset. Metrics cover the judged candidate pool only, not the full job corpus.",
    "",
    `- Dataset sha256: \`${meta.datasetSha256}\``,
    `- Scorer: git \`${meta.gitHead}\`, recommendations.ts sha256 \`${meta.scorerSha256}\`, MATCH_SCORE_VERSION ${meta.matchScoreVersion}`,
    `- Reference time: ${r.dataset.referenceTime}`,
    `- Profiles evaluated: ${r.counts.profiles} (other split skipped: ${r.counts.skippedOtherSplit}); unique candidate jobs: ${r.counts.uniqueCandidateJobs}`,
    `- Label coverage: relevance ${r.labelCoverage.relevanceJudged}/${r.labelCoverage.pairs} profile-job pairs, eligibility ${r.labelCoverage.eligibilityJudged}/${r.labelCoverage.pairs}`,
    `- Conventions: K=${r.conventions.k}; relevant = grade >= ${r.conventions.relevantMinGrade}; gain ${r.conventions.gain}; discount ${r.conventions.discount}; unjudged ${r.conventions.unjudged}`,
    "",
    "| profile | returned | NDCG@10 | P@10 (relevant/judged) | eligible recall (returned/labelled) | hard-filter violations (top10/all) | unjudged in top10 | ties in top10 |",
    "|---|---|---|---|---|---|---|---|",
    ...r.profiles.map((p) => {
      const m = p.metrics;
      return `| ${p.id} | ${m.returned} | ${fmt(m.ndcgAtK)} | ${fmt(m.precisionAtK)} (${m.relevantInCondensedTopK}/${m.precisionDenominator}) | ${fmt(m.eligibleRecall)} (${m.eligibleReturned}/${m.eligibleDenominator}) | ${m.hardFilterViolationsInTopK.length}/${m.hardFilterViolations.length} | ${m.unjudgedInTopK} | ${m.tiedAdjacentPairsInTopK} |`;
    }),
    "",
    `**Macro (mean over profiles where defined):** NDCG@10 ${fmt(r.macro.ndcgAtK.mean)} (${r.macro.ndcgAtK.included} included, ${r.macro.ndcgAtK.excluded} undefined); P@10 ${fmt(r.macro.precisionAtK.mean)} (${r.macro.precisionAtK.included}/${r.macro.precisionAtK.excluded}); eligible recall ${fmt(r.macro.eligibleRecall.mean)} (${r.macro.eligibleRecall.included}/${r.macro.eligibleRecall.excluded}).`,
    `**Totals:** hard-filter violations ${r.totals.hardFilterViolationsInTopK} in top 10, ${r.totals.hardFilterViolations} anywhere; duplicate ids ${r.totals.duplicateIds}; unjudged results in top 10 ${r.totals.unjudgedInTopK}.`,
    "",
    "Undefined metrics:",
    ...r.profiles.flatMap((p) => p.metrics.undefinedReasons.map((why) => `- ${p.id}: ${why}`)),
  ];
  return lines.join("\n") + "\n";
}

function main() {
  const datasetPath = arg("dataset", "scripts/eval/ranking/synthetic-v1.json");
  const split = arg("split", "eval") as Split;
  if (split !== "eval" && split !== "tuning") throw new Error(`--split must be eval or tuning, got ${split}`);
  const outDir = arg("out", "out/ranking-eval");
  const raw = readFileSync(datasetPath);
  const dataset = JSON.parse(raw.toString("utf8")) as EvalDataset;
  const result = evaluateDataset(dataset, split);
  const meta = {
    datasetPath: datasetPath.replace(/\\/g, "/"),
    datasetSha256: sha256(raw),
    gitHead: gitHead(),
    scorerSha256: sha256(readFileSync(join(__dirname, "../src/lib/jobs/recommendations.ts"))),
    matchScoreVersion: String(MATCH_SCORE_VERSION),
  };
  mkdirSync(outDir, { recursive: true });
  const base = `ranking-eval-${dataset.version}-${split}`;
  writeFileSync(join(outDir, `${base}.json`), JSON.stringify({ meta, ...result }, null, 2) + "\n");
  const md = report(result, meta);
  writeFileSync(join(outDir, `${base}.md`), md);
  process.stdout.write(md);
  process.stdout.write(`\nWrote ${join(outDir, base)}.json and .md\n`);
}

main();
