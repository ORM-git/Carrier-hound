/* Scenarios for scripts/capture-cm-mobile-715.cjs. FIXTURE data only; see that file for the safety model. */

const KEYBOARD = { 360: 480, 390: 508, 430: 590 }; // visual viewport left when the on-screen keyboard is open

/** Reachability of the last controls inside a scrollable sheet: scroll each into view, then measure. */
async function reachable(page, selectors) {
  return page.evaluate((sels) => {
    const out = {};
    const vh = window.innerHeight;
    for (const [name, sel] of Object.entries(sels)) {
      // First match that is actually rendered (breakpoint copies are display:none).
      const el = Array.from(document.querySelectorAll(sel)).find((e) => getComputedStyle(e).display !== "none" && e.getClientRects().length > 0 && (!e.closest("[class]") || e.offsetParent !== null));
      if (!el) {
        out[name] = { found: false };
        continue;
      }
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      out[name] = { found: true, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), inView: r.top >= 0 && r.bottom <= vh + 0.5 };
    }
    return out;
  }, selectors);
}

// ======================================================================= #3 password auth
async function item3(ctx) {
  const { newPage, settle, shot, record, probe, WIDTHS, APP } = ctx;
  const signinFail = (code, status, message) => (p) =>
    p === "/auth/v1/token" ? { status, body: { code, error_code: code, msg: message, message } } : undefined;

  for (const { w, h } of WIDTHS) {
    for (const [route, card] of [
      ["/login", "login-auth-card"],
      ["/signup", "signup-auth-card"],
    ]) {
      const name = route.slice(1);
      // Full height
      let page = await newPage({ w, h });
      await page.goto(`${APP}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`[data-testid="${card}"]`);
      await settle(page);
      await probe(page);
      const geo = await page.evaluate((card) => {
        const c = document.querySelector(`[data-testid="${card}"]`);
        const submit = c.querySelector('button[type="submit"]');
        const legal = Array.from(c.querySelectorAll("p")).find((p) => /Terms/.test(p.textContent) && window.__cm.visible(p));
        const pw = c.querySelector('input[type="password"]');
        const email = c.querySelector('input[type="email"]');
        return {
          hOverflow: window.__cm.hOverflow(),
          card: window.__cm.rect(c),
          submit: window.__cm.rect(submit),
          submitLabel: submit && submit.textContent.trim(),
          legalVisible: Boolean(legal) && legal.getBoundingClientRect().bottom <= window.innerHeight,
          passwordField: Boolean(pw),
          emailField: Boolean(email),
          otpWording: /one-time|magic link|OTP|code/i.test(c.textContent),
          // Inline links inside a sentence are exempt from target size (WCAG 2.5.8 inline exception).
          minTarget: Math.min(...Array.from(c.querySelectorAll("button, input, a")).filter((e) => window.__cm.visible(e) && !(e.tagName === "A" && (e.closest("p") || (e.parentElement && e.parentElement.textContent.trim() !== e.textContent.trim())))).map((e) => e.getBoundingClientRect().height)),
        };
      }, card);
      const file = await shot(page, 3, `${name}-default`);
      record(3, {
        case: `${name} form`,
        width: w,
        pass: geo.hOverflow <= 0 && geo.passwordField && geo.emailField && !geo.otpWording && geo.legalVisible && geo.submit.h >= 44 && geo.minTarget >= 32,
        detail: geo,
        screenshot: file,
      });
      await page.close();

      // Keyboard-equivalent short viewport: email focused; submit and legal text must still be reachable.
      page = await newPage({ w, h: KEYBOARD[w] });
      await page.goto(`${APP}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(`[data-testid="${card}"]`);
      await settle(page);
      await page.focus('input[type="email"]');
      await probe(page);
      const reach = await reachable(page, {
        submit: `[data-testid="${card}"] button[type="submit"]`,
        legal: `[data-testid="${card}"] a[href="/privacy-policy"]`,
        switch: `[data-testid="${card}"] a[href^="/${name === "login" ? "signup" : "login"}"]`,
      });
      await page.evaluate((card) => (document.querySelector(`[data-testid="${card}"]`).scrollTop = 0), card);
      await page.focus('input[type="email"]');
      const fileKb = await shot(page, 3, `${name}-keyboard`, `viewport ${w}x${KEYBOARD[w]}`);
      await page.evaluate((card) => { const c = document.querySelector(`[data-testid="${card}"]`); c.scrollTop = c.scrollHeight; }, card);
      const fileKb2 = await shot(page, 3, `${name}-keyboard-scrolled`, `viewport ${w}x${KEYBOARD[w]}`);
      record(3, {
        case: `${name} keyboard-open viewport: submit + Terms/Privacy reachable by scrolling the sheet`,
        width: w,
        pass: Object.values(reach).every((r) => r.found && r.inView),
        detail: reach,
        screenshot: [fileKb, fileKb2],
      });
      await page.close();
    }

    // Login error states (mocked GoTrue responses, nothing leaves localhost)
    const loginStates = [
      ["login-invalid-password", signinFail("invalid_credentials", 400, "Invalid login credentials"), /Incorrect email or password/],
      ["login-unverified", signinFail("email_not_confirmed", 400, "Email not confirmed"), /verify your email/],
      ["login-rate-limited", signinFail("over_request_rate_limit", 429, "Request rate limit reached"), /Too many attempts/],
      ["login-pending", (p) => (p === "/auth/v1/token" ? { hang: true } : undefined), null],
    ];
    for (const [name, api, expectText] of loginStates) {
      const page = await newPage({ w, h, api });
      await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#login-email");
      await settle(page);
      await page.type("#login-email", "fixture.user@example.invalid");
      await page.type("#login-password", "fixture-password-1");
      await page.click('[data-testid="login-auth-card"] button[type="submit"]');
      if (expectText) await page.waitForSelector('[data-testid="auth-error-banner"]', { timeout: 15000 });
      else await page.waitForFunction(() => /Signing in/.test(document.querySelector('[data-testid="login-auth-card"] button[type="submit"]').textContent));
      await new Promise((r) => setTimeout(r, 300));
      const state = await page.evaluate(() => {
        const b = document.querySelector('[data-testid="auth-error-banner"]');
        const s = document.querySelector('[data-testid="login-auth-card"] button[type="submit"]');
        return { banner: b && b.textContent.trim(), submit: s.textContent.trim(), disabled: s.disabled, url: location.pathname };
      });
      const file = await shot(page, 3, name);
      const tokenCalls = (page.authCalls || []).filter((c) => c.includes("/token")).length;
      record(3, {
        case: name,
        width: w,
        pass: expectText ? expectText.test(state.banner || "") && state.url === "/login" && tokenCalls === 1 : state.disabled && /Signing in/.test(state.submit) && tokenCalls === 1,
        detail: { ...state, tokenCalls, otpCalls: (page.authCalls || []).filter((c) => /otp|magiclink/.test(c)).length },
        screenshot: file,
      });
      await page.close();
    }

    // Forgot password: privacy-preserving confirmation, recover call only on submit.
    {
      const page = await newPage({ w, h, api: (p) => (p === "/auth/v1/recover" ? { status: 200, body: {} } : undefined) });
      await page.goto(`${APP}/login`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#login-email");
      await settle(page);
      await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Forgot password?").click());
      await page.waitForFunction(() => /Send reset link/.test(document.body.textContent));
      const fileForm = await shot(page, 3, "forgot-form");
      await page.type("#login-email", "fixture.user@example.invalid");
      await page.click('[data-testid="login-auth-card"] button[type="submit"]');
      await page.waitForSelector('[data-testid="auth-email-sent"]');
      const text = await page.$eval('[data-testid="auth-email-sent"]', (e) => e.textContent);
      const file = await shot(page, 3, "forgot-sent");
      record(3, {
        case: "forgot password: neutral 'if an account exists' confirmation",
        width: w,
        pass: /If an account exists/.test(text) && (page.authCalls || []).filter((c) => c.includes("/recover")).length === 1,
        detail: { authCalls: page.authCalls },
        screenshot: [fileForm, file],
      });
      await page.close();
    }

    // Signup: verification required (no session) and a short password rejected client-side.
    {
      const page = await newPage({
        w,
        h,
        api: (p) =>
          p === "/auth/v1/signup"
            ? { status: 200, body: { id: "00000000-0000-4000-8000-0000000000b1", email: "fixture.new@example.invalid", aud: "authenticated", role: "", identities: [], created_at: "2026-01-01T00:00:00Z" } }
            : undefined,
      });
      await page.goto(`${APP}/signup`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#signup-email");
      await settle(page);
      await page.type("#signup-email", "fixture.new@example.invalid");
      await page.type("#signup-password", "short");
      await page.click('[data-testid="signup-auth-card"] button[type="submit"]');
      await page.waitForSelector('[data-testid="auth-error-banner"]');
      const weak = await page.$eval('[data-testid="auth-error-banner"]', (e) => e.textContent.trim());
      const fileWeak = await shot(page, 3, "signup-short-password");
      const callsAfterWeak = (page.authCalls || []).length;
      await page.click("#signup-password", { clickCount: 3 });
      await page.type("#signup-password", "fixture-password-long-1");
      await page.click('[data-testid="signup-auth-card"] button[type="submit"]');
      await page.waitForSelector('[data-testid="auth-email-sent"]');
      const file = await shot(page, 3, "signup-verify-email");
      record(3, {
        case: "signup: short password blocked before any SDK call; verification-required shows check-your-email",
        width: w,
        pass: /at least 8 characters/.test(weak) && callsAfterWeak === 0 && (page.authCalls || []).filter((c) => c.includes("/signup")).length === 1,
        detail: { weak, authCalls: page.authCalls },
        screenshot: [fileWeak, file],
      });
      await page.close();
    }

    // Reset page: expired link (no session) and valid recovery session form.
    {
      let page = await newPage({ w, h });
      await page.goto(`${APP}/auth/reset-password`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => /invalid or has expired/.test(document.body.textContent), { timeout: 20000 });
      const fileExpired = await shot(page, 3, "reset-expired");
      await page.close();
      page = await newPage({ w, h, kind: "new" });
      await page.goto(`${APP}/auth/reset-password`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#reset-password", { timeout: 20000 });
      await page.type("#reset-password", "short");
      await page.click('button[type="submit"]');
      await page.waitForSelector("#reset-error-msg");
      const fileForm = await shot(page, 3, "reset-form-error");
      record(3, {
        case: "reset password: expired link has no form; recovery session shows the form and validates length",
        width: w,
        pass: (page.authCalls || []).length === 0,
        detail: { authCalls: page.authCalls || [] },
        screenshot: [fileExpired, fileForm],
      });
      await page.close();
    }
  }
}

// ======================================================================= #7 / #10-11 onboarding
const os = require("os");
const fsx = require("fs");
const pathx = require("path");
const FAKE_DIR = fsx.mkdtempSync(pathx.join(os.tmpdir(), "cm715-fixture-"));
const FAKE_PDF = pathx.join(FAKE_DIR, "FIXTURE-cv.pdf");
fsx.writeFileSync(FAKE_PDF, "%PDF-1.4\n% FIXTURE file, not a real resume\n");

const ROLES_5 = [
  "Senior Machine Learning Infrastructure Engineer",
  "Principal Product Designer, Growth and Monetization",
  "Customer Success Operations Manager (EMEA)",
  "Business Intelligence and Data Visualization Analyst",
  "Technical Program Manager, Platform Reliability",
];
const AUTH_1 = "I am authorized to work without sponsorship.";
const AUTH_23 = "I need visa sponsorship. + I have another work permit or authorization.";
const STEP1_FIXTURES = {
  "zero-roles": null,
  "one-role": { roles: ["Data Analyst"], employment_types: ["full-time"], country: "India", country_code: "IN", work_auth: AUTH_1, remote_preference: "remote" },
  "five-long-roles": {
    roles: ROLES_5,
    employment_types: ["full-time", "contract", "internship"],
    country: "United Kingdom of Great Britain and Northern Ireland",
    country_code: "GB",
    work_auth: AUTH_23,
    remote_preference: "onsite",
  },
};

/** Measures one onboarding step: fit, last control vs fixed bar, overflow and target sizes. */
async function measureStep(page, ctaSelector) {
  return page.evaluate((cta) => {
    const ctaEl = document.querySelector(cta);
    let bar = ctaEl;
    while (bar && getComputedStyle(bar).position !== "fixed") bar = bar.parentElement;
    const notice = document.getElementById("cm-cookie-notice");
    const noticeTop = notice ? notice.getBoundingClientRect().top : window.innerHeight;
    // Anything below the fixed bar or the cookie notice is hidden behind them.
    const barTop = Math.min(bar ? bar.getBoundingClientRect().top : window.innerHeight, noticeTop);
    const controls = Array.from(document.querySelectorAll("main button, main input, main a, main [role=button]")).filter(
      (e) => window.__cm.visible(e) && (!bar || !bar.contains(e)) && !e.closest("footer") && !e.closest(".hidden")
    );
    const last = controls[controls.length - 1];
    const vh = window.innerHeight;
    const docH = document.documentElement.scrollHeight;
    // Default view, before any scroll.
    window.scrollTo(0, 0);
    const lastTop0 = last ? last.getBoundingClientRect().bottom : 0;
    // Scrolled to the very end.
    window.scrollTo(0, docH);
    const lr = last ? last.getBoundingClientRect() : null;
    const covered = lr ? lr.bottom > barTop + 0.5 : false;
    const small = controls
      .concat(bar ? Array.from(bar.querySelectorAll("button")) : [])
      .filter((e) => !(e.tagName === "A" && e.parentElement && e.parentElement.textContent.trim() !== e.textContent.trim()))
      .map((e) => ({ label: (e.getAttribute("aria-label") || e.textContent || e.getAttribute("placeholder") || e.tagName).trim().slice(0, 40), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
      .filter((t) => t.h < 44 && !(t.h >= 24 && t.w >= 24 && /^Info about|^Remove /.test(t.label)));
    // Focus each control the way keyboard users reach it; none may land behind the bar or the cookie notice.
    const obscured = []; // entirely hidden = WCAG 2.4.11 AA failure
    const partly = []; // partly behind the bar: allowed at AA, reported
    for (const el of controls) {
      if (el.disabled) continue;
      el.focus();
      const cr = el.getBoundingClientRect();
      const top = Math.min(bar ? bar.getBoundingClientRect().top : vh, notice ? notice.getBoundingClientRect().top : vh);
      if (cr.top >= top - 0.5) obscured.push((el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40));
      else if (cr.bottom > top + 0.5) partly.push((el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40));
    }
    if (document.activeElement) document.activeElement.blur();
    const r = {
      vh,
      docH,
      focusObscured: obscured,
      focusPartlyBehindBar: partly,
      hOverflow: window.__cm.hOverflow(),
      cta: ctaEl ? window.__cm.rect(ctaEl) : null,
      ctaInView: ctaEl ? ctaEl.getBoundingClientRect().bottom <= Math.min(vh, noticeTop) + 0.5 && ctaEl.getBoundingClientRect().top >= 0 : false,
      cookieNotice: notice ? Math.round(noticeTop) : null,
      wideners: window.__cm.hOverflow() > 0 ? window.__cm.wideners() : [],
      barTop: Math.round(barTop),
      lastControl: last ? (last.getAttribute("aria-label") || last.textContent || last.getAttribute("placeholder") || "").trim().slice(0, 40) : null,
      lastBottomDefault: Math.round(lastTop0),
      fitsWithoutScroll: lastTop0 <= barTop + 0.5,
      lastBottomScrolled: lr ? Math.round(lr.bottom) : null,
      lastCoveredByBar: covered,
      smallTargets: small,
      clipped: window.__cm.clipped(document.querySelector("main")).slice(0, 5),
    };
    window.scrollTo(0, 0);
    return r;
  }, ctaSelector);
}

async function tap(page, sel) {
  await page.$eval(sel, (el) => el.scrollIntoView({ block: "center" }));
  await page.click(sel);
}

async function openOnboarding(ctx, { w, h, scale = 2, prefs, api, consent = true, label = "" }) {
  ctx.stubState.prefs.new = prefs;
  // Finish must never be pressed by these captures: any save attempt is a FAIL with the case name.
  const guarded = async (p, u, req) => {
    if (p === "/api/onboarding") {
      ctx.record(7, { case: `FINISH CALLED during ${label} @${w}x${h}`, pass: false });
      return { status: 500, body: { error: "FIXTURE: finish is never called" } };
    }
    return api ? api(p, u, req) : undefined;
  };
  const page = await ctx.newPage({ w, h, scale, kind: "new", api: guarded, consent });
  await page.goto(`${ctx.APP}/onboarding`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="btn-onboarding-step1-next-mobile"]', { timeout: 60000 });
  await ctx.settle(page);
  await ctx.probe(page);
  return page;
}

async function item7(ctx) {
  const { shot, record, WIDTHS, flag } = ctx;
  const CTA1 = '[data-testid="btn-onboarding-step1-next-mobile"]';
  const CTA2 = '[data-testid="btn-onboarding-finish-mobile"]';
  const variants = (w, h) => [
    { tag: "", w, h, scale: 2 },
    { tag: "first-visit", w, h, scale: 2, consent: false },
    { tag: "keyboard", w, h: KEYBOARD[w], scale: 2 },
    { tag: "zoom200", w: Math.round(w / 2), h: Math.round(h / 2), scale: 4 },
  ];
  for (const { w, h } of WIDTHS) {
    // Step 1 is the same with the flag on or off; measure it once (flag ON run).
    if (flag === "on") {
      for (const [fx, prefs] of Object.entries(STEP1_FIXTURES)) {
        for (const v of variants(w, h)) {
          if (v.tag && fx !== "five-long-roles") continue; // stress variants on the heaviest fixture
          const page = await openOnboarding(ctx, { w: v.w, h: v.h, scale: v.scale, prefs, consent: v.consent !== false, label: `step1-${fx}-${v.tag}` });
          const m = await measureStep(page, CTA1);
          const name = `step1-${fx}${v.tag ? "-" + v.tag : ""}`;
          const files = [await shot(page, 7, name, `device ${w}`)];
          if (m.docH > m.vh) {
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
            files.push(await shot(page, 7, `${name}-end`, `device ${w}`));
          }
          const isDefault = !v.tag && fx === "zero-roles";
          const pass =
            m.hOverflow <= 0 &&
            m.focusObscured.length === 0 &&
            !m.lastCoveredByBar &&
            m.smallTargets.length === 0 &&
            m.clipped.length === 0 &&
            m.ctaInView &&
            (isDefault && w === 390 ? m.fitsWithoutScroll : true);
          record(7, { case: `${name} (Step 1)${isDefault && w === 390 ? " default must fit" : ""}`, width: `${w}${v.tag ? "/" + v.tag : ""}`, pass, detail: m, screenshot: files });
          await page.close();
        }
      }
    }
    // Step 2: empty, input, error; flag ON and OFF.
    const states = flag === "on" ? ["empty", "input", "error"] : ["empty"];
    for (const state of states) {
      for (const v of variants(w, h)) {
        if (v.tag && state !== "error") continue;
        const page = await openOnboarding(ctx, {
          w: v.w,
          h: v.h,
          scale: v.scale,
          consent: v.consent !== false,
          label: `step2-${flag}-${state}-${v.tag}`,
          prefs: STEP1_FIXTURES["one-role"],
          api: (p) => (p === "/api/onboarding/resume" ? { status: 500, body: { error: "We couldn't read that file (FIXTURE)." } } : undefined),
        });
        await tap(page, CTA1);
        await page.waitForSelector(CTA2);
        await ctx.settle(page, 300);
        if (state === "input") await page.type('[data-testid="input-linkedin-url-mobile"]', "https://www.linkedin.com/in/fixture-user");
        if (state === "error") {
          await page.type('[data-testid="input-linkedin-url-mobile"]', "https://www.linkedin.com/company/fixture");
          await tap(page, '[data-testid="btn-save-linkedin-mobile"]');
          const input = await page.$('[data-testid="input-resume-file-mobile"]');
          await input.uploadFile(FAKE_PDF);
          await page.waitForSelector('[data-testid="resume-error-mobile"]');
        }
        await new Promise((r) => setTimeout(r, 1500)); // let entrance animations finish before measuring
        await probe2(page);
        const m = await measureStep(page, CTA2);
        const name = `step2-${flag}-${state}${v.tag ? "-" + v.tag : ""}`;
        const files = [await shot(page, 7, name, `device ${w}`)];
        if (m.docH > m.vh) {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          files.push(await shot(page, 7, `${name}-end`, `device ${w}`));
        }
        const isDefault = !v.tag && state === "empty";
        const pass =
          m.hOverflow <= 0 && m.focusObscured.length === 0 && !m.lastCoveredByBar && m.smallTargets.length === 0 && m.clipped.length === 0 && m.ctaInView && (isDefault && w === 390 ? m.fitsWithoutScroll : true);
        record(7, { case: `${name} (Step 2, flag ${flag})${isDefault && w === 390 ? " default must fit" : ""}`, width: `${w}${v.tag ? "/" + v.tag : ""}`, pass, detail: m, screenshot: files });
        await page.close();
      }
    }
  }
  async function probe2(page) {
    await ctx.probe(page);
  }
}

async function item10(ctx) {
  const { shot, record, WIDTHS, flag } = ctx;
  const CTA1 = '[data-testid="btn-onboarding-step1-next-mobile"]';
  const CTA2 = '[data-testid="btn-onboarding-finish-mobile"]';
  const RESUME_OK = { status: 200, body: { fileName: "FIXTURE-cv.pdf", parse: { status: "parsed", jobTitle: "Data Analyst", skillsCount: 12, yearsOfExperience: 4 } } };
  const scenarios =
    flag === "on"
      ? [
          ["empty", null],
          ["populated", RESUME_OK],
          ["error", { status: 500, body: { error: "We couldn't read that file (FIXTURE)." } }],
          ["pending", { hang: true }],
        ]
      : [["empty", null]];
  for (const { w, h } of WIDTHS) {
    for (const [state, resumeResponse] of scenarios) {
      const calls = [];
      const page = await openOnboarding(ctx, {
        w,
        h,
        prefs: STEP1_FIXTURES["one-role"],
        api: (p) => {
          if (p === "/api/onboarding/resume") return calls.push(p), resumeResponse;
          if (p === "/api/onboarding/linkedin") return calls.push(p), { status: 200, body: { linkedinUrl: "https://www.linkedin.com/in/fixture-user" } };
          if (p === "/api/onboarding") return calls.push("FINISH " + p), { status: 500, body: { error: "FIXTURE: finish is never called" } };
          return undefined;
        },
      });
      await tap(page, CTA1);
      await page.waitForSelector(CTA2);
      await ctx.settle(page, 300);
      if (state !== "empty") {
        if (state === "populated") {
          await page.type('[data-testid="input-linkedin-url-mobile"]', "https://www.linkedin.com/in/fixture-user");
          await tap(page, '[data-testid="btn-save-linkedin-mobile"]');
          await page.waitForFunction(() => /Update your LinkedIn URL/.test(document.querySelector('[data-testid="btn-save-linkedin-mobile"]').textContent));
        }
        const input = await page.$('[data-testid="input-resume-file-mobile"]');
        await input.uploadFile(FAKE_PDF);
        if (state === "populated") await page.waitForSelector('[data-testid="resume-success-mobile"]');
        if (state === "error") await page.waitForSelector('[data-testid="resume-error-mobile"]');
        if (state === "pending") await page.waitForFunction(() => /Uploading and reading/.test(document.querySelector('[data-testid="resume-dropzone-mobile"]').textContent));
      }
      await new Promise((r) => setTimeout(r, 400));
      await ctx.probe(page);
      const m = await page.evaluate((cta) => {
        const btn = document.querySelector(cta);
        const r = btn.getBoundingClientRect();
        const visibleSkips = Array.from(document.querySelectorAll("button, a")).filter(
          // The page-level "Skip to content" a11y link is not a step action.
          (b) => window.__cm.visible(b) && !(b.tagName === "A" && (b.getAttribute("href") || "").startsWith("#")) && (/skip/i.test(b.textContent) || /skip/i.test(b.getAttribute("aria-label") || ""))
        );
        btn.focus();
        const heading = document.getElementById("resume-card-title-mobile");
        const card = document.querySelector('[data-testid="card-resume-mobile"]');
        return {
          action: btn.textContent.trim(),
          disabled: btn.disabled,
          focusable: document.activeElement === btn || btn.disabled,
          rightGap: Math.round(window.innerWidth - r.right),
          bottomGap: Math.round(window.innerHeight - r.bottom),
          h: Math.round(r.height),
          visibleSkipCount: visibleSkips.length,
          heading: heading && heading.textContent.trim(),
          guidance: card ? /PDF or DOCX, up to 5 MB\. Stored privately\./.test(card.textContent) : null,
          noPdfDirective: !/Save to PDF|LinkedIn PDF|e\.g\./.test(document.querySelector("main .lg\\:hidden").textContent),
          urlLabel: (document.querySelector('[data-testid="input-linkedin-url-mobile"]') || {}).ariaLabel || null,
        };
      }, CTA2);
      const name = `step2-${flag}-${state}`;
      const file = await shot(page, 10, name);
      const expectAction = state === "populated" ? "Finish" : "Skip for now";
      const pass =
        m.action === expectAction &&
        m.visibleSkipCount === (state === "populated" ? 0 : 1) &&
        m.rightGap <= 24 &&
        m.bottomGap <= 32 &&
        m.h >= 44 &&
        (state === "pending" ? m.disabled : !m.disabled && m.focusable) &&
        (flag === "on" ? m.heading === (state === "populated" ? "FIXTURE-cv.pdf" : "Upload CV/resume") && m.guidance && m.noPdfDirective && Boolean(m.urlLabel) : true) &&
        !calls.some((c) => c.startsWith("FINISH"));
      record(10, { case: `${name}: one bottom-right ${expectAction}`, width: w, pass, detail: { ...m, calls }, screenshot: file });
      await page.close();
    }
  }
}

module.exports = {
  flagOn: ["7", "10"],
  alsoOff: ["7", "10"],
  run: { 3: item3, 7: item7, 10: item10, ...require("./capture-cm-mobile-715.jobs.cjs"), ...require("./capture-cm-mobile-715.pricing.cjs") },
};
