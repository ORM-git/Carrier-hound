/* #23 pricing picker captures for scripts/capture-cm-mobile-715.cjs. FIXTURE only: Buy is never pressed. */

async function item23(ctx) {
  const { shot, record, WIDTHS, APP } = ctx;
  for (const { w, h } of WIDTHS) {
    const checkoutCalls = [];
    const api = (p) => {
      if (p.startsWith("/api/billing")) {
        checkoutCalls.push(p);
        return { status: 500, body: { error: "FIXTURE: checkout must never start from these captures" } };
      }
      return undefined;
    };
    const page = await ctx.newPage({ w, h, kind: "free", api });
    await page.goto(`${APP}/pricing`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="mobile-plan-picker"]', { timeout: 90000 });
    await ctx.settle(page, 800);
    await ctx.probe(page);
    const state = () =>
      page.evaluate(() => {
        const checked = document.querySelector('[data-testid="mobile-plan-picker"] input:checked');
        const cards = Array.from(document.querySelectorAll("[data-plan-card]")).filter((c) => window.__cm.visible(c));
        const btn = cards[0] && cards[0].querySelector("button[data-plan-code]");
        const consent = document.querySelector('[data-testid="autorenew-consent-checkbox"]');
        const labels = Array.from(document.querySelectorAll('[data-testid="mobile-plan-picker"] label')).map((l) => ({ text: l.innerText.replace(/\s+/g, " "), h: Math.round(l.getBoundingClientRect().height) }));
        return {
          checked: checked && checked.value,
          visibleCards: cards.map((c) => c.getAttribute("data-plan-card")),
          cta: btn ? { code: btn.getAttribute("data-plan-code"), text: btn.textContent.trim(), h: Math.round(btn.getBoundingClientRect().height), disabled: btn.disabled } : null,
          consentVisible: Boolean(consent) && window.__cm.visible(consent),
          consentChecked: consent ? consent.checked : null,
          labels,
          hOverflow: window.__cm.hOverflow(),
          focused: document.activeElement && document.activeElement.value,
        };
      });
    const show = async (name) => {
      await page.$eval('[data-testid="mobile-plan-picker"]', (e) => e.scrollIntoView({ block: "start" }));
      await page.evaluate(() => window.scrollBy(0, -8));
      return shot(page, 23, name);
    };
    // What a finger at the centre of each option actually hits (catches overlapping layout).
    const hitTest = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="mobile-plan-picker"] label')).map((l) => { l.scrollIntoView({ block: "center" }); const r = l.getBoundingClientRect(); const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + r.width / 2, r.bottom - 6]]; return pts.every(([x, y]) => l.contains(document.elementFromPoint(x, y))); }));
    record(23, { case: "every plan option is tappable over its whole height (nothing overlaps it)", width: w, pass: hitTest.every(Boolean), detail: { hitTest } });
    const results = [];
    // Default, then click Weekly, then keyboard ArrowRight to Monthly and Quarterly.
    results.push(["monthly-default", await state(), await show("monthly-default")]);
    await page.$eval('[data-testid="mobile-plan-picker"] input[value="weekly"]', (i) => i.closest("label").scrollIntoView({ block: "center" }));
    await page.click('[data-testid="mobile-plan-picker"] input[value="weekly"] + span');
    results.push(["weekly-click", await state(), await show("weekly-selected")]);
    await page.focus('[data-testid="mobile-plan-picker"] input[value="weekly"]');
    await page.keyboard.press("ArrowRight");
    results.push(["monthly-keyboard", await state(), await show("monthly-selected-keyboard")]);
    await page.keyboard.press("ArrowRight");
    results.push(["quarterly-keyboard", await state(), await show("quarterly-selected-keyboard")]);
    for (const [name, s, file] of results) {
      const want = name.split("-")[0];
      const pass =
        s.checked === want &&
        JSON.stringify(s.visibleCards) === JSON.stringify([want]) &&
        s.cta && s.cta.code === want && s.cta.h >= 48 &&
        s.labels.every((l) => l.h >= 44 && /₹/.test(l.text)) &&
        (want === "monthly" ? s.consentVisible && s.consentChecked === false && s.cta.disabled : !s.consentVisible) &&
        s.hOverflow <= 0 &&
        (name.includes("keyboard") ? s.focused === want : true);
      record(23, { case: `${name}: one card, CTA plan code, consent unchecked, no checkout`, width: w, pass, detail: s, screenshot: file });
    }
    const rzp = page.requests.filter((r) => /razorpay|checkout/i.test(r.url)).map((r) => r.url);
    record(23, { case: "selection made no checkout / billing / Razorpay request", width: w, pass: checkoutCalls.length === 0 && rzp.length === 0, detail: { checkoutCalls, rzp } });
    await page.close();
  }
}

module.exports = { 23: item23 };
