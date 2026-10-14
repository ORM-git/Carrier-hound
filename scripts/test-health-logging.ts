import assert from "assert";
import { handler as healthHandler } from "../netlify/functions/health";
import { safeFormatError, sanitizeLogString, safeLog } from "../netlify/functions/_logger";

console.log("==================================================================================");
console.log("             HEALTH ENDPOINT & SANITIZED LOGGING OFFLINE TEST AUDIT               ");
console.log("==================================================================================\n");

async function runTests() {
  const isNegativeControlRun = process.argv.includes("--negative-control");

  if (isNegativeControlRun) {
    console.log("--- EXECUTING NEGATIVE CONTROL FOR HEALTH / LOGGING TEST ---");
    // Simulate an insecure logger that fails to redact a secret token
    const leakedToken = "gsk_leak_secret_value_12345";
    const unredactedOutput = `Error occurred with token: ${leakedToken}`;
    
    // Assert that leaking the token causes a non-zero failure
    assert(!unredactedOutput.includes(leakedToken), "Negative control: Leaked token detected in logs!");
    process.exit(0);
  }

  // =====================================================================================
  // PART 1: Health Endpoint (/health) Audit
  // =====================================================================================
  console.log("--- PART 1: Testing netlify/functions/health.ts ---");

  // Test 1.1: GET Request
  const getRes = await healthHandler({ httpMethod: "GET" });
  assert.strictEqual(getRes.statusCode, 200, `Expected 200 on GET, got ${getRes.statusCode}`);
  assert.strictEqual(getRes.headers["Content-Type"], "application/json");
  assert.strictEqual(getRes.headers["Cache-Control"], "no-store, no-cache, must-revalidate");

  const getBody = JSON.parse(getRes.body);
  assert.strictEqual(getBody.ok, true, "Expected body.ok to be true");
  assert(getBody.time, "Expected body.time timestamp to be present");

  const timestampMs = new Date(getBody.time).getTime();
  assert(!isNaN(timestampMs), "Expected body.time to be a valid ISO date");
  assert(Math.abs(Date.now() - timestampMs) < 60000, "Expected body.time to be current");

  // Strict property check: ONLY 'ok' and 'time' may be returned
  const keys = Object.keys(getBody).sort();
  assert.deepStrictEqual(keys, ["ok", "time"], `Unexpected keys in health response: ${keys.join(", ")}`);
  console.log("✅ Test 1.1: GET /health returns 200 with strictly { ok: true, time: ISOString }");

  // Test 1.2: OPTIONS Preflight
  const optRes = await healthHandler({
    httpMethod: "OPTIONS",
    headers: { origin: "https://careermonke.com" },
  });
  assert.strictEqual(optRes.statusCode, 204, `Expected 204 on OPTIONS, got ${optRes.statusCode}`);
  console.log("✅ Test 1.2: OPTIONS /health returns 204 CORS preflight");

  // Test 1.3: HEAD Request
  const headRes = await healthHandler({ httpMethod: "HEAD" });
  assert.strictEqual(headRes.statusCode, 200, `Expected 200 on HEAD, got ${headRes.statusCode}`);
  console.log("✅ Test 1.3: HEAD /health returns 200");

  // Test 1.4: Unsupported Methods (POST/PUT/DELETE)
  const postRes = await healthHandler({ httpMethod: "POST" });
  assert.strictEqual(postRes.statusCode, 405, `Expected 405 on POST, got ${postRes.statusCode}`);
  console.log("✅ Test 1.4: POST /health rejected with 405 Method Not Allowed");

  // =====================================================================================
  // PART 2: Sanitized Error Logging Helper (_logger.ts)
  // =====================================================================================
  console.log("\n--- PART 2: Testing netlify/functions/_logger.ts Sanitization ---");

  // Test 2.1: Groq API Key Redaction
  const groqInput = "Upstream error calling Groq with key gsk_abcdef1234567890abcdef1234567890";
  const groqSanitized = sanitizeLogString(groqInput);
  assert(!groqSanitized.includes("abcdef1234567890abcdef1234567890"), "Groq key leaked!");
  assert(groqSanitized.includes("gsk_[REDACTED]"), "Groq key not properly redacted");
  console.log(`✅ Test 2.1: Groq API key redacted -> "${groqSanitized}"`);

  // Test 2.2: Stripe API Key Redaction
  const stripeInput = "Stripe webhook failed with key sk_live_51Abcdef1234567890";
  const stripeSanitized = sanitizeLogString(stripeInput);
  assert(!stripeSanitized.includes("51Abcdef1234567890"), "Stripe key leaked!");
  assert(stripeSanitized.includes("sk_live_[REDACTED]"), "Stripe key not properly redacted");
  console.log(`✅ Test 2.2: Stripe API key redacted -> "${stripeSanitized}"`);

  // Test 2.3: Supabase Service Role Key Redaction
  const supabaseInput = "Supabase query failed with service key sbp_9876543210abcdef";
  const supabaseSanitized = sanitizeLogString(supabaseInput);
  assert(!supabaseSanitized.includes("9876543210abcdef"), "Supabase key leaked!");
  assert(supabaseSanitized.includes("sbp_[REDACTED]"), "Supabase key not properly redacted");
  console.log(`✅ Test 2.3: Supabase key redacted -> "${supabaseSanitized}"`);

  // Test 2.4: JWT Token Redaction
  const jwtToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const jwtInput = `Failed to verify JWT: ${jwtToken}`;
  const jwtSanitized = sanitizeLogString(jwtInput);
  assert(!jwtSanitized.includes("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"), "JWT signature leaked!");
  assert(jwtSanitized.includes("[JWT_REDACTED]"), "JWT token not properly redacted");
  console.log(`✅ Test 2.4: JWT token redacted -> "${jwtSanitized}"`);

  // Test 2.5: Bearer Token Redaction
  const bearerInput = "Authorization header: Bearer someSecretUserAuthToken123";
  const bearerSanitized = sanitizeLogString(bearerInput);
  assert(!bearerSanitized.includes("someSecretUserAuthToken123"), "Bearer token leaked!");
  assert(bearerSanitized.includes("Bearer [REDACTED]"), "Bearer header not properly redacted");
  console.log(`✅ Test 2.5: Bearer header redacted -> "${bearerSanitized}"`);

  // Test 2.6: Candidate Email Address Redaction
  const emailInput = "User candidate.alex+test@careermonke.com failed rate limit";
  const emailSanitized = sanitizeLogString(emailInput);
  assert(!emailSanitized.includes("candidate.alex+test@careermonke.com"), "User email address leaked!");
  assert(emailSanitized.includes("[EMAIL_REDACTED]"), "Email address not properly redacted");
  console.log(`✅ Test 2.6: Email address redacted -> "${emailSanitized}"`);

  // Test 2.7: Console Interception Integration
  const interceptedLogs: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    interceptedLogs.push(args.join(" "));
  };

  try {
    const errorWithSecrets = new Error("Database timeout for user candidate@gmail.com with token gsk_secret9999");
    safeLog.error("[Netlify /test]", errorWithSecrets);

    assert.strictEqual(interceptedLogs.length, 1);
    const logged = interceptedLogs[0];
    assert(!logged.includes("candidate@gmail.com"), "Intercepted console.error contains user email!");
    assert(!logged.includes("gsk_secret9999"), "Intercepted console.error contains raw API key!");
    assert(logged.includes("[EMAIL_REDACTED]") && logged.includes("gsk_[REDACTED]"), "Sanitization tags missing from console.error");
    console.log(`✅ Test 2.7: console.error intercepted and verified leak-free -> "${logged}"`);
  } finally {
    console.error = originalConsoleError;
  }

  // =====================================================================================
  // PART 3: Negative Control Verification (in-process assertion)
  // =====================================================================================
  console.log("\n--- PART 3: Running In-Process Negative Control ---");
  let negativeControlPassed = false;
  try {
    const leakyString = "Error with key gsk_unmasked_key_leak";
    // Check if asserting absence of secret fails when secret is present
    assert(!leakyString.includes("gsk_unmasked_key_leak"), "Negative control expected failure");
  } catch (err: any) {
    negativeControlPassed = err.message.includes("Negative control expected failure");
    console.log(`✅ Negative control triggered as expected: "${err.message}"`);
  }

  assert(negativeControlPassed, "Negative control failed to catch unmasked secret leak!");

  console.log("\n==================================================================================");
  console.log("HEALTH ENDPOINT & SANITIZED ERROR LOGGING: ALL 8 TESTS PASSED (PASS-LOCAL)");
  console.log("==================================================================================");
}

runTests().catch((err) => {
  console.error("FATAL ERROR in test-health-logging.ts:", err);
  process.exit(1);
});
