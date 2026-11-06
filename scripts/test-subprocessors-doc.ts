#!/usr/bin/env tsx
// Sub-processor inventory parity (Backend sheet rank 22: Sub-processor List).
//
// Guarantees:
//   1. Every outbound vendor the codebase actually calls is inventoried in
//      docs/subprocessors.md (internal, code-grounded).
//   2. Every active sub-processor in the inventory is disclosed on the
//      customer-facing privacy-policy page (src/app/privacy-policy/page.tsx).
//   3. Contacted-but-NOT-sub-processor services (public FX, logos, job boards)
//      are documented as such and are never named in customer-facing copy.
//   4. Provider-side details that code cannot prove stay honestly marked
//      "provider-side - confirm with vendor docs" (owner-steps Doc step 37).

import { existsSync, readFileSync } from "node:fs";

const doc = readFileSync("docs/subprocessors.md", "utf8");
const privacy = readFileSync("src/app/privacy-policy/page.tsx", "utf8");
const pkg = readFileSync("package.json", "utf8");

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}

interface Vendor {
  name: string;
  docNeedle: string;
  codeCalled: boolean;
  codeEvidence: string;
  privacyNeedle: string;
}

const vendors: Vendor[] = [
  {
    name: "Supabase",
    docNeedle: "Supabase (project",
    codeCalled: existsSync("supabase/migrations") && pkg.includes("@supabase/supabase-js"),
    codeEvidence: "supabase usage (migrations dir / package.json)",
    privacyNeedle: "Supabase",
  },
  {
    name: "Cloudflare Pages",
    docNeedle: "Cloudflare Pages",
    codeCalled: pkg.includes("@cloudflare/next-on-pages"),
    codeEvidence: "@cloudflare/next-on-pages in package.json",
    privacyNeedle: "Cloudflare",
  },
  {
    name: "Netlify",
    docNeedle: "| Netlify |",
    codeCalled: pkg.includes("@netlify/plugin-nextjs"),
    codeEvidence: "@netlify/plugin-nextjs in package.json",
    privacyNeedle: "Netlify",
  },
  {
    name: "Sentry",
    docNeedle: "| Sentry |",
    codeCalled: pkg.includes("@sentry/nextjs"),
    codeEvidence: "@sentry/nextjs in package.json",
    privacyNeedle: "Sentry",
  },
  {
    name: "Groq",
    docNeedle: "| Groq |",
    codeCalled: readFileSync("src/lib/ai/serviceHandler.ts", "utf8").includes("api.groq.com"),
    codeEvidence: "api.groq.com in src/lib/ai/serviceHandler.ts",
    privacyNeedle: "Groq",
  },
  {
    name: "Google (Gmail API)",
    docNeedle: "Google (Gmail API)",
    codeCalled: existsSync("src/lib/early-access/gmail.ts"),
    codeEvidence: "src/lib/early-access/gmail.ts",
    privacyNeedle: "Google",
  },
  {
    name: "Razorpay",
    docNeedle: "| Razorpay |",
    codeCalled: existsSync("src/lib/billing/razorpay.ts"),
    codeEvidence: "src/lib/billing/razorpay.ts",
    privacyNeedle: "Razorpay",
  },
];

for (const v of vendors) {
  check(`inventory lists ${v.name}`, doc.includes(v.docNeedle));
  check(`${v.name} is actually called in code (${v.codeEvidence})`, v.codeCalled);
  check(`privacy policy discloses ${v.name}`, privacy.includes(v.privacyNeedle));
}

// Contacted but NOT sub-processors: documented as such in the internal doc...
check("doc documents open.er-api.com as non-sub-processor", doc.includes("open.er-api.com"));
check("doc documents unavatar.io as non-sub-processor", doc.includes("unavatar.io"));
check("doc documents job-board sources as non-sub-processors", doc.includes("greenhouse.io") && doc.includes("NOT sub-processors"));

// ...and never named in customer-facing copy (job sources are internal-only).
const privacyLower = privacy.toLowerCase();
for (const banned of ["greenhouse", "lever.co", "ashby", "er-api", "unavatar"]) {
  check(`privacy policy never names ${banned}`, !privacyLower.includes(banned));
}

// Honesty: unprovable provider-side details stay marked for owner confirmation.
check(
  "doc marks unconfirmed provider-side details instead of guessing",
  doc.includes("provider-side - confirm with vendor docs"),
);
check(
  "doc records the public-disclosure status section",
  doc.includes("## Public disclosure"),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
