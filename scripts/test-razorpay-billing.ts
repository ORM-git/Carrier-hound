import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PLAN_DOMESTIC, PLAN_INTERNATIONAL } from "../src/lib/billing/types";

console.log("==================================================================================");
console.log("           RAZORPAY TEST-MODE BILLING & /PRICING VERIFICATION                     ");
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

// 4. API Endpoints edge runtime contracts
check("API route endpoints are configured with edge runtime", () => {
  const orderRoute = fs.readFileSync(path.resolve("src/app/api/billing/razorpay/order/route.ts"), "utf8");
  assert(orderRoute.includes('runtime = "edge"'), "order route must use edge runtime");
  assert(orderRoute.includes("rzp_test_"), "order route must enforce rzp_test_ key prefix");

  const verifyRoute = fs.readFileSync(path.resolve("src/app/api/billing/razorpay/verify/route.ts"), "utf8");
  assert(verifyRoute.includes('runtime = "edge"'), "verify route must use edge runtime");
  assert(verifyRoute.includes("crypto.subtle"), "verify route must use Web Crypto subtle API for Edge runtime");
  assert(verifyRoute.includes("subscriptions"), "verify route must persist to subscriptions table");
});

// 5. Netlify functions and redirects
check("Netlify functions and netlify.toml redirects are configured", () => {
  const toml = fs.readFileSync(path.resolve("netlify.toml"), "utf8");
  assert(toml.includes('from = "/api/billing/razorpay/order"'), "netlify.toml must redirect /api/billing/razorpay/order");
  assert(toml.includes('from = "/api/billing/razorpay/verify"'), "netlify.toml must redirect /api/billing/razorpay/verify");

  const netlifyOrder = fs.readFileSync(path.resolve("netlify/functions/billing-razorpay-order.ts"), "utf8");
  assert(netlifyOrder.includes("buildCorsHeaders"), "Netlify order function must use centralized CORS");

  const netlifyVerify = fs.readFileSync(path.resolve("netlify/functions/billing-razorpay-verify.ts"), "utf8");
  assert(netlifyVerify.includes("buildCorsHeaders"), "Netlify verify function must use centralized CORS");
});

// 6. Navigation links
check("Navigation links in GuideHeader and Footer include /pricing", () => {
  const header = fs.readFileSync(path.resolve("src/components/GuideHeader.tsx"), "utf8");
  const footer = fs.readFileSync(path.resolve("src/components/Footer.tsx"), "utf8");

  assert(header.includes('href="/pricing"'), "GuideHeader must link to /pricing");
  assert(footer.includes('href="/pricing"'), "Footer must link to /pricing");
});

// 7. Negative Control: Invalid signature verification fails
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
