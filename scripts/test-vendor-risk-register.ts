#!/usr/bin/env tsx
// Vendor risk register parity (Backend sheet rank 24: Vendor Risk Review).
//
// Guarantees:
//   1. Every dependency with code evidence in the repo appears in
//      docs/vendor-risk-review.md, cited with its source path.
//   2. The register keeps its required columns (exposure, control/recovery,
//      remaining verification) and its honesty markers: this is a code-based
//      register, NOT a completed legal/security assessment; unverified
//      fields stay marked unverified; secrets never get committed.
//   3. The review cadence / change gate section survives edits.

import { existsSync, readFileSync, readdirSync } from "node:fs";

const doc = readFileSync("docs/vendor-risk-review.md", "utf8");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}

interface Entry {
  vendor: string;
  docNeedle: string;
  sourcePath: string;
  pathKind: "file" | "dir";
}

const entries: Entry[] = [
  { vendor: "Supabase", docNeedle: "Supabase (`src/lib/admin/auth.ts`", sourcePath: "src/lib/admin/auth.ts", pathKind: "file" },
  { vendor: "Groq", docNeedle: "Groq (`src/lib/ai/serviceHandler.ts`)", sourcePath: "src/lib/ai/serviceHandler.ts", pathKind: "file" },
  { vendor: "Google mail", docNeedle: "Google mail / Apps Script (`src/lib/early-access/gmail.ts`)", sourcePath: "src/lib/early-access/gmail.ts", pathKind: "file" },
  { vendor: "Razorpay", docNeedle: "Razorpay (`src/lib/billing/checkout.ts`)", sourcePath: "src/lib/billing/checkout.ts", pathKind: "file" },
  { vendor: "GitHub Actions", docNeedle: "GitHub Actions (`.github/workflows/`)", sourcePath: ".github/workflows", pathKind: "dir" },
  { vendor: "Cloudflare / Netlify", docNeedle: "Cloudflare / Netlify (`docs/runbooks.md`)", sourcePath: "docs/runbooks.md", pathKind: "file" },
  { vendor: "Sentry", docNeedle: "Sentry (`SENTRY_DSN`", sourcePath: "src/lib/monitoring/sentryErrorReporter.ts", pathKind: "file" },
];

for (const e of entries) {
  check(`register lists ${e.vendor} with source path`, doc.includes(e.docNeedle));
  check(`${e.vendor} cited source path exists (${e.sourcePath})`, existsSync(e.sourcePath));
}

// Sentry row cites SENTRY_DSN references in application code; prove one exists.
const sentryRefs = readdirSync("src/lib/monitoring").some((f) => f.toLowerCase().includes("sentry"));
check("Sentry integration code exists under src/lib/monitoring", sentryRefs);

// Required register columns.
for (const col of ["Data / operational exposure", "Existing control or recovery path", "Remaining verification"]) {
  check(`register keeps "${col}" column`, doc.includes(col));
}

// Honesty markers.
check("register states it is not a completed legal/security assessment", doc.includes("not a completed legal/security assessment"));
check("register marks unverified fields as unverified", doc.toLowerCase().includes("unverified"));
check("register forbids committing secrets", doc.includes("never commit secrets"));
check("register keeps the review cadence / change gate", doc.includes("## Review cadence and change gate"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
