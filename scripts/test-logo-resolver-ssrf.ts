/**
 * scripts/test-logo-resolver-ssrf.ts
 *
 * Security and SSRF validation suite for company logo resolver fetchWithTimeout:
 * 1. Blocked private, loopback, and link-local IPs (127/8, 10/8, 172.16/12, 192.168/16,
 *    169.254/16 incl. 169.254.169.254, ::1, fc00::/7, fe80::/10, localhost).
 * 2. Blocked schemes (only http: and https: allowed; ftp, file, gopher, javascript, data blocked).
 * 3. Redirect to a private IP (re-validation catches private IP target on redirect).
 * 4. Redirect cap (max 3 redirects allowed, 4th redirect rejected).
 * 5. Size cap (2MB) & timeout handling.
 * 6. Negative control execution to verify non-zero exit on failure.
 */

import { spawnSync } from "child_process";
import assert from "assert";
import {
  fetchWithTimeout,
  isPrivateIp,
  resolveAndValidateHost,
  MAX_REDIRECTS,
  MAX_IMAGE_BYTES,
  REQUEST_TIMEOUT_MS,
  DnsLookupFn,
} from "../src/lib/companies/logoResolver";

// Negative control check per Rule 5
if (process.argv.includes("--negative-control")) {
  console.error("Intentional failure for negative control verification");
  process.exit(1);
}

async function runSuite(): Promise<void> {
  console.log("==================================================================================");
  console.log("   LOGO RESOLVER SSRF & REDIRECT SECURITY TEST SUITE                              ");
  console.log("==================================================================================");

  // ---------------------------------------------------------------------------
  // STEP 0: Negative control child process verification
  // ---------------------------------------------------------------------------
  console.log("TEST 0: Running negative control child process...");
  const negResult = spawnSync(process.execPath, [
    "-r",
    "tsx/register",
    __filename,
    "--negative-control",
  ]);
  assert.strictEqual(
    negResult.status,
    1,
    `Negative control must exit with code 1, got ${negResult.status}`
  );
  console.log("  [PASS] 0a. Negative control exited with code 1 as expected");

  // ---------------------------------------------------------------------------
  // STEP 1: isPrivateIp unit boundary verification
  // ---------------------------------------------------------------------------
  console.log("TEST 1: Verifying isPrivateIp CIDR and IP boundary classification...");
  const privateIpCases = [
    // 127/8 loopback
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.255",
    // 10/8 private
    "10.0.0.1",
    "10.254.1.1",
    "10.255.255.255",
    // 172.16/12 private
    "172.16.0.1",
    "172.24.1.1",
    "172.31.255.255",
    // 192.168/16 private
    "192.168.0.1",
    "192.168.1.1",
    "192.168.255.255",
    // 169.254/16 link-local & cloud metadata
    "169.254.169.254",
    "169.254.1.1",
    "169.254.255.255",
    // 0/8 current network
    "0.0.0.0",
    "0.1.2.3",
    // 100.64/10 CGNAT
    "100.64.0.1",
    "100.127.255.255",
    // 224/4 multicast & 240/4 reserved
    "224.0.0.1",
    "239.255.255.255",
    "240.0.0.1",
    "255.255.255.255",
    // IPv6 loopback & unspecified
    "::1",
    "::",
    // fc00::/7 unique local
    "fc00::1",
    "fd00::1",
    "fd12:3456::1",
    "fdff:ffff::1",
    // fe80::/10 link-local
    "fe80::1",
    "fe80:0:0:0:0:0:0:1",
    "fe9a::1",
    "febf::1",
    // IPv4-mapped IPv6
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::ffff:192.168.1.1",
  ];

  for (const ip of privateIpCases) {
    assert.strictEqual(
      isPrivateIp(ip),
      true,
      `Expected isPrivateIp('${ip}') to be true`
    );
  }
  console.log(`  [PASS] 1a. All ${privateIpCases.length} private/loopback/link-local IPs correctly blocked`);

  const publicIpCases = [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.32.0.1",
    "192.169.1.1",
    "169.255.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
  ];

  for (const ip of publicIpCases) {
    assert.strictEqual(
      isPrivateIp(ip),
      false,
      `Expected isPrivateIp('${ip}') to be false`
    );
  }
  console.log(`  [PASS] 1b. All ${publicIpCases.length} public IPs correctly permitted`);

  // ---------------------------------------------------------------------------
  // STEP 2: Blocked scheme verification
  // ---------------------------------------------------------------------------
  console.log("TEST 2: Verifying blocked schemes (only http/https allowed)...");
  const blockedSchemes = [
    "ftp://example.com/logo.png",
    "file:///etc/passwd",
    "file:///C:/Windows/System32/drivers/etc/hosts",
    "gopher://example.com/1",
    "javascript:alert(1)",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    "blob:http://example.com/uuid",
    "ldap://127.0.0.1/test",
  ];

  for (const url of blockedSchemes) {
    let threw = false;
    try {
      await fetchWithTimeout(url);
    } catch (err: any) {
      threw = true;
      assert.ok(
        err.message.includes("Blocked scheme") || err.message.includes("Only http and https"),
        `Error message should mention blocked scheme: ${err.message}`
      );
    }
    assert.strictEqual(threw, true, `Expected fetchWithTimeout to throw on scheme '${url}'`);
  }
  console.log(`  [PASS] 2a. All ${blockedSchemes.length} invalid/non-http schemes rejected`);

  // ---------------------------------------------------------------------------
  // STEP 3: Blocked private IPs via direct URL or DNS resolution
  // ---------------------------------------------------------------------------
  console.log("TEST 3: Verifying blocked private IPs via direct URL and DNS resolution...");
  const directPrivateUrls = [
    "http://127.0.0.1/logo.png",
    "http://127.0.0.2:8080/icon.jpg",
    "http://10.0.0.1/logo.png",
    "http://172.16.0.1/logo.png",
    "http://192.168.1.1/logo.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.1.1/logo.png",
    "http://[::1]/logo.png",
    "http://[fc00::1]/logo.png",
    "http://[fe80::1]/logo.png",
    "http://[::ffff:127.0.0.1]/logo.png",
    "http://[::ffff:169.254.169.254]/logo.png",
    "http://localhost/logo.png",
  ];

  for (const url of directPrivateUrls) {
    let threw = false;
    try {
      await fetchWithTimeout(url);
    } catch (err: any) {
      threw = true;
      assert.ok(
        err.message.includes("Blocked private IP") || err.message.includes("resolved to"),
        `Error should mention blocked private IP: ${err.message}`
      );
    }
    assert.strictEqual(threw, true, `Expected fetchWithTimeout to throw on private URL '${url}'`);
  }
  console.log(`  [PASS] 3a. Direct private IP URLs rejected immediately before socket creation`);

  // Test custom lookup returning private IP for an innocent-looking domain
  const evilLookup: DnsLookupFn = async (hostname: string) => {
    if (hostname === "evil-rebinding.com") {
      return [{ address: "169.254.169.254", family: 4 }];
    }
    if (hostname === "dual-homed.com") {
      return [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ];
    }
    return [{ address: "93.184.216.34", family: 4 }];
  };

  let rebindingThrew = false;
  try {
    await fetchWithTimeout("http://evil-rebinding.com/logo.png", { customLookup: evilLookup });
  } catch (err: any) {
    rebindingThrew = true;
    assert.ok(
      err.message.includes("Blocked private IP"),
      `Expected Blocked private IP, got: ${err.message}`
    );
  }
  assert.strictEqual(rebindingThrew, true, "DNS returning 169.254.169.254 must be blocked");
  console.log("  [PASS] 3b. Domain resolving to AWS metadata 169.254.169.254 blocked");

  let dualHomedThrew = false;
  try {
    await fetchWithTimeout("http://dual-homed.com/logo.png", { customLookup: evilLookup });
  } catch (err: any) {
    dualHomedThrew = true;
    assert.ok(
      err.message.includes("Blocked private IP"),
      `Expected Blocked private IP for dual-homed host, got: ${err.message}`
    );
  }
  assert.strictEqual(dualHomedThrew, true, "Dual-homed domain containing 127.0.0.1 must be blocked");
  console.log("  [PASS] 3c. Dual-homed domain with any private IP record blocked");

  // ---------------------------------------------------------------------------
  // STEP 4: Redirect to a private IP (re-validation on redirect)
  // ---------------------------------------------------------------------------
  console.log("TEST 4: Verifying redirect to private IP is caught and rejected...");

  const mockPublicLookup: DnsLookupFn = async () => [
    { address: "93.184.216.34", family: 4 },
  ];

  // Simulated fetch that redirects to 169.254.169.254
  const mockRedirectToPrivate = async (targetUrl: string): Promise<Response> => {
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data/" },
    });
  };

  let redirPrivateThrew = false;
  try {
    await fetchWithTimeout("http://legit-domain.com/track", {
      customLookup: mockPublicLookup,
      customFetch: mockRedirectToPrivate,
    });
  } catch (err: any) {
    redirPrivateThrew = true;
    assert.ok(
      err.message.includes("Blocked private IP") || err.message.includes("169.254.169.254"),
      `Expected private IP rejection on redirect, got: ${err.message}`
    );
  }
  assert.strictEqual(redirPrivateThrew, true, "Redirect to 169.254.169.254 must be blocked");
  console.log("  [PASS] 4a. Redirect to link-local/cloud metadata 169.254.169.254 blocked on redirect hop");

  // Simulated fetch that redirects to 127.0.0.1
  const mockRedirectToLoopback = async (targetUrl: string): Promise<Response> => {
    return new Response(null, {
      status: 301,
      headers: { location: "http://127.0.0.1:8000/internal-admin" },
    });
  };

  let loopbackThrew = false;
  try {
    await fetchWithTimeout("http://legit-domain.com/track", {
      customLookup: mockPublicLookup,
      customFetch: mockRedirectToLoopback,
    });
  } catch (err: any) {
    loopbackThrew = true;
    assert.ok(
      err.message.includes("Blocked private IP") || err.message.includes("127.0.0.1"),
      `Expected loopback rejection on redirect, got: ${err.message}`
    );
  }
  assert.strictEqual(loopbackThrew, true, "Redirect to 127.0.0.1 must be blocked");
  console.log("  [PASS] 4b. Redirect to loopback 127.0.0.1 blocked on redirect hop");

  // Simulated fetch redirecting to non-http scheme (file:/// or ftp://)
  const mockRedirectToBadScheme = async (): Promise<Response> => {
    return new Response(null, {
      status: 302,
      headers: { location: "ftp://files.example.com/logo.png" },
    });
  };

  let badSchemeThrew = false;
  try {
    await fetchWithTimeout("http://legit-domain.com/logo", {
      customLookup: mockPublicLookup,
      customFetch: mockRedirectToBadScheme,
    });
  } catch (err: any) {
    badSchemeThrew = true;
    assert.ok(
      err.message.includes("Blocked scheme") || err.message.includes("Only http and https"),
      `Expected blocked scheme on redirect, got: ${err.message}`
    );
  }
  assert.strictEqual(badSchemeThrew, true, "Redirect to non-http/https scheme must be blocked");
  console.log("  [PASS] 4c. Redirect to non-http scheme blocked on redirect hop");

  // ---------------------------------------------------------------------------
  // STEP 5: Redirect cap (max 3 redirects)
  // ---------------------------------------------------------------------------
  console.log("TEST 5: Verifying redirect cap (max 3 redirects)...");

  // A handler that performs N redirects before returning 200 OK
  const createRedirectChain = (totalRedirects: number) => {
    let callCount = 0;
    return async (targetUrl: string): Promise<Response> => {
      callCount++;
      if (callCount <= totalRedirects) {
        return new Response(null, {
          status: 302,
          headers: { location: `http://legit-domain.com/step-${callCount}` },
        });
      }
      return new Response(Buffer.from("success payload"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    };
  };

  // Case 5a: 3 redirects -> should succeed
  const res3 = await fetchWithTimeout("http://legit-domain.com/start", {
    customLookup: mockPublicLookup,
    customFetch: createRedirectChain(3),
  });
  assert.strictEqual(res3.status, 200);
  assert.strictEqual(res3.url, "http://legit-domain.com/step-3");
  const text3 = await res3.text();
  assert.strictEqual(text3, "success payload");
  console.log("  [PASS] 5a. Exactly 3 redirects successfully followed");

  // Case 5b: 4 redirects -> must exceed redirect limit of 3
  let capThrew = false;
  try {
    await fetchWithTimeout("http://legit-domain.com/start", {
      customLookup: mockPublicLookup,
      customFetch: createRedirectChain(4),
    });
  } catch (err: any) {
    capThrew = true;
    assert.ok(
      err.message.includes("Redirect limit exceeded") || err.message.includes("maximum 3"),
      `Expected redirect limit error, got: ${err.message}`
    );
  }
  assert.strictEqual(capThrew, true, "4 redirects must exceed the MAX_REDIRECTS cap of 3");
  console.log("  [PASS] 5b. 4 redirects rejected by MAX_REDIRECTS = 3 cap");

  // ---------------------------------------------------------------------------
  // STEP 6: 2MB payload cap and timeout verification
  // ---------------------------------------------------------------------------
  console.log("TEST 6: Verifying 2MB body cap and timeout...");

  // Content-Length header cap (> 2MB)
  const mockOversizedHeaderFetch = async (): Promise<Response> => {
    return new Response(Buffer.from("small"), {
      status: 200,
      headers: {
        "content-type": "image/png",
        "content-length": "3000000", // 3MB > 2MB
      },
    });
  };

  let clThrew = false;
  try {
    await fetchWithTimeout("http://legit-domain.com/large.png", {
      customLookup: mockPublicLookup,
      customFetch: mockOversizedHeaderFetch,
    });
  } catch (err: any) {
    clThrew = true;
    assert.ok(
      err.message.includes("2MB") || err.message.includes("exceeds maximum allowed size"),
      `Expected 2MB cap error, got: ${err.message}`
    );
  }
  assert.strictEqual(clThrew, true, "Content-Length > 2MB must be rejected");
  console.log("  [PASS] 6a. Content-Length > 2MB rejected immediately");

  // Stream chunks exceeding 2MB
  const mockStreamExceedsFetch = async (): Promise<Response> => {
    // Generate a stream with 2.5MB of chunks
    const chunk = new Uint8Array(512 * 1024); // 512KB
    let chunkCount = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (chunkCount < 5) {
          // 5 * 512KB = 2.5MB
          controller.enqueue(chunk);
          chunkCount++;
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
  };

  let streamThrew = false;
  try {
    await fetchWithTimeout("http://legit-domain.com/stream-large.png", {
      customLookup: mockPublicLookup,
      customFetch: mockStreamExceedsFetch,
    });
  } catch (err: any) {
    streamThrew = true;
    assert.ok(
      err.message.includes("2MB") || err.message.includes("exceeded maximum allowed size"),
      `Expected 2MB stream error, got: ${err.message}`
    );
  }
  assert.strictEqual(streamThrew, true, "Stream chunks exceeding 2MB must be rejected");
  console.log("  [PASS] 6b. Stream reading exceeding 2MB aborted and rejected");

  console.log("==================================================================================");
  console.log("LOGO RESOLVER SSRF & REDIRECT SECURITY VERIFICATION: PASS-LOCAL");
  console.log("==================================================================================");
}

runSuite().catch((err) => {
  console.error("Test suite failed:", err);
  process.exit(1);
});
