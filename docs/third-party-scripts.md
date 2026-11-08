# Third-Party Script Inventory (audit BE #68)

Every `<script>` the app loads from a third-party origin must either:

1. Carry **Subresource Integrity** (`integrity` + `crossorigin`), so a
   tampered or swapped CDN response fails closed, or
2. Be named in the exception table below, with the reason SRI is not
   possible and the compensating controls.

A new third-party script URL must not be added without updating this file.
The guard test `src/lib/__tests__/thirdPartyScripts.test.ts` enforces the
match between this file and the code.

## Guard block (parsed by the test)

```guard
script: https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js | sri: sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e | crossorigin: anonymous | used-by: src/lib/resume/parser.ts
script: https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js | no-sri: worker file loaded by pdf.js itself from a version-pinned URL; cannot attach integrity to a worker fetch, version pin + CSP worker-src host allowlist is the control | used-by: src/lib/resume/parser.ts
script: https://checkout.razorpay.com/v1/checkout.js | exception: Razorpay updates checkout.js in place at this fixed URL, so any pinned hash breaks checkout on their next deploy; their integration docs require loading exactly this URL | mitigations: CSP script-src restricted to checkout.razorpay.com, loaded lazily only when the user opens checkout, failure returns false and blocks the purchase flow | used-by: src/lib/billing/razorpay.ts
```

## Notes

- **pdf.js 3.11.174 (cdnjs).** cdnjs serves a static, versioned file, so SRI
  is fully supported. The hash above is the sha384 of
  `pdf.min.js` at that exact URL (computed 2026-11-08). Upgrading pdf.js
  means recomputing the hash and updating both `parser.ts` and this file.
- **pdf.worker.min.js.** Set via `GlobalWorkerOptions.workerSrc`. Workers are
  fetched by pdf.js internally, so no integrity attribute can be attached;
  the URL is version-pinned and CSP `worker-src` allows only self/blob/cdnjs.
- **Razorpay checkout.js.** Exception as documented above. The CSP in
  `public/_headers` and `netlify.toml` (kept identical by the config-drift
  check) allows only the exact origins listed in `script-src`.
- All other scripts ship from our own bundle (`script-src 'self'` covers
  them); images and fonts from third-party hosts are out of scope for SRI.
