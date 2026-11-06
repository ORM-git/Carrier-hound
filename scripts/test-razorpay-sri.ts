import assert from "assert";

console.log("=".repeat(80));
console.log("           RAZORPAY CHECKOUT.JS SUBRESOURCE INTEGRITY AUDIT        ");
console.log("=".repeat(80) + "\n");

const {
  loadRazorpayScript,
  RAZORPAY_CHECKOUT_JS_URL,
  RAZORPAY_CHECKOUT_JS_INTEGRITY,
} = require("../src/lib/billing/razorpay");

async function main() {
  // 1. Constants are well-formed
  assert.strictEqual(RAZORPAY_CHECKOUT_JS_URL, "https://checkout.razorpay.com/v1/checkout.js");
  assert.ok(/^sha384-[A-Za-z0-9+/=]+$/.test(RAZORPAY_CHECKOUT_JS_INTEGRITY), "integrity must be a sha384 SRI hash");
  console.log("ok - SRI constants well-formed (sha384)");

  // 2. Loader pins integrity + crossorigin on the injected script
  {
    const created: any[] = [];
    const appended: any[] = [];
    (globalThis as any).window = {};
    (globalThis as any).document = {
      createElement: (tag: string) => {
        const el: any = { tag };
        created.push(el);
        return el;
      },
      body: { appendChild: (el: any) => appended.push(el) },
    };
    const promise = loadRazorpayScript();
    assert.strictEqual(created.length, 1, "exactly one script element created");
    const script = created[0];
    assert.strictEqual(script.src, RAZORPAY_CHECKOUT_JS_URL);
    assert.strictEqual(script.integrity, RAZORPAY_CHECKOUT_JS_INTEGRITY, "script must carry the SRI pin");
    assert.strictEqual(script.crossOrigin, "anonymous", "SRI requires crossorigin=anonymous");
    assert.strictEqual(script.async, true);
    assert.strictEqual(appended.length, 1, "script appended to body");
    script.onload();
    assert.strictEqual(await promise, true);
    console.log("ok - injected script carries integrity pin and crossorigin=anonymous");
  }

  // 3. Existing Razorpay global short-circuits without injecting again
  {
    (globalThis as any).window = { Razorpay: function () {} };
    (globalThis as any).document = {
      createElement: () => { throw new Error("must not create a second script"); },
      body: { appendChild: () => { throw new Error("must not append"); } },
    };
    assert.strictEqual(await loadRazorpayScript(), true);
    console.log("ok - already-loaded SDK short-circuits");
  }

  delete (globalThis as any).window;
  delete (globalThis as any).document;
  console.log("\nAll Razorpay SRI checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
