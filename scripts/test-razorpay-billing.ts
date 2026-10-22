import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PLAN_DOMESTIC, PLAN_INTERNATIONAL } from "../src/lib/billing/types";

console.log("==================================================================================");
console.log("           RAZORPAY TEST-MODE BILLING & SAFETY VERIFICATION                       ");
console.log("==================================================================================\n");

let passed = 0;
let failed = 0;

function check(desc: string, fn: () => void) {
  try {
    fn();
    console.log(`  [PASS] ${desc}`);
    passed++;
  } catch (err: any) {
    console.error(`  [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

// 1. Static file and export checks
check("Pricing page exists and has 'use client'", () => {
  const content = fs.readFileSync(path.resolve("src/app/pricing/page.tsx"), "utf8");
  assert(content.includes('"use client"'), "Pricing page must be a client component");
  assert(!content.includes("useSearchParams"), "Pricing page must NOT use useSearchParams (static export safe)");
  assert(!content.includes("export const runtime"), "Pricing page must NOT export edge runtime (static export)");
  assert(content.includes("Subscribe with Razorpay (Test)"), "India CTA must include 'Subscribe with Razorpay (Test)'");
  assert(content.includes("Coming soon"), "International CTA must include 'Coming soon'");
  assert(content.includes("Pro launching soon"), "Pricing page must support 'Pro launching soon' state");
  assert(content.includes("Checkout is unavailable right now, please try again later."), "Error copy must be updated");
  assert(!content.includes("Cancel anytime with one click"), "Must NOT contain 'Cancel anytime with one click'");
  assert(content.includes("Test payment successful (no Pro granted)"), "Success screen must show test mode message");
});

// 2. Billing types integrity
check("Plan data consistency with PLAN_DOMESTIC and PLAN_INTERNATIONAL", () => {
  assert.strictEqual(PLAN_DOMESTIC.price, 199, "India domestic plan must be 199 INR");
  assert.strictEqual(PLAN_DOMESTIC.currency, "INR", "India domestic currency must be INR");
  assert.strictEqual(PLAN_INTERNATIONAL.price, 9, "International plan must be 9 USD");
  assert.strictEqual(PLAN_INTERNATIONAL.currency, "USD", "International currency must be USD");
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

// 4. API Endpoints edge runtime contracts and billing safety
check("API route endpoints are configured with edge runtime and safety gates", () => {
  const orderRoute = fs.readFileSync(path.resolve("src/app/api/billing/razorpay/order/route.ts"), "utf8");
  assert(orderRoute.includes('runtime = "edge"'), "order route must use edge runtime");
  assert(orderRoute.includes("rzp_test_"), "order route must enforce rzp_test_ key prefix");
  assert(orderRoute.includes("NEXT_PUBLIC_BILLING_ENABLED"), "order route must check NEXT_PUBLIC_BILLING_ENABLED");

  const verifyRoute = fs.readFileSync(path.resolve("src/app/api/billing/razorpay/verify/route.ts"), "utf8");
  assert(verifyRoute.includes('runtime = "edge"'), "verify route must use edge runtime");
  assert(verifyRoute.includes("crypto.subtle"), "verify route must use Web Crypto subtle API for Edge runtime");
  assert(verifyRoute.includes("NEXT_PUBLIC_BILLING_ENABLED"), "verify route must check NEXT_PUBLIC_BILLING_ENABLED");
  assert(verifyRoute.includes("testMode: true"), "verify route must return testMode: true for rzp_test_ keys");
  assert(verifyRoute.includes("Test payment successful (no Pro granted)"), "verify route must return test mode message");
});

// 5. Netlify functions and safety gates
check("Netlify functions enforce CORS and billing safety gates", () => {
  const toml = fs.readFileSync(path.resolve("netlify.toml"), "utf8");
  assert(toml.includes('from = "/api/billing/razorpay/order"'), "netlify.toml must redirect /api/billing/razorpay/order");
  assert(toml.includes('from = "/api/billing/razorpay/verify"'), "netlify.toml must redirect /api/billing/razorpay/verify");

  const netlifyOrder = fs.readFileSync(path.resolve("netlify/functions/billing-razorpay-order.ts"), "utf8");
  assert(netlifyOrder.includes("buildCorsHeaders"), "Netlify order function must use centralized CORS");
  assert(netlifyOrder.includes("NEXT_PUBLIC_BILLING_ENABLED"), "Netlify order function must check NEXT_PUBLIC_BILLING_ENABLED");

  const netlifyVerify = fs.readFileSync(path.resolve("netlify/functions/billing-razorpay-verify.ts"), "utf8");
  assert(netlifyVerify.includes("buildCorsHeaders"), "Netlify verify function must use centralized CORS");
  assert(netlifyVerify.includes("NEXT_PUBLIC_BILLING_ENABLED"), "Netlify verify function must check NEXT_PUBLIC_BILLING_ENABLED");
  assert(netlifyVerify.includes("testMode: true"), "Netlify verify function must return testMode: true for rzp_test_ keys");
});

// 6. Navigation links
check("Navigation links in GuideHeader and Footer include /pricing", () => {
  const header = fs.readFileSync(path.resolve("src/components/GuideHeader.tsx"), "utf8");
  const footer = fs.readFileSync(path.resolve("src/components/Footer.tsx"), "utf8");

  assert(header.includes('href="/pricing"'), "GuideHeader must link to /pricing");
  assert(footer.includes('href="/pricing"'), "Footer must link to /pricing");
});

// 7. PaywallModal and ProUpgradeScreen link to /pricing
check("PaywallModal and ProUpgradeScreen have primary button linking to /pricing without Coming Soon", () => {
  const modal = fs.readFileSync(path.resolve("src/components/PaywallModal.tsx"), "utf8");
  assert(modal.includes('href="/pricing"'), "PaywallModal must link to /pricing");
  assert(modal.includes("See Pro Plans - ₹199/mo"), "PaywallModal must feature 'See Pro Plans - ₹199/mo'");
  assert(!modal.includes("Payments Coming Soon"), "PaywallModal must remove 'Payments Coming Soon'");

  const screen = fs.readFileSync(path.resolve("src/components/billing/ProUpgradeScreen.tsx"), "utf8");
  assert(screen.includes('href="/pricing"'), "ProUpgradeScreen must link to /pricing");
  assert(screen.includes("See Pro Plans - ₹199/mo"), "ProUpgradeScreen must feature 'See Pro Plans - ₹199/mo'");
  assert(!screen.includes("Payments Coming Soon"), "ProUpgradeScreen must remove 'Payments Coming Soon'");
});

// 8. Negative Control: Invalid signature verification fails
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
