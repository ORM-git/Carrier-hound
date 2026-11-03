/*!
 * CareerMonke feature visuals: drop-in animated web components.
 *
 *   <script src="careermonke-visuals.js" defer></script>
 *   <cm-find-jobs></cm-find-jobs>         1 · Find jobs on company career pages
 *   <cm-tailor-resume></cm-tailor-resume> 2 · Tailor your resume to each role
 *   <cm-job-matches></cm-job-matches>     5 · Personalized job matches
 *
 * Attributes (optional):
 *   compact   hide the built-in heading (use when your page already shows the headline)
 *
 * Behaviour:
 *   - Scales to the width of its container (max 480px wide by default; override with CSS).
 *   - Plays only while on screen, pauses when scrolled away.
 *   - Shows a still, finished frame for visitors who prefer reduced motion.
 *   - Styles live in Shadow DOM, so they can't clash with your site's CSS.
 */
(() => {
  'use strict';

  /* ---------- tiny animation helpers ---------- */
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const ease = x => (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const out = x => 1 - Math.pow(1 - x, 3);
  const back = x => { const c1 = 1.7, c3 = c1 + 1; return x <= 0 ? 0 : 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
  const p = (t, a, b) => clamp((t - a) / (b - a));
  const lerp = (a, b, k) => a + (b - a) * k;
  const count = (t, a, b, from, to) => Math.round(lerp(from, to, out(p(t, a, b))));
  const fmt = n => n.toLocaleString('en-US');

  /* ---------- icons ---------- */
  const TICK = (s = 12, c = '#16A34A', w = 3) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12.5l5 5L19.5 7" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const CROSS = (s = 12, c = '#EF4444', w = 3) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/></svg>`;
  const SPIN = () => `<svg class="spin" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="#6B7280" stroke-width="3" stroke-linecap="round"/></svg>`;
  const PILL_OK = () => `<div class="pill g">${TICK(20, '#111827', 3.2)}</div>`;
  const PILL_NO = () => `<div class="pill r">${CROSS(18, '#111827', 3.2)}</div>`;
  const CHECKING = (id, text = 'Checking') => `<div class="chk" id="${id}">${SPIN()}${text}</div>`;
  const chipHTML = (txt, ok, id) => `<span class="chip" id="${id}"><span class="gl">${ok ? TICK(11) : CROSS(11)}</span>${txt}</span>`;

  /* ---------- element-level effects ---------- */
  function pop(el, t, start, dur = .3) {
    const k = p(t, start, start + dur);
    el.style.opacity = clamp(k * 3);
    el.style.transform = `scale(${back(k)})`;
  }
  function rise(el, t, start, dur = .35, dy = 8) {
    const k = out(p(t, start, start + dur));
    el.style.opacity = k;
    el.style.transform = `translateY(${(1 - k) * dy}px)`;
  }
  function checking(el, t, a, b) {
    const kin = out(p(t, a, a + .25)), kout = p(t, b - .12, b);
    el.style.opacity = kin * (1 - kout);
    el.style.transform = `scale(${1 - .15 * kout})`;
    const s = el.querySelector('.spin'); if (s) s.style.transform = `rotate(${t * 540}deg)`;
  }
  function chip(el, t, at, ok) {
    const k = p(t, at, at + .25);
    const resolved = k > 0;
    el.className = 'chip' + (resolved ? (ok ? ' g' : ' r') : '');
    const g = el.querySelector('.gl');
    g.style.width = resolved ? '11px' : '0px';
    g.style.transform = `scale(${back(k)})`;
    el.style.transform = `scale(${1 + .08 * Math.sin(k * Math.PI)})`;
  }

  /* ---------- shared styles ---------- */
  const CSS = `
:host{display:block;width:100%;max-width:480px;aspect-ratio:480/620;position:relative;overflow:hidden;border-radius:24px;background:#2563EB;contain:content}
:host([compact]){aspect-ratio:480/520}
*{box-sizing:border-box}
.stage{position:absolute;left:0;top:0;width:480px;height:620px;transform-origin:0 0;font-family:Inter,var(--font-inter),system-ui,-apple-system,"Segoe UI",sans-serif;color:#111827;-webkit-font-smoothing:antialiased}
:host([compact]) .stage{height:520px}
.content{position:absolute;inset:0}
.hd{position:absolute;left:24px;right:24px;top:22px}
:host([compact]) .hd{display:none}
.hd .t{display:flex;align-items:center;gap:10px}
.num{width:28px;height:28px;border-radius:50%;background:#fff;color:#090E34;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none}
.hd h2{margin:0;font-size:21px;font-weight:650;letter-spacing:-.01em;color:#fff}
.hd p{margin:8px 0 0;font-size:14.5px;color:#EEF2FF;line-height:1.45}
.card{position:absolute;left:16px;right:16px;top:116px;height:488px;border-radius:22px;background:#fff;overflow:hidden;box-shadow:0 12px 32px rgba(15,23,42,.22)}
:host([compact]) .card{top:16px}
.ch{position:absolute;left:20px;right:20px;top:18px}
.ct{font-size:15.5px;font-weight:600}
.ct span,.nm span{font-weight:400;color:#6B7280;margin-left:4px}
.bar{height:5px;border-radius:3px;background:#EEF0F3;margin-top:14px;overflow:hidden}
.bar i{display:block;height:5px;background:#2563EB;border-radius:3px;width:0}
.meta{display:flex;align-items:center;justify-content:space-between;margin-top:12px;font-size:13px}
.badge{display:inline-block;margin-left:6px;padding:2px 8px;border-radius:999px;background:#DCE6FD;color:#090E34;font-size:11.5px;font-weight:700}
.big{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.big small{font-size:13px;font-weight:400;margin-left:3px}
.row{position:absolute;left:0;right:0;height:78px;padding:0 20px;border-top:1px solid #F0F1F3;display:flex;align-items:center;gap:14px;background:#fff;overflow:hidden}
.logo{width:40px;height:40px;border-radius:10px;color:#fff;font-weight:700;font-size:17px;display:flex;align-items:center;justify-content:center;flex:none}
.nm{font-size:14.5px;font-weight:600;white-space:nowrap}
.chips{display:flex;gap:5px;margin-top:7px;position:relative;height:24px}
.chip{display:inline-flex;align-items:center;gap:5px;padding:0 8px;height:24px;border-radius:7px;font-size:11.5px;white-space:nowrap;background:#F3F4F6;color:#6B7280}
.chip.g{background:#ECFDF3;color:#111827}
.chip.r{background:#FEF0F0;color:#111827}
.chip .gl{display:flex;width:0;overflow:visible}
.right{position:absolute;right:20px;top:50%;transform:translateY(-50%);width:110px;height:36px}
.right>*{position:absolute;right:0;top:0}
.chk{height:34px;padding:0 13px;border-radius:999px;background:#F3F4F6;color:#6B7280;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px;white-space:nowrap}
.pill{width:62px;height:34px;border-radius:999px;display:flex;align-items:center;justify-content:center}
.pill.g{background:#5EE59A}
.pill.r{background:#F26464}
.lbl{font-size:11px;font-weight:700;letter-spacing:.06em;color:#6B7280}
`;

  /* ---------- base element: sizing, looping, visibility, reduced motion ---------- */
  class CMVisual extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }); this._t = 0; this._raf = null; }
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      const root = this.shadowRoot;
      root.innerHTML = `<style>${CSS}${this.extraCSS || ''}</style>
        <div class="stage" aria-hidden="true"><div class="content" id="content">
          <div class="hd"><div class="t"><span class="num">${this.number}</span><h2>${this.title_}</h2></div><p>${this.sub}</p></div>
          <div class="card" id="card">${this.cardHTML()}</div>
        </div></div>`;
      this.$ = id => root.getElementById(id);
      this.stage = root.querySelector('.stage');
      if (!this.hasAttribute('role')) this.setAttribute('role', 'img');
      if (!this.hasAttribute('aria-label')) this.setAttribute('aria-label', this.label);
      this.init();
      this._ro = new ResizeObserver(() => this.fit());
      this._ro.observe(this);
      this.fit();
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq.matches) { this.draw(this.restT); return; }
      this.draw(0);
      this._io = new IntersectionObserver(es => es.forEach(e => (e.isIntersecting ? this.play() : this.pause())), { threshold: .25 });
      this._io.observe(this);
    }
    disconnectedCallback() { this.pause(); if (this._ro) this._ro.disconnect(); if (this._io) this._io.disconnect(); }
    fit() { const w = this.getBoundingClientRect().width || 480; this.stage.style.transform = `scale(${w / 480})`; }
    play() {
      if (this._raf) return;
      let last = performance.now();
      const tick = now => {
        this._t += Math.min(now - last, 100) / 1000; last = now;
        this.draw(this._t % this.T);
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    }
    pause() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = null; }
    draw(t) {
      this.$('content').style.opacity = Math.min(p(t, 0, .2), 1 - p(t, this.T - .4, this.T));
      this.render(t);
    }
  }

  /* ---------- 1 · Find jobs on company career pages ---------- */
  class CMFindJobs extends CMVisual {
    get number() { return 1; }
    get title_() { return 'Find jobs on company career pages'; }
    get sub() { return 'Searches roles posted directly on employer career sites, and drops reposts and expired ads.'; }
    get label() { return 'Animation: job listings are checked at the source. Jobs on the company’s own site get a green tick; a job-board repost and an unverified listing get a red cross and are hidden.'; }
    get T() { return 8.6; }
    get restT() { return 7.4; }
    cardHTML() {
      return `<div class="ch"><div class="ct">Frontend Developer · Bengaluru</div><div class="bar"><i id="bar"></i></div>
        <div class="meta"><span>Scanning company career sites<span class="badge" id="sites">0</span></span><span class="big"><span id="found">0</span><small>found</small></span></div></div>
        <div class="row" id="sum" style="height:56px;opacity:0;font-size:12.5px;color:#4B5563;gap:8px">${CROSS(11)}<span>2 hidden: a job-board repost and an unverified listing</span></div>`;
    }
    init() {
      this.J = [
        { n: 'Frontend Developer', at: '@Lumen Labs', L: 'L', c: '#111827', ok: true, src: 'lumenlabs.com/careers', chips: [['Company site', 1], ['Posted 2h ago', 1]] },
        { n: 'Frontend Developer', at: '@via JobHub', L: 'J', c: '#9CA3AF', ok: false, src: 'jobhub.io/listing/88231', chips: [['Repost', 0], ['Expired 34 days', 0]] },
        { n: 'Frontend Engineer', at: '@Northwind', L: 'N', c: '#2563EB', ok: true, src: 'northwind.com/jobs', chips: [['Company site', 1], ['Open now', 1]] },
        { n: 'UI Developer', at: '@Unknown agency', L: '?', c: '#9CA3AF', ok: false, src: 'no employer link', chips: [['No company source', 0]] },
      ];
      const card = this.$('card');
      this.J.forEach((j, i) => {
        const el = document.createElement('div'); el.className = 'row'; el.id = 'r' + i;
        el.innerHTML = `<div class="logo" style="background:${j.c}">${j.L}</div>
          <div style="min-width:0"><div class="nm">${j.n}<span>${j.at}</span></div>
          <div class="chips"><span id="src${i}" style="position:absolute;left:0;top:4px;font-size:12px;color:#9CA3AF;white-space:nowrap">${j.src}</span>
          <span style="display:flex;gap:5px">${j.chips.map((c, k) => chipHTML(c[0], c[1], `c${i}_${k}`)).join('')}</span></div></div>
          <div class="right">${CHECKING('k' + i)}<div id="v${i}">${j.ok ? PILL_OK() : PILL_NO()}</div></div>`;
        card.appendChild(el);
      });
    }
    render(t) {
      const $ = this.$;
      $('bar').style.width = (out(p(t, .3, 4.4)) * 100) + '%';
      $('sites').textContent = fmt(count(t, .3, 4.4, 0, 4200)) + ' sites';
      $('found').textContent = count(t, .3, 4.4, 0, 126);
      const col = out(p(t, 4.9, 5.7));
      let y = 112;
      this.J.forEach((j, i) => {
        const el = $('r' + i), ap = .5 + i * .35, res = 2.0 + i * .55;
        rise(el, t, ap, .35, 10);
        checking($('k' + i), t, ap + .1, res);
        pop($('v' + i), t, res, .32);
        const srcK = p(t, res - .05, res + .1);
        $('src' + i).style.opacity = 1 - srcK;
        j.chips.forEach((c, k) => { const ch = $(`c${i}_${k}`); chip(ch, t, res + k * .12, c[1]); ch.style.opacity = srcK; });
        let h = 78;
        if (!j.ok) { h = 78 * (1 - col); el.style.opacity = Math.min(+el.style.opacity, 1 - col); }
        el.style.top = y + 'px'; el.style.height = Math.max(h, 0) + 'px';
        el.style.borderTopColor = h < 1 ? 'transparent' : '#F0F1F3';
        y += h;
      });
      const s = $('sum'); s.style.top = y + 'px'; rise(s, t, 5.8, .4, 6);
    }
  }

  /* ---------- 2 · Tailor your resume to each role ---------- */
  class CMTailorResume extends CMVisual {
    get number() { return 2; }
    get title_() { return 'Tailor your resume to each role'; }
    get sub() { return 'Get a resume and cover letter draft matched to the job, using only what’s true about you.'; }
    get label() { return 'Animation: the job’s requirements are checked against a resume. Two resume lines are rewritten, those requirements turn green and the match rises from 41% to 86%. A skill the candidate doesn’t have stays red and is left out.'; }
    get T() { return 9.4; }
    get restT() { return 8.4; }
    get extraCSS() {
      return `.sec{position:absolute;left:0;right:0;padding:14px 20px 0;border-top:1px solid #F0F1F3}
.req{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.req .chip{height:28px;font-size:12.5px;padding:0 10px}
.ln{position:relative;height:40px;margin-top:6px;font-size:13px;line-height:20px}
.ln>div{position:absolute;left:0;top:0;right:0}
.old{color:#6B7280}
.strike{position:absolute;left:0;top:9px;height:1.5px;background:#EF4444;width:0}
.new{color:#111827;font-weight:500}
.hl{background:#ECFDF3;color:#15803D;font-weight:600;border-radius:4px;padding:0 3px}
.st{position:absolute;left:0;right:0;height:60px;border-top:1px solid #F0F1F3;display:flex;align-items:center;justify-content:space-between;padding:0 20px;font-size:14px;font-weight:600}`;
    }
    cardHTML() {
      return `<div class="ch" style="display:flex;justify-content:space-between;align-items:flex-start">
          <div><div class="ct">Frontend Developer<span>@Lumen Labs</span></div>
            <div style="font-size:12.5px;color:#6B7280;margin-top:6px;display:flex;align-items:center;gap:6px"><span id="statx" style="display:flex">${SPIN()}</span><span id="stattxt">Reading the job post</span></div></div>
          <div style="text-align:right"><div class="big" id="pct" style="font-size:26px">0%</div><div style="font-size:11.5px;color:#6B7280">resume match</div></div>
        </div>
        <div class="sec" style="top:90px"><div class="lbl">THE JOB ASKS FOR</div><div class="req" id="req"></div></div>
        <div class="sec" style="top:208px"><div class="lbl">YOUR RESUME</div>
          <div class="ln"><div class="old" id="o0"><span style="position:relative">• Built APIs for the checkout team<span class="strike" id="s0"></span></span></div><div class="new" id="n0"></div></div>
          <div class="ln"><div class="old" id="o1"><span style="position:relative">• Improved the web app’s usability<span class="strike" id="s1"></span></span></div><div class="new" id="n1"></div></div>
        </div>
        <div class="st" id="st0" style="top:340px"><span>Resume tailored</span><div id="p0">${PILL_OK()}</div></div>
        <div class="st" id="st1" style="top:400px"><span>Cover letter drafted</span><div id="p1">${PILL_OK()}</div></div>`;
    }
    init() {
      this.R = [
        { t: 'React', ok: true }, { t: 'TypeScript', ok: true },
        { t: 'GraphQL APIs', ok: false, fix: 4.5 }, { t: 'Accessibility', ok: false, fix: 5.6 },
        { t: 'Team leadership', ok: false, fix: null },
      ];
      this.NEW = [
        ['• Built ', 'GraphQL APIs', ' for the checkout team'],
        ['• Made checkout ', 'accessible', ' (WCAG AA) for screen readers'],
      ];
      this.$('req').innerHTML = this.R.map((r, i) => `<span class="chip" id="q${i}"><span class="gl"></span><span id="qt${i}">${r.t}</span></span>`).join('');
    }
    setChip(el, state, k) {
      el.className = 'chip' + (state ? ' ' + state : '');
      const g = el.querySelector('.gl');
      const want = state === 'g' ? 'g' : state === 'r' ? 'r' : '';
      if (g.dataset.s !== want) { g.innerHTML = want === 'g' ? TICK(12) : want === 'r' ? CROSS(12) : ''; g.dataset.s = want; }
      g.style.width = state ? '12px' : '0px';
      g.style.transform = `scale(${state ? back(k) : 0})`;
    }
    typeIn(el, parts, k) {
      const full = parts.join(''); const n = Math.round(full.length * k); let html = '', used = 0;
      parts.forEach((s, i) => { const take = Math.max(0, Math.min(s.length, n - used)); used += s.length; const piece = s.slice(0, take); if (!piece) return; html += i === 1 ? `<span class="hl">${piece}</span>` : piece; });
      if (el.innerHTML !== html) el.innerHTML = html;
    }
    render(t) {
      const $ = this.$;
      const sp = this.shadowRoot.querySelector('#statx .spin'); if (sp) sp.style.transform = `rotate(${t * 540}deg)`;
      this.R.forEach((r, i) => {
        const el = $('q' + i), ap = .4 + i * .12, sc = 1.4 + i * .3;
        rise(el, t, ap, .3, 6);
        let state = '', k = p(t, sc, sc + .25);
        if (t >= sc) state = r.ok ? 'g' : 'r';
        if (r.fix != null && t >= r.fix) { state = 'g'; k = p(t, r.fix, r.fix + .3); }
        this.setChip(el, state, k);
        const pulse = r.fix != null ? p(t, r.fix, r.fix + .35) : 0;
        el.style.transform += ` scale(${1 + .1 * Math.sin(pulse * Math.PI)})`;
      });
      const q4 = $('qt4'), late = t > 6.3;
      if (q4.dataset.late !== String(late)) { q4.innerHTML = late ? 'Team leadership <span style="color:#6B7280">· not in your history</span>' : 'Team leadership'; q4.dataset.late = String(late); }
      let v = count(t, 1.4, 3.0, 0, 41);
      if (t > 4.4) v = 41 + count(t, 4.4, 4.9, 0, 24);
      if (t > 5.5) v = 65 + count(t, 5.5, 6.0, 0, 21);
      $('pct').textContent = v + '%';
      $('pct').style.color = t > 5.5 ? '#15803D' : (t > 3.0 ? '#DC2626' : '#111827');
      $('stattxt').textContent = t < 3.1 ? 'Reading the job post' : (t < 6.2 ? 'Rewriting with your real experience' : 'Done: 2 gaps fixed, 1 left honest');
      $('statx').style.display = t < 6.2 ? 'flex' : 'none';
      [[3.6, 4.0], [4.7, 5.1]].forEach(([a, b], i) => {
        $('s' + i).style.width = (out(p(t, a, a + .35)) * 100) + '%';
        $('o' + i).style.opacity = 1 - p(t, a + .4, a + .6);
        this.typeIn($('n' + i), this.NEW[i], p(t, a + .5, b + .6));
      });
      ['st0', 'st1'].forEach((id, i) => { rise($(id), t, 6.4 + i * .35, .35, 6); pop($('p' + i), t, 6.6 + i * .35, .3); });
    }
  }

  /* ---------- 5 · Personalized job matches ---------- */
  class CMJobMatches extends CMVisual {
    get number() { return 5; }
    get title_() { return 'Personalized job matches'; }
    get sub() { return 'See how well your skills fit each role, and what’s missing, before you apply.'; }
    get label() { return 'Animation: four jobs get skill checks and a match score. They re-sort so the best fits (92% and 78%) are on top and weak fits fade below.'; }
    get T() { return 9.0; }
    get restT() { return 8.0; }
    get extraCSS() {
      return `.ring{position:absolute;right:20px;top:50%;margin-top:-26px;width:52px;height:52px;display:flex;align-items:center;justify-content:center}
.ring svg{position:absolute;left:0;top:0}
.ring b{position:relative;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.row .body{flex:1;min-width:0;padding-right:62px}`;
    }
    cardHTML() {
      return `<div class="ch"><div class="ct">You: Data Analyst · 3 yrs · SQL, Python</div><div class="bar"><i id="bar"></i></div>
        <div class="meta"><span>Matching you to open roles<span class="badge" id="roles">0</span></span><span class="big"><span id="fits">0</span><small>strong fits</small></span></div></div>`;
    }
    init() {
      this.J = [
        { n: 'Sales Lead', at: '@Zentro', L: 'Z', c: '#9CA3AF', v: 18, chips: [['CRM', 0], ['5 yrs sales', 0], ['Excel', 1]], rank: 3 },
        { n: 'Data Analyst', at: '@Brightline', L: 'B', c: '#2563EB', v: 92, chips: [['SQL', 1], ['Python', 1], ['3 yrs analytics', 1]], rank: 0 },
        { n: 'Data Scientist', at: '@Orbit', L: 'O', c: '#9CA3AF', v: 41, chips: [['Python', 1], ['ML models', 0], ['PhD', 0]], rank: 2 },
        { n: 'BI Analyst', at: '@Northwind', L: 'N', c: '#111827', v: 78, chips: [['SQL', 1], ['Excel', 1], ['Tableau', 0]], rank: 1 },
      ];
      const card = this.$('card');
      this.J.forEach((j, i) => {
        const el = document.createElement('div'); el.className = 'row'; el.id = 'r' + i; el.style.height = '80px';
        el.innerHTML = `<div class="logo" style="background:${j.c}">${j.L}</div>
          <div class="body"><div class="nm">${j.n}<span>${j.at}</span></div><div class="chips">${j.chips.map((c, k) => chipHTML(c[0], c[1], `c${i}_${k}`)).join('')}</div></div>
          <div class="ring" id="rg${i}"><svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="22" fill="none" stroke="#F0F1F3" stroke-width="4"/><circle id="a${i}" cx="26" cy="26" r="22" fill="none" stroke="#D1D5DB" stroke-width="4" stroke-linecap="round" stroke-dasharray="0 139" transform="rotate(-90 26 26)"/></svg><b id="pc${i}">0%</b></div>`;
        card.appendChild(el);
      });
    }
    render(t) {
      const $ = this.$;
      $('bar').style.width = (out(p(t, .3, 4.6)) * 100) + '%';
      $('roles').textContent = fmt(count(t, .3, 4.6, 0, 1860)) + ' roles';
      $('fits').textContent = count(t, .3, 4.6, 0, 38);
      const sk = ease(p(t, 5.3, 6.3));
      this.J.forEach((j, i) => {
        const el = $('r' + i), ap = .5 + i * .25, st = 1.3 + i * .7, good = j.v >= 70;
        el.style.top = lerp(112 + i * 80, 112 + j.rank * 80, sk) + 'px';
        el.style.zIndex = good ? 2 : 1;
        rise(el, t, ap, .3, 10);
        if (!good) el.style.opacity = Math.min(+el.style.opacity, lerp(1, .5, sk));
        j.chips.forEach((c, k) => chip($(`c${i}_${k}`), t, st + k * .18, c[1]));
        const k = out(p(t, st, st + .75)), v = Math.round(j.v * k), done = k >= 1;
        const a = $('a' + i);
        a.setAttribute('stroke-dasharray', `${(v / 100 * 138.2).toFixed(1)} 139`);
        a.setAttribute('stroke', done ? (good ? '#16A34A' : '#EF4444') : '#9CA3AF');
        $('pc' + i).textContent = v + '%';
        $('pc' + i).style.color = done ? (good ? '#15803D' : '#DC2626') : '#111827';
        $('rg' + i).style.transform = `scale(${1 + .12 * Math.sin(p(t, st + .75, st + 1.0) * Math.PI)})`;
      });
    }
  }

  const define = (name, cls) => {
    if (!customElements.get(name)) customElements.define(name, cls);
  };
  define('cm-find-jobs', CMFindJobs);
  define('cm-tailor-resume', CMTailorResume);
  define('cm-job-matches', CMJobMatches);
})();
