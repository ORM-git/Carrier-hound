/* Jobs scenarios (#12 #14 #20 #21) for scripts/capture-cm-mobile-715.cjs. FIXTURE data only. */

const NOW = Date.now();
const PROTECTED = { name: "Qwyzzlenex Orbital", domain: "qwyzzlenex-orbital.invalid" };
const LONG_SALARY = "₹1,20,00,000 – ₹2,40,00,000 per year";
const LONG_ORIGINAL = "USD 144,000 – 288,000 per year, base before bonus";

/** FIXTURE job in the list (LiveJob) shape. All values are invented. */
function fxJob(i, over = {}) {
  return {
    id: `fx-${i}`,
    title: `Fixture Data Analyst ${i}`,
    company: `Fixturecorp ${i}`,
    location: "Bengaluru, Karnataka, India",
    date: new Date(NOW - i * 3600_000).toISOString(),
    postedAt: new Date(NOW - i * 3600_000).toISOString(),
    salary: "₹12L – ₹18L",
    category: "engineering",
    remote: false,
    remoteScope: "onsite",
    country: "IN",
    type: "full-time",
    directSource: true,
    applyUrl: `https://careers.fixture-${i}.invalid/apply`,
    description: "FIXTURE description. ".repeat(12),
    skills: ["SQL", "Python", "Tableau"],
    logoUrl: null,
    matchScore: 60 + (i % 30),
    ...over,
  };
}
const toRow = (j) => ({
  id: j.id,
  title: j.title,
  company: j.company,
  location: j.location,
  remote: j.remote,
  remote_scope: j.remoteScope,
  posted_at: j.postedAt,
  salary_display: j.salary,
  salary_original: j.salary_original,
  category: j.category,
  description: j.description,
  skills: j.skills,
  job_type: j.type,
  apply_url: j.applyUrl,
  logo_url: j.logoUrl,
  status: j.status || "active",
  matchScore: j.matchScore,
});

/** Fixture answers for the jobs endpoints. `pages` = array of job arrays; `list(page)` may override. */
function jobsApi({ pages = [[]], byId = {}, list } = {}) {
  const all = Object.fromEntries(pages.flat().map((j) => [j.id, j]));
  Object.assign(all, byId);
  const calls = [];
  const api = (p, u) => {
    if (p === "/api/jobs/recommended" || (p === "/api/jobs/search" && !u.searchParams.get("id"))) {
      const n = Number(u.searchParams.get("page") || 1);
      calls.push(n);
      if (list) {
        const r = list(n, u);
        if (r) return r;
      }
      const jobs = pages[n - 1] || [];
      const more = n < pages.length;
      return { status: 200, body: { jobs, totalCount: more ? n * 25 + 1 : (n - 1) * 25 + jobs.length, hasNextPage: more } };
    }
    if (p === "/api/jobs/search" && u.searchParams.get("id")) {
      const j = all[u.searchParams.get("id")];
      return { status: 200, body: { jobs: j ? [j] : [] } };
    }
    if (p === "/api/jobs/pro") {
      const j = all[u.searchParams.get("id")];
      return j ? { status: 200, body: { job: toRow(j) } } : { status: 404, body: { error: "not found" } };
    }
    if (p.startsWith("/api/jobs/")) return { status: 200, body: { jobs: [] } };
    return undefined;
  };
  api.calls = calls;
  return api;
}

async function openJobs(ctx, { w, h, kind = null, api, url = "/jobs" }) {
  const page = await ctx.newPage({ w, h, kind, api });
  await page.goto(`${ctx.APP}${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="jobs-main-content"]', { timeout: 90000 });
  // Measure the settled state, not the skeleton (Pro status and tracker load first), unless loading is the case.
  if (!url.includes("__loading")) await page.waitForFunction(() => !document.querySelector('[data-testid="jobs-skeleton-list"]'), { timeout: 60000 }).catch(() => {});
  await ctx.settle(page, 900);
  await ctx.probe(page);
  return page;
}

const visibleTitles = (page) =>
  page.evaluate(() => new Set(Array.from(document.querySelectorAll("article h2")).filter((e) => e.offsetParent !== null).map((e) => e.textContent)).size);

/** Feed geometry at the top of the page and at its end. */
async function feedGeometry(page) {
  return page.evaluate(() => {
    window.scrollTo(0, 0);
    const vw = document.documentElement.clientWidth;
    const cards = Array.from(document.querySelectorAll("article")).filter((a) => window.__cm.visible(a));
    const first = cards[0] ? window.__cm.rect(cards[0]) : null;
    const nav = document.querySelector('[data-testid="app-mobile-nav"]');
    const tabs = document.querySelector('[data-testid="mobile-feed-tabs"]');
    const firstTop = first ? first.y : null;
    const topControls = Array.from(document.querySelectorAll("header button, header a, main button"))
      .filter((b) => window.__cm.visible(b) && b.getBoundingClientRect().bottom <= (firstTop ?? 200) && b.getBoundingClientRect().top >= 0)
      .map((b) => ({ label: (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 24), h: Math.round(b.getBoundingClientRect().height), hit: b }));
    // Effective touch target (includes ::after hit areas), measured with elementFromPoint.
    for (const c of topControls) { if (c.h < 44) { const e = window.__cm.hit(c.hit); c.h = Math.min(e.h, e.w); } delete c.hit; }
    window.scrollTo(0, 0);
    const stateEl =
      document.querySelector('[data-testid="jobs-skeleton-list"], [data-testid="search-degraded-state"]') ||
      Array.from(document.querySelectorAll("main h3")).find((x) => /^No /.test(x.textContent))?.parentElement;
    const stateRect = stateEl ? window.__cm.rect(stateEl) : null;
    window.scrollTo(0, document.documentElement.scrollHeight);
    const navTop = nav && window.__cm.visible(nav) ? nav.getBoundingClientRect().top : window.innerHeight;
    const listEls = Array.from(
      document.querySelectorAll('article, [data-testid="jobs-list-end"], [data-testid="jobs-load-more-sentinel"] ~ button, [data-testid="search-degraded-state"], [data-testid="jobs-skeleton-list"]')
    ).filter((e) => window.__cm.visible(e));
    const lastEl = listEls[listEls.length - 1] || stateEl;
    const footer = Array.from(document.querySelectorAll("footer")).find((f) => window.__cm.visible(f));
    const lastBottom = lastEl ? lastEl.getBoundingClientRect().bottom : null;
    const footerTop = footer ? footer.getBoundingClientRect().top : null;
    const r = {
      vw,
      hOverflow: window.__cm.hOverflow(),
      cards: cards.length,
      firstCardY: firstTop,
      gutterLeft: first ? first.x : stateRect ? stateRect.x : null,
      gutterRight: first ? vw - first.right : stateRect ? vw - stateRect.right : null,
      tabsH: tabs ? Math.round(tabs.getBoundingClientRect().height) : null,
      smallTopControls: topControls.filter((c) => c.h < 44),
      stateBox: stateRect,
      lastContentBottomAtEnd: lastBottom != null ? Math.round(lastBottom) : null,
      footerGapAtEnd: lastBottom != null && footerTop != null ? Math.round(footerTop - lastBottom) : null,
      navTop: Math.round(navTop),
      // With no footer below the list, the last list element must stay above the fixed bottom nav.
      lastCoveredByNav: lastBottom != null && footerTop == null ? lastBottom > navTop + 0.5 : false,
    };
    window.scrollTo(0, 0);
    return r;
  });
}

function spacingPass(g, { expectCards }) {
  const gutter = (x) => x != null && x >= 15 && x <= 17;
  return (
    g.hOverflow <= 0 &&
    g.smallTopControls.length === 0 &&
    gutter(g.gutterLeft) &&
    gutter(g.gutterRight) &&
    !g.lastCoveredByNav &&
    (g.footerGapAtEnd == null || g.footerGapAtEnd <= 160) &&
    (expectCards ? g.cards >= 1 && Math.abs(g.firstCardY - 135) <= 12 : true)
  );
}

const appRow = (jobId, stage, notes = null, title = "Fixture Data Analyst 4") => ({
  id: `app-${jobId}`,
  job_id: jobId,
  company: "Fixturecorp",
  title,
  stage,
  notes,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
});

async function item12(ctx) {
  const { shot, record, WIDTHS } = ctx;
  const p25 = Array.from({ length: 25 }, (_, k) => fxJob(k + 1));
  const states = [
    ["loading", { api: () => jobsApi({ list: () => ({ hang: true }) }), url: "/jobs?__loading=1", cards: false }],
    ["populated-25", { api: () => jobsApi({ pages: [p25, [fxJob(26)]] }), cards: true }],
    ["short-3", { api: () => jobsApi({ pages: [p25.slice(0, 3)] }), cards: true }],
    ["filter-zero", { api: () => jobsApi({ pages: [[]] }), url: "/jobs?workModel=hybrid", cards: false }],
    ["error", { api: () => jobsApi({ list: () => ({ status: 503, body: { degraded: true } }) }), cards: false }],
    ["saved-empty", { kind: "pro", url: "/jobs?tab=saved", api: () => jobsApi({ pages: [p25] }), cards: false }],
    ["applied-one", { kind: "pro", url: "/jobs?tab=applied", api: () => jobsApi({ pages: [p25] }), apps: [appRow("fx-4", "applied")], cards: true }],
  ];
  for (const { w, h } of WIDTHS) {
    for (const [name, s] of states) {
      ctx.stubState.apps.pro = s.apps || [];
      const api = s.api();
      const page = await openJobs(ctx, { w, h, kind: s.kind || null, api, url: s.url });
      if (name === "loading") await page.waitForSelector('[data-testid="jobs-skeleton-list"]');
      const g = await feedGeometry(page);
      const files = [await shot(page, 12, name)];
      if (name === "populated-25" || name === "applied-one") {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await new Promise((r) => setTimeout(r, 500));
        files.push(await shot(page, 12, `${name}-end`));
      }
      if (name === "error") {
        const before = api.calls.length;
        const retry = await page.$('[data-testid="search-degraded-state"] button');
        g.retryH = retry ? Math.round((await retry.boundingBox()).height) : null;
        if (retry) await retry.click();
        await ctx.settle(page, 600);
        g.retryRequested = api.calls.length > before;
      }
      const pass =
        spacingPass(g, { expectCards: s.cards }) &&
        (name === "error" ? g.retryH >= 44 && g.retryRequested : true) &&
        (name === "applied-one" ? g.cards === 1 : true) &&
        (name === "populated-25" ? g.cards === 25 : true);
      record(12, { case: name, width: w, pass, detail: g, screenshot: files });
      await page.close();
    }
  }
  ctx.stubState.apps.pro = [];
}

async function item14(ctx) {
  const { shot, record, WIDTHS, APP } = ctx;
  const locked = (i) =>
    fxJob(i, { company: PROTECTED.name, companyDomain: PROTECTED.domain, logoUrl: `https://cdn.${PROTECTED.domain}/brand/logo.png`, applyUrl: `https://careers.${PROTECTED.domain}/j/${i}` });
  const leak = (s) => new RegExp(`qwyzzlenex|orbital|${PROTECTED.domain.replace(/\./g, "\\.")}|unavatar\.io\/[a-z0-9]`, "i").test(s);
  for (const { w, h } of WIDTHS) {
    for (const [who, kind, jobs] of [
      ["guest", null, [locked(1), locked(2), fxJob(3, { company: PROTECTED.name, logoUrl: null, companyDomain: null })]],
      ["free", "free", [locked(1), locked(2)]],
      ["pro", "pro", [fxJob(1, { logoUrl: `${APP}/__fixture/logo-pro-1` }), fxJob(2, { logoUrl: `${APP}/__fixture/logo-pro-2` }), fxJob(3, { logoUrl: `${APP}/__fixture/missing-3.png` }), fxJob(4, { logoUrl: null })]],
    ]) {
      const page = await openJobs(ctx, { w, h, kind, api: jobsApi({ pages: [jobs] }) });
      await ctx.settle(page, 600);
      const feed = await page.evaluate(() => ({
        html: document.documentElement.outerHTML,
        a11y: Array.from(document.querySelectorAll("[aria-label],[alt],[title]")).map((e) => [e.getAttribute("aria-label"), e.getAttribute("alt"), e.getAttribute("title")].join(" ")).join(" "),
        silhouettes: Array.from(document.querySelectorAll('[data-testid="company-logo-locked"]')).filter((e) => window.__cm.visible(e)).length,
        imgs: Array.from(document.querySelectorAll("main img")).filter((i) => window.__cm.visible(i)).map((i) => i.getAttribute("src")),
        brokenImgs: Array.from(document.querySelectorAll("main img")).filter((i) => window.__cm.visible(i) && i.complete && i.naturalWidth === 0).length,
      }));
      const feedShot = await shot(page, 14, `${who}-feed`);
      await page.$$eval("article h2", (els) => els.find((e) => e.offsetParent !== null)?.click());
      await ctx.settle(page, 900);
      const detail = await page.evaluate(() => ({
        html: document.documentElement.outerHTML,
        silhouettes: Array.from(document.querySelectorAll('[data-testid="company-logo-locked"]')).filter((e) => window.__cm.visible(e)).length,
      }));
      const detailShot = await shot(page, 14, `${who}-detail`);
      const net = page.requests.map((r) => r.url).filter(leak);
      const isLocked = who !== "pro";
      const pass = isLocked
        ? !leak(feed.html) && !leak(detail.html) && !leak(feed.a11y) && net.length === 0 && feed.silhouettes >= jobs.length && detail.silhouettes >= 1
        : feed.silhouettes === 0 && feed.imgs.some((s) => (s || "").includes("/__fixture/logo-pro-")) && feed.brokenImgs === 0 && /Fixturecorp 1/.test(feed.html);
      record(14, {
        case: `${who}: ${isLocked ? "no protected name/initial/domain/logo in DOM, a11y attributes or network" : "genuine logos, neutral fallback for missing/broken"}`,
        width: w,
        pass,
        detail: { leakContext: [feed.html, detail.html, feed.a11y].map((t) => { const m = t.match(/.{0,120}(qwyzzlenex|orbital|unavatar).{0,80}/i); return m ? m[0] : null; }), silhouettesFeed: feed.silhouettes, silhouettesDetail: detail.silhouettes, protectedRequests: net, imgs: feed.imgs.slice(0, 4), brokenImgs: feed.brokenImgs },
        screenshot: [feedShot, detailShot],
      });
      await page.close();
    }
  }
}

async function item20(ctx) {
  const { shot, record, WIDTHS } = ctx;
  const rich = fxJob(1, {
    title: "Fixture Senior Data Analyst, Payments Risk",
    salary: LONG_SALARY,
    salary_original: LONG_ORIGINAL,
    remote: true,
    remoteScope: "hybrid",
    type: "contract",
    category: "data",
    directSource: false,
    postedAt: new Date(NOW - 2 * 3600_000).toISOString(),
    date: new Date(NOW - 2 * 3600_000).toISOString(),
  });
  const peers = Array.from({ length: 5 }, (_, k) => fxJob(k + 2, { category: "data" }));
  const unknown = fxJob(9, { salary: "", location: "", type: "", category: "", postedAt: undefined, date: "" });
  const expired = fxJob(10, { status: "expired", isExpired: true });
  for (const { w, h } of WIDTHS) {
    // Pro, opened from the Applied tab so the user's own tracker note is part of the detail.
    {
      ctx.stubState.apps.pro = [appRow("fx-1", "applied", "FIXTURE private note: follow up Friday.", rich.title)];
      const api = jobsApi({ pages: [[rich, ...peers, unknown]], byId: { [expired.id]: expired } });
      const page = await openJobs(ctx, { w, h, kind: "pro", api });
      const card = await page.evaluate((orig) => {
        const art = Array.from(document.querySelectorAll("article")).find((a) => a.offsetParent !== null && /Payments Risk/.test(a.textContent));
        const vis = Array.from(art.querySelectorAll("div")).find((d) => d.className.includes("sm:hidden") && window.__cm.visible(d)) || art;
        const chip = Array.from(vis.querySelectorAll("span")).find((s) => s.textContent.includes(orig) && s.children.length >= 1 && window.__cm.visible(s)) || null;
        const a = art.getBoundingClientRect();
        const c = chip && chip.getBoundingClientRect();
        const text = vis.innerText;
        return {
          chipInsideCard: c ? c.left >= a.left - 0.5 && c.right <= a.right + 0.5 : false,
          chip: c ? { w: Math.round(c.width), h: Math.round(c.height), right: Math.round(c.right) } : null,
          card: { left: Math.round(a.left), right: Math.round(a.right) },
          hOverflow: window.__cm.hOverflow(),
          clipped: window.__cm.clipped(vis),
          originalVisible: text.includes(orig),
          fields: {
            location: /Bengaluru/.test(text),
            workModel: /Hybrid/.test(text),
            type: /Contract/i.test(text),
            category: /data/i.test(text),
            early: /Early applicant/.test(text),
            date: /ago|hour|Recently|Posted|today/i.test(text),
            source: /Active feed/.test(text),
            match: Boolean(art.querySelector('[data-testid="mobile-card-score"]')),
          },
        };
      }, LONG_ORIGINAL);
      const cardShot = await shot(page, 20, "pro-card-long-salary");
      record(20, { case: "Pro card: long local + original salary readable, every fact kept", width: w, pass: card.chipInsideCard && card.hOverflow <= 0 && card.clipped.length === 0 && card.originalVisible && Object.values(card.fields).every(Boolean), detail: card, screenshot: cardShot });
      await page.close();

      const page2 = await openJobs(ctx, { w, h, kind: "pro", api, url: "/jobs?tab=applied" });
      await page2.$$eval("article h2", (els) => els.find((e) => e.offsetParent !== null && /Payments Risk/.test(e.textContent))?.click());
      await ctx.settle(page2, 1200);
      const detail = await page2.evaluate((orig) => {
        const text = document.querySelector("main").innerText;
        const chip = Array.from(document.querySelectorAll("main li")).find((e) => e.textContent.includes(orig) && window.__cm.visible(e)) || null;
        const rr = chip ? chip.getBoundingClientRect() : null;
        return {
          clipped: chip ? window.__cm.clipped(chip) : ["salary chip not found"],
          chip: rr ? { w: Math.round(rr.width), h: Math.round(rr.height), right: Math.round(rr.right) } : null,
          chipInView: rr ? rr.right <= document.documentElement.clientWidth + 0.5 && rr.left >= -0.5 : false,
          hOverflow: window.__cm.hOverflow(),
          originalVisible: text.includes(orig),
          fields: {
            description: /FIXTURE description/.test(text),
            skills: /Tableau/.test(text),
            company: Boolean(document.getElementById("company-section")),
            notes: window.__cm.visible(document.querySelector('[data-testid="tracker-notes-panel"]')),
            report: Boolean(document.querySelector('[data-testid="report-issue-detail-link"]')),
          },
        };
      }, LONG_ORIGINAL);
      const detailShot = await shot(page2, 20, "pro-detail-long-salary");
      await page2.evaluate(() => document.querySelector('[data-testid="tracker-notes-panel"]')?.scrollIntoView({ block: "center" }));
      const railShot = await shot(page2, 20, "pro-detail-notes");
      record(20, {
        case: "Pro detail (from Applied): long salary wraps; description, skills, Company, notes, report present",
        width: w,
        pass: detail.clipped.length === 0 && detail.chipInView && detail.hOverflow <= 0 && detail.originalVisible && Object.values(detail.fields).every(Boolean),
        detail,
        screenshot: [detailShot, railShot],
      });
      await page2.close();

      // Similar jobs (from the recommended feed) on the detail.
      const page3 = await openJobs(ctx, { w, h, kind: "pro", api });
      await page3.$$eval("article h2", (els) => els.find((e) => e.offsetParent !== null && /Payments Risk/.test(e.textContent))?.click());
      await ctx.settle(page3, 1200);
      const similar = await page3.evaluate(() => {
        // No confirmed resume in this fixture: the score is never invented; the phone must show the resume prompt instead.
        const prompt = Array.from(document.querySelectorAll("a")).find((x) => /see your real match/i.test(x.textContent) && window.__cm.visible(x));
        const match = window.__cm.visible(document.querySelector('[data-testid="mobile-match-score"]')) || Boolean(prompt);
        const hd = Array.from(document.querySelectorAll("h2")).find((x) => x.textContent.trim() === "Similar jobs");
        if (hd) hd.scrollIntoView({ block: "start" });
        return { match, similar: Boolean(hd) && window.__cm.visible(hd) };
      });
      const simShot = await shot(page3, 20, "pro-detail-similar");
      record(20, { case: "Pro detail (from feed): match score or its resume prompt, and Similar jobs, kept on phones", width: w, pass: similar.match && similar.similar, detail: similar, screenshot: simShot });
      await page3.close();
    }
    // Guest locked card, unknown values, expired job.
    {
      const api = jobsApi({ pages: [[rich, unknown]], byId: { [expired.id]: expired } });
      let page = await openJobs(ctx, { w, h, api });
      const locked = await page.evaluate((orig) => {
        const vis = (re) => Array.from(document.querySelectorAll("article")).find((a) => a.offsetParent !== null && re.test(a.textContent));
        const t = vis(/Payments Risk/).innerText;
        const u = (vis(/Analyst 9/) || {}).innerText || "";
        return { salaryMasked: /••••/.test(t) && !t.includes(orig) && !t.includes("1,20,00,000"), locationLocked: /Location locked/.test(t), unknownRendered: /Fixture Data Analyst 9/.test(u) };
      }, LONG_ORIGINAL);
      const lockedShot = await shot(page, 20, "guest-locked-cards");
      record(20, { case: "guest: salary and location locked, original never shown; unknown-value card renders", width: w, pass: locked.salaryMasked && locked.locationLocked && locked.unknownRendered, detail: locked, screenshot: lockedShot });
      await page.close();
      page = await openJobs(ctx, { w, h, kind: "pro", api, url: `/jobs?id=${expired.id}` });
      await page.waitForSelector('[data-testid="job-expired-banner"]', { timeout: 20000 }).catch(() => {});
      const exp = await page.evaluate(() => ({ banner: Boolean(document.querySelector('[data-testid="job-expired-banner"]')), title: /Fixture Data Analyst 10/.test(document.body.innerText) }));
      const expShot = await shot(page, 20, "pro-expired-detail");
      record(20, { case: "expired job: banner shown, facts still readable", width: w, pass: exp.banner && exp.title, detail: exp, screenshot: expShot });
      await page.close();
    }
  }
  ctx.stubState.apps.pro = [];
}

async function item21(ctx) {
  const { shot, record, WIDTHS } = ctx;
  const p1 = Array.from({ length: 25 }, (_, k) => fxJob(k + 1));
  const p2 = Array.from({ length: 10 }, (_, k) => fxJob(k + 26));
  for (const { w, h } of WIDTHS) {
    for (const mode of ["error", "end"]) {
      let failed = false;
      const api = jobsApi({
        pages: [p1, p2],
        list: (n) => (mode === "error" && n === 2 && !failed ? ((failed = true), { status: 500, body: { error: "FIXTURE" } }) : undefined),
      });
      const page = await openJobs(ctx, { w, h, api });
      // Scroll like a person; the sentinel (IntersectionObserver), not a script call, requests page 2.
      for (let k = 0; k < 14; k++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
        await new Promise((r) => setTimeout(r, 200));
      }
      await ctx.settle(page, 800);
      const sel = mode === "error" ? '[data-testid="jobs-load-more-sentinel"] ~ button' : '[data-testid="jobs-list-end"]';
      await page.$eval(sel, (e) => e.scrollIntoView({ block: "center" })).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const g = await page.evaluate((sel) => {
        const btn = document.querySelector('[data-testid="jobs-load-more-sentinel"] ~ button');
        const end = document.querySelector('[data-testid="jobs-list-end"]');
        const nav = document.querySelector('[data-testid="app-mobile-nav"]');
        const el = document.querySelector(sel);
        const r = el ? el.getBoundingClientRect() : null;
        const shown = Array.from(document.querySelectorAll("main *")).filter((e) => e.children.length === 0 && window.__cm.visible(e)).map((e) => e.textContent).join(" ");
        return {
          label: btn ? btn.textContent.trim() : null,
          btnH: btn ? Math.round(btn.getBoundingClientRect().height) : null,
          alert: (document.querySelector('main [role="alert"]') || {}).textContent || null,
          end: end ? end.textContent.trim() : null,
          clearOfNav: r && nav ? r.bottom <= nav.getBoundingClientRect().top + 0.5 : Boolean(r),
          remainingText: /remaining/i.test(shown),
          hOverflow: window.__cm.hOverflow(),
        };
      }, sel);
      g.cards = await visibleTitles(page);
      const file = await shot(page, 21, mode === "error" ? "load-more-error" : "list-end");
      let pass;
      if (mode === "error") {
        pass = g.label === "Retry" && g.btnH >= 44 && /load more/i.test(g.alert || "") && g.clearOfNav && !g.remainingText && api.calls.filter((n) => n === 2).length === 1;
        await page.click('[data-testid="jobs-load-more-sentinel"] ~ button');
        await ctx.settle(page, 800);
        g.afterRetryCards = await visibleTitles(page);
        pass = pass && g.afterRetryCards === 35;
      } else {
        pass = /end of this list/.test(g.end || "") && g.cards === 35 && g.clearOfNav && !g.remainingText && JSON.stringify(api.calls) === "[1,2]";
      }
      record(21, { case: `mobile ${mode} state`, width: w, pass, detail: { ...g, requests: api.calls }, screenshot: file });
      await page.close();
    }
  }
}

module.exports = { 12: item12, 14: item14, 20: item20, 21: item21 };
