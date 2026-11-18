/**
 * scripts/test-launch-smoke-pricing-probe.ts
 *
 * Offline mock tests for check (5) in scripts/launch-smoke-test.ts (pricing copy probe).
 * Serves fixture HTML from a local HTTP server and asserts that the probe:
 *  - reads only VISIBLE text (scripts, styles, asset URLs and hidden elements are ignored),
 *  - matches prices on whole-number boundaries,
 *  - scopes the auto-renew denial rule to visible text,
 *  - applies its timeout to the body read, not just the response headers.
 */

import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  checkPricingCopy,
  evaluatePricingText,
  extractVisibleText,
} from "./launch-smoke-test";

const CORRECT_BODY = `
  <h1>Plans and pricing</h1>
  <p>Weekly <span>₹399</span> one-time</p>
  <p>Monthly <span>&#8377;499</span> one-time</p>
  <p>Quarterly <span>₹2,199</span> one-time</p>
  <p>Plans are prepaid for a fixed duration and do not auto-renew.</p>
`;

function page(body: string, head = ""): string {
  return `<!DOCTYPE html><html><head><title>Pricing</title>${head}</head><body>${body}</body></html>`;
}

// Harmless asset URLs and inline payloads that contain forbidden numbers / phrases
const HARMLESS_NOISE_HEAD = `
  <link rel="stylesheet" href="/_next/static/css/799-ef01.css">
  <script src="/_next/static/chunks/692-abcd.js" async></script>
  <style>.price-799{color:red}</style>
`;
const HARMLESS_NOISE_BODY = `
  <img src="/_next/image?url=%2F692.png&w=799" alt="">
  <script>self.__next_f.push([1,"692:I[799,[],\\"\\"] plan auto-renews monthly first month"])</script>
  <noscript>₹799 first month</noscript>
  <svg viewBox="0 0 692 799"><text>799</text></svg>
`;

type Route = (res: http.ServerResponse) => void;

async function withServer(route: Route, fn: (origin: string) => Promise<void>): Promise<void> {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    if (req.url === "/pricing") return route(res);
    res.writeHead(404).end();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const serveHtml = (html: string): Route => (res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
};

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    failures++;
    console.error(`  [FAIL] ${name}: ${err?.message || err}`);
  }
}

async function run() {
  console.log("=".repeat(80));
  console.log("   LAUNCH SMOKE PRICING PROBE (check 5) MOCK TESTS");
  console.log("=".repeat(80));

  // ---------------------------------------------------------------------------
  // Positive controls
  // ---------------------------------------------------------------------------
  await check("positive control: correct prices plus script/asset URLs containing 692/799 pass", async () => {
    await withServer(serveHtml(page(CORRECT_BODY + HARMLESS_NOISE_BODY, HARMLESS_NOISE_HEAD)), async (origin) => {
      const result = await checkPricingCopy(origin);
      assert.strictEqual(result.passed, true, result.summary);
    });
  });

  await check("positive control: hidden helper text with 692 and an affirmative auto-renew is ignored", async () => {
    const html = page(
      CORRECT_BODY +
        `<div hidden><p>₹692 renews automatically</p></div>
         <span class="sr-only">Old price ₹799</span>
         <div style="display:none"><div><p>first month offer</p></div></div>
         <p aria-hidden="true">auto-renews every month</p>`
    );
    await withServer(serveHtml(html), async (origin) => {
      const result = await checkPricingCopy(origin);
      assert.strictEqual(result.passed, true, result.summary);
    });
  });

  await check("visible text extraction keeps responsive-visible content (hidden sm:block)", () => {
    const text = extractVisibleText(page(`<span class="hidden sm:block">₹2,199</span><span class="hidden">₹799</span>`));
    assert.ok(text.includes("₹2,199"), text);
    assert.ok(!text.includes("799"), text);
  });

  // ---------------------------------------------------------------------------
  // Negative controls
  // ---------------------------------------------------------------------------
  await check("negative control: a wrong visible price (₹799 instead of ₹499) fails", async () => {
    const html = page(CORRECT_BODY.replace("&#8377;499", "₹799"));
    await withServer(serveHtml(html), async (origin) => {
      const result = await checkPricingCopy(origin);
      assert.strictEqual(result.passed, false, "wrong price must fail");
      assert.match(result.summary, /₹499/);
      assert.match(result.summary, /799/);
    });
  });

  await check("negative control: a missing price (no ₹2,199) fails", async () => {
    const html = page(CORRECT_BODY.replace("₹2,199", "₹2,999"));
    await withServer(serveHtml(html), async (origin) => {
      const result = await checkPricingCopy(origin);
      assert.strictEqual(result.passed, false, "missing price must fail");
      assert.match(result.summary, /₹2,199/);
    });
  });

  await check("negative control: required prices only in scripts/hidden markup do not count", async () => {
    const html = page(
      `<h1>Pricing</h1><p>Plans do not auto-renew.</p>
       <script>window.__prices = "₹399 ₹499 ₹2,199"</script>
       <div hidden>₹399 ₹499 ₹2,199</div>
       <a href="/plans?p=399&q=499&r=2,199">See plans</a>`
    );
    await withServer(serveHtml(html), async (origin) => {
      const result = await checkPricingCopy(origin);
      assert.strictEqual(result.passed, false, "prices outside visible text must not satisfy the probe");
    });
  });

  await check("negative control: a visible affirmative auto-renew sentence fails", async () => {
    const html = page(CORRECT_BODY + `<p>Your plan renews automatically each month.</p>`);
    await withServer(serveHtml(html), async (origin) => {
      const result = await checkPricingCopy(origin);
      assert.strictEqual(result.passed, false);
      assert.match(result.summary, /auto-renew/);
    });
  });

  await check("positive control: an FAQ question about auto-renewal followed by a denial passes", () => {
    const html = page(
      CORRECT_BODY + `<details><summary>Does my plan renew automatically?</summary><p>No. Plans are prepaid.</p></details>`
    );
    const evaluation = evaluatePricingText(extractVisibleText(html));
    assert.strictEqual(evaluation.passed, true, JSON.stringify(evaluation));
  });

  await check("negative control: visible 'first month' copy fails", () => {
    const evaluation = evaluatePricingText(extractVisibleText(page(CORRECT_BODY + `<p>20% off your first month</p>`)));
    assert.strictEqual(evaluation.passed, false);
    assert.ok(evaluation.forbidden.includes('"first month"'));
  });

  // ---------------------------------------------------------------------------
  // Number boundaries
  // ---------------------------------------------------------------------------
  await check("number boundaries: 1,799 / 7990 / 2,799 / 692.5 are not 799 or 692", () => {
    const evaluation = evaluatePricingText("₹399 ₹499 ₹2,199 do not auto-renew. ₹1,799 7990 2,799 1692 692.5");
    assert.deepStrictEqual(evaluation.forbidden, []);
    assert.strictEqual(evaluation.passed, true);
  });

  await check("number boundaries: ₹4,399 / ₹14,99 / ₹2,1990 do not satisfy required prices", () => {
    const evaluation = evaluatePricingText("₹4,399 ₹1499 ₹2,1990 plans do not auto-renew.");
    assert.deepStrictEqual(evaluation.missing, ["₹399", "₹499", "₹2,199"]);
  });

  await check("number boundaries: standalone 692 and ₹799 in visible text are caught", () => {
    assert.deepStrictEqual(evaluatePricingText("₹399 ₹499 ₹2,199 was 692").forbidden, ["692"]);
    assert.deepStrictEqual(evaluatePricingText("₹399 ₹499 ₹2,199 (₹799)").forbidden, ["799"]);
  });

  // ---------------------------------------------------------------------------
  // Timeout covers the body read
  // ---------------------------------------------------------------------------
  await check("timeout applies to the body: headers sent, body stalls -> fails within the cap", async () => {
    const stall: Route = (res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.write("<!DOCTYPE html><html><body><p>₹399"); // body never finishes
    };
    await withServer(stall, async (origin) => {
      const started = Date.now();
      const result = await checkPricingCopy(origin, 300);
      const elapsed = Date.now() - started;
      assert.strictEqual(result.passed, false, "stalled body must fail");
      assert.match(result.summary, /Failed to fetch \/pricing/);
      assert.ok(elapsed < 3000, `probe must abort near the 300ms cap, took ${elapsed}ms`);
    });
  });

  console.log("");
  if (failures > 0) {
    console.error(`FAILED: ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("ALL PRICING PROBE MOCK TESTS PASSED");
}

run().catch((err) => {
  console.error("Fatal error in pricing probe mock tests:", err);
  process.exit(1);
});
