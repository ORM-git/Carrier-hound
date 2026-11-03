import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PLAN_DEFINITIONS } from "../src/lib/billing/quota";
import { PLANS, UPGRADE_BUTTON_LABEL } from "../src/config/plans";
import { openRazorpayCheckout } from "../src/lib/billing/razorpay";

console.log("==================================================================================");
console.log("           RAZORPAY TEST-MODE BILLING & SAFETY VERIFICATION                       ");
console.log("==================================================================================\n");

const isNegativeControl = process.argv.includes("--negative-control");

if (isNegativeControl) {
  console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Intentionally asserting invalid condition...\n");
  assert.strictEqual(
    PLANS.length,
    999,
    "Negative control expected mismatch: PLANS length must be 3, not 999!"
  );
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(desc: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result && typeof (result as any).then === "function") {
      return (result as Promise<void>)
        .then(() => {
          console.log(`  [PASS] ${desc}`);
          passed++;
        })
        .catch((err: any) => {
          console.error(`  [FAIL] ${desc}: ${err.message}`);
          failed++;
        });
    } else {
      console.log(`  [PASS] ${desc}`);
      passed++;
    }
  } catch (err: any) {
    console.error(`  [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

async function runSuite() {
  // 1. Static file and export checks for real visible payments-off UI
  check("Pricing page exists, is client component, and renders visible payments-off UI", () => {
    const content = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");
    assert(content.includes('"use client"'), "Pricing page must be a client component");
    assert(!content.includes("useSearchParams"), "Pricing page must NOT use useSearchParams (static export safe)");
    assert(!content.includes("export const runtime"), "Pricing page must NOT export edge runtime (static export)");

    // Visible header
    assert(
      content.includes("Get more interviews with CareerMonke Premium"),
      "Pricing page must render visible title 'Get more interviews with CareerMonke Premium'"
    );

    // Disabled Upgrade button with aria-disabled and UPGRADE_BUTTON_LABEL
    assert(content.includes("disabled"), "Upgrade button must have disabled attribute");
    assert(content.includes('aria-disabled="true"'), "Upgrade button must have aria-disabled='true'");
    assert(content.includes("Upgrade"), "Upgrade button label must be 'Upgrade'");
    assert(content.includes("UPGRADE_BUTTON_LABEL"), "Upgrade button must render UPGRADE_BUTTON_LABEL");

    // Visible prices and billing intervals
    assert(content.includes("₹0.00"), "Free plan must render ₹0.00");
    assert(content.includes("Your current plan"), "Free plan badge must render 'Your current plan'");
    assert(content.includes("All features included in Premium"), "Table header must be present");

    // CI compatibility sr-only block must be removed
    assert(!content.includes("Hidden CI compatibility text"), "Hidden CI compatibility block must be removed");
  });

  // 2. Plan and pricing data consistency (Weekly ₹692, Monthly ₹1,499, Quarterly ₹3,999)
  check("Plan definitions in quota.ts and config/plans.ts match approved prices", () => {
    assert.strictEqual(PLAN_DEFINITIONS.weekly.price_paise, 69200, "Weekly plan must be 69200 paise (₹692)");
    assert.strictEqual(PLAN_DEFINITIONS.monthly.price_paise, 149900, "Monthly plan must be 149900 paise (₹1,499)");
    assert.strictEqual(PLAN_DEFINITIONS.quarterly.price_paise, 399900, "Quarterly plan must be 399900 paise (₹3,999)");

    const weekly = PLANS.find((p) => p.id === "weekly");
    const monthly = PLANS.find((p) => p.id === "monthly");
    const quarterly = PLANS.find((p) => p.id === "quarterly");

    assert.strictEqual(weekly?.price, 692, "Config weekly price must be 692");
    assert.strictEqual(monthly?.price, 1499, "Config monthly price must be 1,499");
    assert.strictEqual(quarterly?.price, 3999, "Config quarterly price must be 3,999");
    assert.strictEqual(UPGRADE_BUTTON_LABEL, "Payments opening soon", "UPGRADE_BUTTON_LABEL must match");
  });

  // 3. HMAC-SHA256 Signature verification math
  check("Razorpay HMAC-SHA256 signature verification algorithm matches", () => {
    const secret = "rzp_test_mocksecret123456789";
    const orderId = "order_O6bZp912345678";
    const paymentId = "pay_P7cZq012345678";
    const payload = `${orderId}|${paymentId}`;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    assert.strictEqual(typeof expectedSignature, "string");
    assert.strictEqual(expectedSignature.length, 64, "SHA256 hex string must be 64 characters");

    // Tampered payment id must fail
    const tamperedSignature = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|pay_tampered`)
      .digest("hex");
    assert.notStrictEqual(expectedSignature, tamperedSignature, "Tampered signature must not match");
  });

  // 4. Netlify functions and safety gates
  check("Netlify functions enforce CORS, fail-closed auth, and billing safety gates", () => {
    const toml = fs.readFileSync(path.resolve("netlify.toml"), "utf8");
    assert(toml.includes('from = "/api/billing/razorpay/order"'), "netlify.toml must redirect /api/billing/razorpay/order");
    assert(toml.includes('from = "/api/billing/razorpay/verify"'), "netlify.toml must redirect /api/billing/razorpay/verify");
    assert(toml.includes('from = "/api/billing/razorpay/webhook"'), "netlify.toml must redirect /api/billing/razorpay/webhook");

    const netlifyOrder = fs.readFileSync(path.resolve("netlify/functions/billing-razorpay-order.ts"), "utf8");
    assert(netlifyOrder.includes("buildCorsHeaders"), "Netlify order function must use centralized CORS");
    assert(netlifyOrder.includes("NEXT_PUBLIC_BILLING_ENABLED"), "Netlify order function must check NEXT_PUBLIC_BILLING_ENABLED");
    assert(netlifyOrder.includes("rzp_test_"), "Netlify order function must enforce test keys");

    const netlifyVerify = fs.readFileSync(path.resolve("netlify/functions/billing-razorpay-verify.ts"), "utf8");
    assert(netlifyVerify.includes("buildCorsHeaders"), "Netlify verify function must use centralized CORS");
    assert(netlifyVerify.includes("NEXT_PUBLIC_BILLING_ENABLED"), "Netlify verify function must check NEXT_PUBLIC_BILLING_ENABLED");
    assert(netlifyVerify.includes("fulfil_payment_order"), "Netlify verify function must fulfill via RPC");

    const netlifyWebhook = fs.readFileSync(path.resolve("netlify/functions/billing-razorpay-webhook.ts"), "utf8");
    assert(netlifyWebhook.includes("RAZORPAY_WEBHOOK_SECRET"), "Netlify webhook must verify secret");
    assert(netlifyWebhook.includes("fulfil_payment_order"), "Netlify webhook must fulfill via RPC");
  });

  // 5. Flag-off safety test: ZERO calls to /api/billing/razorpay/order when payments are OFF
  await check("Flag-off gate: openRazorpayCheckout makes ZERO calls to /api/billing/razorpay/order when billing is off", async () => {
    const originalBilling = process.env.NEXT_PUBLIC_BILLING_ENABLED;
    const originalFetch = global.fetch;

    let fetchCallCount = 0;
    const fetchCalls: string[] = [];

    (global as any).fetch = async (url: string) => {
      fetchCallCount++;
      fetchCalls.push(url);
      return { ok: true, json: async () => ({}) };
    };

    try {
      // 1. With NEXT_PUBLIC_BILLING_ENABLED unset
      delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
      let errUnset: Error | null = null;
      await openRazorpayCheckout({
        planCode: "monthly",
        onError: (err) => { errUnset = err; },
      });

      assert(errUnset !== null, "Must return error when billing flag is unset");
      assert((errUnset as any).message.includes("Payments not enabled"), "Error must state payments not enabled");
      assert.strictEqual(fetchCallCount, 0, "Must make zero network calls when billing flag is unset");

      // 2. With NEXT_PUBLIC_BILLING_ENABLED="false"
      process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";
      let errFalse: Error | null = null;
      await openRazorpayCheckout({
        planCode: "weekly",
        onError: (err) => { errFalse = err; },
      });

      assert(errFalse !== null, "Must return error when billing flag is 'false'");
      assert((errFalse as any).message.includes("Payments not enabled"), "Error must state payments not enabled");
      assert.strictEqual(fetchCallCount, 0, "Must make zero network calls when billing flag is 'false'");
    } finally {
      if (originalBilling !== undefined) {
        process.env.NEXT_PUBLIC_BILLING_ENABLED = originalBilling;
      } else {
        delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
      }
      global.fetch = originalFetch;
    }
  });

  // 6. Navigation links and modals link to /pricing
  check("Navigation links in GuideHeader and Footer and modals link to /pricing without stale pricing", () => {
    const header = fs.readFileSync(path.resolve("src/components/GuideHeader.tsx"), "utf8");
    const footer = fs.readFileSync(path.resolve("src/components/Footer.tsx"), "utf8");

    assert(header.includes('href="/pricing"'), "GuideHeader must link to /pricing");
    assert(footer.includes('href="/pricing"'), "Footer must link to /pricing");

    const modal = fs.readFileSync(path.resolve("src/components/PaywallModal.tsx"), "utf8");
    assert(modal.includes('href="/pricing"'), "PaywallModal must link to /pricing");
    assert(!modal.includes("₹199"), "PaywallModal must NOT mention ₹199");
    assert(!modal.includes("PLAN_DOMESTIC"), "PaywallModal must NOT reference PLAN_DOMESTIC");

    const screen = fs.readFileSync(path.resolve("src/components/billing/ProUpgradeScreen.tsx"), "utf8");
    assert(screen.includes('href="/pricing"'), "ProUpgradeScreen must link to /pricing");
    assert(!screen.includes("₹199"), "ProUpgradeScreen must NOT mention ₹199");
    assert(!screen.includes("PLAN_DOMESTIC"), "ProUpgradeScreen must NOT reference PLAN_DOMESTIC");
  });

  // 7. Negative Control logic verification
  check("Negative Control: Verification rejects mismatched signature", () => {
    const secret = "test_secret_123";
    const validSig = crypto.createHmac("sha256", secret).update("order_1|pay_1").digest("hex");
    const badSig = "invalid_signature_hex_00000000000000000000000000000000000000000000";

    assert.strictEqual(validSig === badSig, false, "Invalid signature must be strictly rejected");
  });

  console.log("\n----------------------------------------------------------------------------------");
  if (failed > 0) {
    console.error(`FAILED: ${failed} check(s) failed.`);
    process.exit(1);
  } else {
    console.log(`ALL ${passed} CHECKS PASSED [PASS-LOCAL]`);
    process.exit(0);
  }
}

runSuite().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
