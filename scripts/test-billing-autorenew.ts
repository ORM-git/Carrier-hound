/**
 * scripts/test-billing-autorenew.ts
 *
 * Launch posture for recurring (auto-renew) billing: DISABLED.
 * Every plan is a one-time prepaid order with flat pricing from src/config/plans.ts
 * (Weekly ₹399 / 7 days, Monthly ₹499 / 30 days, Quarterly ₹2,199 / 90 days).
 *
 * 1) NEXT_PUBLIC_AUTORENEW_ENABLED stays registered (strict_true, public-build, default off).
 * 2) netlify.toml still routes /api/billing/razorpay/subscription to the (inert) function.
 * 3) Pricing, Terms and Refund copy is prepaid-only, has no renewal pricing, and reads
 *    prices from the shared plans config.
 * 4) Next route and Netlify function return 410 RECURRING_DISABLED for every flag permutation,
 *    and contain no Razorpay subscription, Supabase or flag logic.
 * 5) Prepaid order route stays isolated from subscription logic.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { getFlagDefinition, isFlagEnabled } from "../src/lib/flags/flags";
import { POST } from "../src/app/api/billing/razorpay/subscription/route";
import { createHandler as createNetlifySubscriptionHandler } from "../netlify/functions/billing-razorpay-subscription";
import { PLAN_PRICING, PREPAID_PRICE_SUMMARY } from "../src/config/plans";

const ROOT = path.resolve(__dirname, "..");
const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

async function runAutorenewTests() {
  console.log("================================================================================");
  console.log("   BILLING RECURRING-PATH DISABLED VERIFICATION SUITE                           ");
  console.log("================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("[NEGATIVE CONTROL MODE] Intentionally asserting invalid condition...");
    const def = getFlagDefinition("NEXT_PUBLIC_AUTORENEW_ENABLED");
    assert.strictEqual(
      (def as any)?.defaultEnabled,
      true,
      "Negative control: defaultEnabled should be false, not true"
    );
    return;
  }

  // TEST 1: Flag registration (kept so stale env values are parsed strictly)
  console.log("[TEST 1] Verifying NEXT_PUBLIC_AUTORENEW_ENABLED in flags registry...");
  const flagDef = getFlagDefinition("NEXT_PUBLIC_AUTORENEW_ENABLED");
  assert.ok(flagDef, "NEXT_PUBLIC_AUTORENEW_ENABLED must be registered in FLAGS");
  assert.strictEqual(flagDef.rule, "strict_true");
  assert.strictEqual(flagDef.scope, "public-build");
  assert.strictEqual(flagDef.defaultEnabled, false);
  assert.strictEqual(isFlagEnabled("NEXT_PUBLIC_AUTORENEW_ENABLED", {}), false);
  console.log("  ✓ Flag registered, default off.\n");

  // TEST 2: netlify.toml redirect still lands on the inert function
  console.log("[TEST 2] Verifying netlify.toml redirect for subscription route...");
  const netlifyToml = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
  assert.ok(netlifyToml.includes('from = "/api/billing/razorpay/subscription"'));
  assert.ok(netlifyToml.includes('to = "/.netlify/functions/billing-razorpay-subscription"'));
  console.log("  ✓ Redirect present.\n");

  // TEST 3: Prepaid-only copy with prices from the shared config
  console.log("[TEST 3] Verifying prepaid-only copy on Pricing, Terms, and Refund pages...");
  assert.strictEqual(PLAN_PRICING.weekly.price_paise, 39900);
  assert.strictEqual(PLAN_PRICING.weekly.duration_days, 7);
  assert.strictEqual(PLAN_PRICING.monthly.price_paise, 49900);
  assert.strictEqual(PLAN_PRICING.monthly.duration_days, 30);
  assert.strictEqual(PLAN_PRICING.quarterly.price_paise, 219900);
  assert.strictEqual(PLAN_PRICING.quarterly.duration_days, 90);
  assert.strictEqual(
    PREPAID_PRICE_SUMMARY,
    "Weekly: ₹399 for 7 days, Monthly: ₹499 for 30 days, Quarterly: ₹2,199 for 90 days"
  );

  const pages: Array<[string, string]> = [
    ["Pricing", "src/app/pricing/page.tsx"],
    ["Terms and Conditions", "src/app/terms-and-conditions/page.tsx"],
    ["Refund Policy", "src/app/refund-policy/page.tsx"],
  ];
  for (const [name, rel] of pages) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(src.includes("{PREPAID_PRICE_SUMMARY}"), `${name} must render prices from PREPAID_PRICE_SUMMARY`);
    assert.ok(/import \{[^}]*PREPAID_PRICE_SUMMARY[^}]*\} from "@\/config\/plans"/.test(src), `${name} must import prices from @/config/plans`);
    assert.ok(!src.includes("NEXT_PUBLIC_AUTORENEW_ENABLED"), `${name} must not branch on the auto-renew flag`);
    assert.ok(!/₹\s?799|\b799\b/.test(src), `${name} must not mention 799`);
    assert.ok(!/first month/i.test(src), `${name} must not mention first-month pricing`);
    assert.ok(!/auto-renew every|renewal amount/i.test(src), `${name} must not contain renewal pricing copy`);
  }

  const pricingFile = fs.readFileSync(path.join(ROOT, "src/app/pricing/page.tsx"), "utf8");
  const termsFile = fs.readFileSync(path.join(ROOT, "src/app/terms-and-conditions/page.tsx"), "utf8");
  const refundFile = fs.readFileSync(path.join(ROOT, "src/app/refund-policy/page.tsx"), "utf8");
  assert.ok(pricingFile.includes("Plans are prepaid for a fixed duration and do not auto-renew."));
  assert.ok(termsFile.includes("No automatic renewal:</strong> plans are prepaid for a fixed period and do not renew automatically."));
  assert.ok(termsFile.includes("Plans do not renew automatically, so there is nothing to cancel."));
  assert.ok(refundFile.includes("1. Prepaid Plans, No Auto-Renewal"));
  assert.ok(refundFile.includes("There are no recurring charges and no automatic renewals: your plan expires at the end of its paid period"));
  console.log("  ✓ Prepaid-only copy, prices from shared config, no renewal or first-month pricing.\n");

  // TEST 4: Recurring routes return 410 for every flag permutation
  console.log("[TEST 4] Verifying subscription routes return 410 RECURRING_DISABLED...");
  const originalEnv = { ...process.env };
  const permutations: Array<Record<string, string | undefined>> = [
    { NEXT_PUBLIC_AUTORENEW_ENABLED: undefined, NEXT_PUBLIC_BILLING_ENABLED: "true" },
    { NEXT_PUBLIC_AUTORENEW_ENABLED: "false", NEXT_PUBLIC_BILLING_ENABLED: "true" },
    { NEXT_PUBLIC_AUTORENEW_ENABLED: "true", NEXT_PUBLIC_BILLING_ENABLED: "true" },
    { NEXT_PUBLIC_AUTORENEW_ENABLED: "true", NEXT_PUBLIC_BILLING_ENABLED: "false" },
  ];
  try {
    for (const flags of permutations) {
      for (const [k, v] of Object.entries(flags)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      const res = await POST(
        new Request("http://localhost:3000/api/billing/razorpay/subscription", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer mock_token" },
          body: JSON.stringify({ planCode: "monthly" }),
        })
      );
      assert.strictEqual(res.status, 410, `Next route must return 410 for ${JSON.stringify(flags)}`);
      assert.strictEqual((await res.json()).code, "RECURRING_DISABLED");

      const netlifyRes = await createNetlifySubscriptionHandler()({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock_token" },
        body: JSON.stringify({ planCode: "monthly" }),
      });
      assert.strictEqual(netlifyRes.statusCode, 410, `Netlify function must return 410 for ${JSON.stringify(flags)}`);
      assert.strictEqual(JSON.parse(netlifyRes.body).code, "RECURRING_DISABLED");
    }
  } finally {
    process.env = { ...originalEnv };
  }

  for (const rel of [
    "src/app/api/billing/razorpay/subscription/route.ts",
    "netlify/functions/billing-razorpay-subscription.ts",
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!code.includes("NEXT_PUBLIC_AUTORENEW_ENABLED"), `${rel} must not read the auto-renew flag`);
    assert.ok(!code.includes("/v1/subscriptions"), `${rel} must not call the Razorpay subscription API`);
    assert.ok(!code.includes("createClient"), `${rel} must not touch Supabase`);
    assert.ok(!/79900|49900|39900|219900/.test(code), `${rel} must not carry plan amounts`);
  }
  console.log("  ✓ Next route and Netlify function are inert and return 410 regardless of flags.\n");

  // TEST 5: Prepaid order route isolation
  console.log("[TEST 5] Verifying prepaid order route stays isolated from subscription logic...");
  const orderRouteModule = await import("../src/app/api/billing/razorpay/order/route");
  assert.ok(typeof orderRouteModule.POST === "function");
  const orderRouteContent = fs.readFileSync(path.join(ROOT, "src/app/api/billing/razorpay/order/route.ts"), "utf-8");
  assert.ok(!orderRouteContent.includes("RAZORPAY_AUTORENEW_PLAN"));
  assert.ok(!orderRouteContent.includes("/v1/subscriptions"));
  console.log("  ✓ Prepaid order route remains isolated.\n");

  console.log("================================================================================");
  console.log("   ALL RECURRING-DISABLED BILLING TESTS PASSED SUCCESSFULLY!                    ");
  console.log("================================================================================\n");
}

runAutorenewTests().catch((err) => {
  console.error("Test failure:", err);
  process.exit(1);
});
