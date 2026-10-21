# Content Security Policy (CSP) Architecture & Hardening Notes

## 1. Current Enforced Policy (`public/_headers` & `netlify.toml`)

```text
default-src 'self';
script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://checkout.razorpay.com https://accounts.google.com https://apis.google.com;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' data: https://fonts.gstatic.com;
img-src 'self' data: blob: https://images.unsplash.com https://randomuser.me https://avatar.iran.liara.run https://i.pravatar.cc https://unavatar.io https://t3.gstatic.com https://*.googleusercontent.com https://*.supabase.co;
connect-src 'self' https://szakevhxhwpeskidvtfs.supabase.co https://*.supabase.co wss://*.supabase.co https://accounts.google.com https://*.googleapis.com https://checkout.razorpay.com https://api.razorpay.com https://unavatar.io https://t3.gstatic.com;
frame-src 'self' https://accounts.google.com https://*.supabase.co https://api.razorpay.com;
worker-src 'self' blob: https://cdnjs.cloudflare.com;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
```

---

## 2. Hardening Changes Applied in Security PR 3

1. **Removed `'unsafe-eval'` from `script-src`**:
   - **Audit result**: Zero runtime code in `src/` uses `eval()` or `new Function()`. Production builds (`npm run build` with `output: "export"`) emit pre-compiled static chunks under `/_next/static/chunks/` that do not use `eval` (unlike Next.js development mode `webpack` HMR). Third-party scripts (`pdf.min.js`, Razorpay Checkout, Google Identity Services, Three.js) do not require `'unsafe-eval'`.
2. **Added Mandatory Framing, Base, Form, and Object Restrictions**:
   - `frame-ancestors 'none'` — Prevents clickjacking / iframe embedding of any CareerMonke page (reinforces `X-Frame-Options: DENY`).
   - `base-uri 'self'` — Prevents `<base href="...">` tag injection from hijacking relative script/link resolution.
   - `form-action 'self'` — Restricts native `<form>` submissions to same-origin endpoints only, blocking credential/data exfiltration via injected form targets.
   - `object-src 'none'` — Blocks legacy plugin execution (`<object>`, `<embed>`, `<applet>`).
3. **Added `Content-Security-Policy-Report-Only` Header**:
   - Configured alongside the enforced policy in `public/_headers` and `netlify.toml` so future candidate directive tightenings can be staged in `Content-Security-Policy-Report-Only` first without breaking page rendering.

---

## 3. Why `'unsafe-inline'` Remains Required in `script-src`

### What requires `'unsafe-inline'` in `script-src`:
1. **Next.js 14 App Router Static Export Hydration Scripts (`out/**/*.html`)**:
   - CareerMonke builds with `output: "export"` in `next.config.mjs`, generating 49 static HTML pages in `out/`.
   - Every exported HTML page embeds multiple inline React Server Component (RSC) bootstrap and flight payload scripts of the form:
     ```html
     <script>(self.__next_f=self.__next_f||[]).push([0]);self.__next_f.push([2,null])</script>
     <script>self.__next_f.push([1,"..."])</script>
     ```
   - Each of the 49 static pages has unique inline payload strings whose SHA-256 hashes change on every build.
2. **Why Static Export Cannot Use Nonces or Global Hashes**:
   - **Nonces (`'nonce-...'`)**: Require per-request dynamic HTML rewriting at the edge to inject a fresh cryptographic nonce into every `<script>` tag and matching HTTP response header. Static export (`output: "export"`) serves pre-rendered `.html` files directly from CDN storage.
   - **Hashes (`'sha256-...'`)**: Because `/*` in `public/_headers` and `netlify.toml` applies a single global header across all 49 static routes, accumulating 300+ per-page inline script hashes into one `Content-Security-Policy` header would exceed CDN HTTP header size limits (8 KB–16 KB) and break whenever any page content is rebuilt.
   - Note: JSON-LD structured data blocks (`<script type="application/ld+json">` in `src/app/layout.tsx` and `src/app/jobs/page.tsx`) are non-executable data blocks and do not require `'unsafe-inline'`, so Next.js RSC inline hydration scripts are the sole reason `'unsafe-inline'` is retained in `script-src`.

---

## 4. Running Changes in Report-Only First & What to Watch in the Console

When testing any stricter CSP rule (such as removing `'unsafe-inline'` after introducing an Edge nonce middleware, or tightening `connect-src` / `img-src`), apply the candidate policy to `Content-Security-Policy-Report-Only` first while keeping `Content-Security-Policy` unchanged.

### Browser DevTools Console Messages to Watch For:
- **Blocked `eval` / `Function()`**:
  `Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: "script-src ..."`
- **Blocked Inline Script**:
  `[Report Only] Refused to execute inline script because it violates the following Content Security Policy directive: "script-src ..."`
- **Blocked External Script / Worker (PDF.js / Razorpay / Google Auth)**:
  `Refused to load the script '<URL>' because it violates the following Content Security Policy directive: "script-src ..."`
  `Refused to create a worker from 'blob:...' because it violates the following Content Security Policy directive: "worker-src ..."`
- **Blocked Fetch / XHR / WebSocket (Supabase / Google / Razorpay)**:
  `Refused to connect to '<URL>' because it violates the following Content Security Policy directive: "connect-src ..."`
- **Blocked Form Submission**:
  `Refused to send form data to '<URL>' because it violates the following Content Security Policy directive: "form-action 'self'"`
