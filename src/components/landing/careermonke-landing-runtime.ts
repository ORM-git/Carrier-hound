export function initCareerMonkeLanding(): () => void {
  if (typeof window === "undefined") return () => {};

  const reduce =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  const $ = (id: string) => document.getElementById(id);
  const cleanups: Array<() => void> = [];

  function addListener(
    target: EventTarget | null | undefined,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    if (!target) return;
    target.addEventListener(type, listener, options);
    cleanups.push(() => {
      target.removeEventListener(type, listener, options);
    });
  }

  /* ---------- DEMO (front-end simulation, sample data only) ---------- */
  interface JobData {
    label: string;
    title: string;
    co: string;
    where: string;
    posted: string;
    found: number;
    notLI: number;
    pages: number;
    from: number;
    to: number;
    miss: string[];
    after: string;
  }

  const DATA: Record<string, JobData> = {
    backend:  {label:'Backend', title:'Senior Backend Engineer', co:'Fernway', where:'Remote, worldwide', posted:'3h', found:23, notLI:17, pages:2318, from:68, to:94,
               miss:['Kafka','AWS','gRPC'], after:'Built Node.js and Kafka APIs on AWS for 2M daily payments.'},
    remote:   {label:'Remote', title:'Product Manager', co:'Driftwell', where:'Remote, worldwide', posted:'1h', found:34, notLI:25, pages:2690, from:69, to:94,
               miss:['Roadmapping','SQL','A/B testing'], after:'Owned the roadmap, wrote SQL for weekly metrics and ran A/B tests on onboarding.'},
    marketing:{label:'Marketing', title:'Growth Marketing Manager', co:'Brightside', where:'London, hybrid', posted:'2h', found:24, notLI:18, pages:2240, from:65, to:92,
               miss:['SEO','HubSpot','Paid social'], after:'Ran SEO and paid social campaigns in HubSpot for four product launches.'},
    data:     {label:'Data & AI', title:'Machine Learning Engineer', co:'Quillhaus', where:'Remote, worldwide', posted:'4h', found:19, notLI:14, pages:2412, from:64, to:92,
               miss:['PyTorch','LLMs','MLOps'], after:'Built PyTorch churn models and shipped LLM features with MLOps pipelines.'},
    sales:    {label:'Sales', title:'Account Executive', co:'Ledgerly', where:'Bengaluru, hybrid', posted:'3h', found:29, notLI:21, pages:2115, from:63, to:91,
               miss:['Salesforce','Enterprise deals','Forecasting'], after:'Closed enterprise deals tracked in Salesforce and owned quarterly forecasting.'},
    design:   {label:'Design', title:'Product Designer', co:'Tandemly', where:'Remote, worldwide', posted:'3h', found:21, notLI:15, pages:2133, from:67, to:93,
               miss:['Design systems','Prototyping','User research'], after:'Led user research, prototyping and a design system for the mobile app.'}
  };

  let cur: JobData | null = null;
  let timers: (ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | number)[] = [];
  const states = document.querySelectorAll<HTMLElement>('.demo .state');
  const steps = document.querySelectorAll<HTMLElement>('.steps li');
  const announce = $('announce');

  function clearTimers() {
    timers.forEach((t) => {
      clearTimeout(t as any);
      clearInterval(t as any);
      cancelAnimationFrame(t as number);
    });
    timers = [];
  }

  function later(fn: () => void, ms: number) {
    const t = setTimeout(fn, reduce ? 0 : ms);
    timers.push(t);
    return t;
  }

  function show(name: string, focus?: boolean) {
    states.forEach((s) => { s.hidden = s.getAttribute('data-state') !== name; });
    if (focus) {
      const h = document.querySelector<HTMLElement>('.state[data-state="' + name + '"] .q');
      if (h) h.focus({ preventScroll: true });
    }
  }

  function setStep(i: number) {
    steps.forEach((li, n) => {
      li.className = n < i ? 'done' : (n === i ? 'on' : '');
      if (n === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
  }

  function say(t: string) {
    if (announce) announce.textContent = t;
  }

  function setScore(v: number) {
    const ring = $('ring');
    const scoreNum = $('score-num');
    const score = $('score');
    if (ring) ring.style.strokeDashoffset = (138.2 * (1 - v / 100)).toFixed(1);
    if (scoreNum) scoreNum.textContent = v + '%';
    if (score) score.setAttribute('aria-label', 'Match score ' + v + ' percent');
  }

  function countTo(el: HTMLElement | null, end: number, ms: number, cb?: () => void) {
    if (!el) return;
    if (reduce) {
      el.textContent = end.toLocaleString('en-US');
      if (cb) cb();
      return;
    }
    const t0 = performance.now();
    function tick(now: number) {
      const p = Math.min(1, (now - t0) / ms);
      if (el) el.textContent = Math.round(end * (1 - Math.pow(1 - p, 3))).toLocaleString('en-US');
      if (p < 1) {
        timers.push(requestAnimationFrame(tick));
      } else if (cb) {
        cb();
      }
    }
    timers.push(requestAnimationFrame(tick));
  }

  const bubble = $('bubble');
  const demoEl = document.querySelector<HTMLElement>('.demo');

  function guide(t: string) {
    if (!bubble || bubble.textContent === t) return;
    bubble.textContent = t;
    bubble.classList.remove('pop');
    void bubble.offsetWidth;
    bubble.classList.add('pop');
  }

  function nudge(on: boolean) {
    const act = $('act');
    if (act) act.classList.toggle('nudge', !!on && !reduce);
  }

  if (demoEl) {
    const onDemoTouched = () => { demoEl.classList.add('touched'); };
    ['pointerenter', 'focusin', 'pointerdown'].forEach((ev) => {
      addListener(demoEl, ev, onDemoTouched, { once: true });
    });
  }

  let activeConfetti: HTMLCanvasElement | null = null;
  let confettiReq = 0;

  function confetti() {
    if (reduce || !demoEl) return;
    const c = document.createElement('canvas');
    c.className = 'confetti';
    const host = document.querySelector('.landing-wrapper') || document.body;
    host.appendChild(c);
    activeConfetti = c;
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const x = c.getContext('2d');
    if (!x) return;
    x.scale(dpr, dpr);
    const r = demoEl.getBoundingClientRect();
    const ox = r.left + r.width / 2;
    const oy = r.top + r.height * 0.35;
    const cols = ['#2563EB', '#090E34', '#22C065', '#FFCF3F', '#93B0FF', '#FF6B6B'];
    const P: any[] = [];
    for (let i = 0; i < 140; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
      const v = 6 + Math.random() * 8;
      P.push({
        x: ox,
        y: oy,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        w: 5 + Math.random() * 5,
        h: 8 + Math.random() * 6,
        r: Math.random() * 6,
        vr: (Math.random() - 0.5) * 0.4,
        c: cols[i % cols.length]
      });
    }
    const t0 = performance.now();
    function f(now: number) {
      if (!x) return;
      const t = now - t0;
      x.clearRect(0, 0, W, H);
      P.forEach((p) => {
        p.vy += 0.28;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.r += p.vr;
        x.save();
        x.translate(p.x, p.y);
        x.rotate(p.r);
        x.globalAlpha = Math.max(0, 1 - t / 2600);
        x.fillStyle = p.c;
        x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        x.restore();
      });
      if (t < 2600) {
        confettiReq = requestAnimationFrame(f);
      } else {
        c.remove();
        if (activeConfetti === c) activeConfetti = null;
      }
    }
    confettiReq = requestAnimationFrame(f);
  }

  function pick(key: string) {
    clearTimers();
    cur = DATA[key];
    if (demoEl) demoEl.classList.add('touched');
    guide('Checking career pages…');
    nudge(false);
    setStep(0);
    show('scan', true);
    const scanSub = $('scan-sub');
    const cPages = $('c-pages');
    const cJobs = $('c-jobs');
    const scanBar = $('scan-bar');
    if (scanSub) scanSub.textContent = 'Looking for ' + cur.label + ' jobs that fit you';
    if (cPages) cPages.textContent = '0';
    if (cJobs) cJobs.textContent = '0';
    if (scanBar) scanBar.style.width = '0';
    say('Checking company career pages for ' + cur.label + ' jobs');
    timers.push(
      requestAnimationFrame(() => {
        if (scanBar) {
          scanBar.style.width = '100%';
          scanBar.style.transitionDuration = reduce ? '0s' : '2.2s';
        }
      })
    );
    countTo(cPages, cur.pages, 2200);
    countTo(cJobs, cur.found, 2200);
    later(match, 2500);
  }

  function match() {
    const d = cur;
    if (!d) return;
    setStep(1);
    const found = $('found');
    const jLogo = $('j-logo');
    const jTitle = $('j-title');
    const jMeta = $('j-meta');
    const jPosted = $('j-posted');
    const jGain = $('j-gain');
    const mLabel = $('m-label');
    const mSkills = $('m-skills');
    const mPanel = $('m-panel');
    const tPanel = $('t-panel');
    const act = $('act') as HTMLButtonElement | null;

    if (found) {
      found.textContent = '';
      const b = document.createElement('b');
      b.textContent = d.found + ' jobs found. ';
      found.appendChild(b);
      found.appendChild(document.createTextNode(d.notLI + " aren't on LinkedIn."));
      found.hidden = false;
    }
    if (jLogo) jLogo.textContent = d.co.charAt(0);
    if (jTitle) jTitle.textContent = d.title;
    if (jMeta) jMeta.textContent = d.co + ' · ' + d.where;
    if (jPosted) jPosted.textContent = d.posted + ' ago';
    if (jGain) jGain.textContent = '';
    if (mLabel) mLabel.textContent = d.miss.length + ' skills missing:';
    if (mSkills) {
      mSkills.textContent = '';
      d.miss.forEach((s) => {
        const span = document.createElement('span');
        span.className = 'sk';
        span.textContent = '+ ' + s;
        mSkills.appendChild(span);
      });
    }
    if (mPanel) mPanel.hidden = false;
    if (tPanel) tPanel.hidden = true;
    if (act) {
      act.textContent = 'Tailor my resume';
      act.dataset.next = 'tailor';
      act.disabled = false;
    }
    setScore(0);
    show('match', true);
    guide('Tap “Tailor my resume”');
    nudge(true);
    later(() => { setScore(d.from); }, 60);
    say('Found ' + d.found + ' jobs. Best match is ' + d.title + ' at ' + d.co + ', match score ' + d.from + ' percent.');
  }

  function tailor() {
    const d = cur;
    const act = $('act') as HTMLButtonElement | null;
    if (!d) return;
    setStep(2);
    const mPanel = $('m-panel');
    const found = $('found');
    const tPanel = $('t-panel');
    const tFor = $('t-for');
    const jGain = $('j-gain');
    const line = $('t-line');

    if (mPanel) mPanel.hidden = true;
    if (found) found.hidden = true;
    if (tPanel) tPanel.hidden = false;
    if (tFor) tFor.textContent = '✓ Tailored for ' + d.co + ' · added ' + d.miss.join(', ');
    if (jGain) jGain.textContent = '+' + (d.to - d.from);
    if (act) {
      act.textContent = 'Apply on company site';
      act.dataset.next = 'apply';
      act.disabled = true;
    }
    guide('Tailoring…');
    nudge(false);
    setScore(d.to);
    if (line) {
      line.textContent = '';
      line.className = 'caret';
    }
    say('Resume tailored. Match is now ' + d.to + ' percent.');
    if (reduce) {
      if (line) {
        line.textContent = d.after;
        line.className = '';
      }
      if (act) act.disabled = false;
      guide('Now send it!');
      nudge(true);
      return;
    }
    let i = 0;
    const iv = setInterval(() => {
      i++;
      if (line) line.textContent = d.after.slice(0, i);
      if (i >= d.after.length) {
        clearInterval(iv);
        if (line) line.className = '';
        if (act) act.disabled = false;
        guide('Now send it!');
        nudge(true);
      }
    }, 22);
    timers.push(iv);
  }

  function apply() {
    clearTimers();
    setStep(4);
    const appliedSub = $('applied-sub');
    if (appliedSub && cur) {
      appliedSub.textContent = 'Found early, tailored for the role, and sent straight to ' + cur.co + ". That's the whole hunt.";
    }
    show('applied', true);
    say('Applied in 18 seconds.');
    guide('You did it!');
    nudge(false);
    confetti();
  }

  function reset(focus?: boolean) {
    clearTimers();
    cur = null;
    setStep(0);
    show('pick', false);
    guide('Pick a job type!');
    nudge(false);
    if (focus) {
      const chip = document.querySelector<HTMLElement>('.chip[data-field]');
      if (chip) chip.focus({ preventScroll: true });
    }
  }

  document.querySelectorAll<HTMLElement>('.chip[data-field]').forEach((b) => {
    const onChipClick = () => {
      const field = b.getAttribute('data-field');
      if (field) pick(field);
    };
    addListener(b, 'click', onChipClick);
  });

  const actBtn = $('act');
  if (actBtn) {
    const onActClick = function (this: HTMLElement) {
      if (this.dataset.next === 'tailor') tailor(); else if (this.dataset.next === 'apply') apply();
    };
    addListener(actBtn, 'click', onActClick as EventListener);
  }

  const againBtn = $('again');
  if (againBtn) {
    const onAgainClick = () => { reset(true); };
    addListener(againBtn, 'click', onAgainClick);
  }

  const tryDemo = $('try-demo');
  if (tryDemo) {
    const onTryDemoClick = (e: Event) => {
      e.preventDefault();
      const demo = $('demo');
      if (demo) demo.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      if (cur === null) reset(false);
      const first = document.querySelector<HTMLElement>('.demo .state:not([hidden]) button, .demo .state:not([hidden]) a');
      if (first) {
        const t = setTimeout(() => { first.focus({ preventScroll: true }); }, reduce ? 0 : 350);
        timers.push(t);
      }
    };
    addListener(tryDemo, 'click', onTryDemoClick);
  }

  /* ---------- COMPARISON REVEAL ---------- */
  let compObserver: IntersectionObserver | null = null;
  const vsTable = document.getElementById('vs');
  if (vsTable && !reduce && 'IntersectionObserver' in window) {
    vsTable.classList.add('pre');
    compObserver = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting) {
          vsTable.classList.remove('pre');
          vsTable.classList.add('go');
        } else if (vsTable.classList.contains('go')) {
          vsTable.classList.remove('go');
        }
      });
    }, { threshold: 0.25 });
    compObserver.observe(vsTable);
  }

  /* ---------- FEATURE CARDS (illustrative, sample data) ---------- */
  interface CityItem {
    n: string;
    lat: number;
    lon: number;
    role: string;
    ok: boolean;
    e: string;
    jobs: number;
    nw: number;
  }

  const CITY: CityItem[] = [
    {n:'San Francisco', lat:37.77, lon:-122.42, role:'ML Engineer · On-site', ok:false, e:'Needs US work permit', jobs:48, nw:6},
    {n:'Toronto',  lat:43.65, lon:-79.38, role:'iOS Engineer · Remote (Canada)', ok:false, e:'Needs Canadian work permit', jobs:22, nw:3},
    {n:'London',   lat:51.51, lon:-0.13,  role:'Data Engineer · Hybrid', ok:true, e:'Visa sponsorship offered', jobs:37, nw:5},
    {n:'Berlin',   lat:52.52, lon:13.40,  role:'Backend Engineer · Hybrid', ok:true, e:'Visa sponsorship offered', jobs:29, nw:4},
    {n:'Bengaluru',lat:12.97, lon:77.59,  role:'Frontend Engineer · Hybrid', ok:true, e:'Eligible to apply', jobs:63, nw:9},
    {n:'Singapore',lat:1.35,  lon:103.82, role:'Product Designer · On-site', ok:false, e:'Needs employment pass', jobs:19, nw:2}
  ];

  const cv = document.getElementById('globe') as HTMLCanvasElement | null;
  let gLoopReq = 0;
  let tourT: ReturnType<typeof setInterval> | null = null;
  let globeObserver: IntersectionObserver | null = null;
  const cardObservers: IntersectionObserver[] = [];

  const handleResize = () => {
    if (cv) {
      GS = gSize();
      gDraw();
    }
  };

  let GS = 248;
  let rot = { lon: 0, lat: 22 };
  let gTarget: { lon: number; lat: number } | null = null;
  let gDrag = false;
  let gAuto = !reduce;
  let gLast: [number, number] | null = null;
  let gSel = 2;
  let gMoved = 0;
  let gPulse = 0;
  let pinXY: { i: number; x: number; y: number }[] = [];
  const cyBtns: HTMLButtonElement[] = [];

  function gSize(): number {
    if (!cv) return 248;
    const gx = cv.getContext('2d');
    const s0 = cv.getBoundingClientRect().width || 248;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(s0 * dpr);
    cv.height = Math.round(s0 * dpr);
    if (gx) gx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return s0;
  }

  const D = Math.PI / 180;
  function proj(lat: number, lon: number) {
    const phi = lat * D;
    const lam = (lon + rot.lon) * D;
    const p0 = rot.lat * D;
    return {
      x: Math.cos(phi) * Math.sin(lam),
      y: Math.cos(p0) * Math.sin(phi) - Math.sin(p0) * Math.cos(phi) * Math.cos(lam),
      v: Math.sin(p0) * Math.sin(phi) + Math.cos(p0) * Math.cos(phi) * Math.cos(lam)
    };
  }

  function gDraw() {
    if (!cv) return;
    const gx = cv.getContext('2d');
    if (!gx) return;
    const R = GS / 2 - 4;
    const cx = GS / 2;
    const cy = GS / 2;
    gx.clearRect(0, 0, GS, GS);

    const g = gx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
    g.addColorStop(0, '#24339A');
    g.addColorStop(1, '#090E34');
    gx.fillStyle = g;
    gx.beginPath();
    gx.arc(cx, cy, R, 0, Math.PI * 2);
    gx.fill();

    for (let la = -80; la <= 80; la += 6) {
      for (let lo = -180; lo < 180; lo += 6) {
        const p = proj(la, lo);
        if (p.v <= 0) continue;
        gx.fillStyle = 'rgba(147,176,255,' + (0.12 + 0.55 * p.v).toFixed(2) + ')';
        gx.fillRect(cx + R * p.x - 0.9, cy - R * p.y - 0.9, 1.8, 1.8);
      }
    }

    gx.strokeStyle = 'rgba(147,176,255,.18)';
    gx.lineWidth = 1;
    gx.beginPath();
    gx.arc(cx, cy, R, 0, Math.PI * 2);
    gx.stroke();

    pinXY = [];
    CITY.forEach((c, i) => {
      const p = proj(c.lat, c.lon);
      if (p.v <= 0.02) return;
      const x = cx + R * p.x;
      const y = cy - R * p.y;
      const on = i === gSel;
      pinXY.push({ i, x, y });
      if (on) {
        const pr = 10 + 6 * Math.abs(Math.sin(gPulse));
        gx.fillStyle = 'rgba(37,99,235,.35)';
        gx.beginPath();
        gx.arc(x, y, pr, 0, Math.PI * 2);
        gx.fill();
      }
      gx.fillStyle = on ? '#FFFFFF' : (c.ok ? '#5BE08F' : '#FF8A8A');
      gx.beginPath();
      gx.arc(x, y, on ? 5 : 4, 0, Math.PI * 2);
      gx.fill();
    });

    gx.font = '600 12px system-ui, sans-serif';
    const placed = pinXY.map((pn) => ({ i: pn.i, b: [pn.x - 6, pn.y - 6, pn.x + 6, pn.y + 6] }));
    function hits(box: number[], self: number) {
      return placed.some((q) => q.i !== self && !(box[2] < q.b[0] || box[0] > q.b[2] || box[3] < q.b[1] || box[1] > q.b[3]));
    }

    pinXY.slice().sort((a, b) => (b.i === gSel ? 1 : 0) - (a.i === gSel ? 1 : 0)).forEach((pn) => {
      const c = CITY[pn.i];
      const w = gx.measureText(c.n).width;
      const on = pn.i === gSel;
      if (!on && proj(c.lat, c.lon).v < 0.3) return;
      const opts = [
        [pn.x + 9, pn.y + 4],
        [pn.x - 9 - w, pn.y + 4],
        [pn.x - w / 2, pn.y - 10],
        [pn.x - w / 2, pn.y + 18]
      ];
      for (let k = 0; k < opts.length; k++) {
        const lx = opts[k][0];
        const ly = opts[k][1];
        const box = [lx - 2, ly - 11, lx + w + 2, ly + 3];
        if (box[0] < 2 || box[2] > GS - 2) continue;
        if (!hits(box, pn.i)) {
          placed.push({ i: -1, b: box });
          gx.fillStyle = on ? '#FFFFFF' : 'rgba(255,255,255,.75)';
          gx.fillText(c.n, lx, ly);
          return;
        }
      }
    });
  }

  let glTouch = () => {};
  let tour = () => {};

  if (cv) {
    const glFig = cv.closest<HTMLElement>('.gl');
    GS = gSize();
    addListener(window, 'resize', handleResize);

    let gChoose = (_i: number) => {};

    const wrapC = glFig ? glFig.querySelector<HTMLElement>('.gl-cities') : null;
    if (wrapC) {
      wrapC.textContent = '';
      CITY.forEach((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = c.n;
        b.setAttribute('aria-pressed', i === gSel ? 'true' : 'false');
        const onCityClick = () => { glTouch(); gChoose(i); };
        addListener(b, 'click', onCityClick);
        wrapC.appendChild(b);
        cyBtns.push(b);
      });
    }

    gChoose = (i: number) => {
      gSel = i;
      const c = CITY[i];
      gTarget = { lon: -c.lon, lat: Math.max(-30, Math.min(45, c.lat * 0.7)) };
      if (reduce) {
        rot = { lon: gTarget.lon, lat: gTarget.lat };
        gTarget = null;
      }
      const d = glFig ? glFig.querySelector<HTMLElement>('.gl-detail') : null;
      const cyName = $('cy-name');
      const cyRole = $('cy-role');
      const cyJobs = $('cy-jobs');
      const cyNew = $('cy-new');
      const el = $('cy-elig');

      if (cyName) cyName.textContent = c.n;
      if (cyRole) cyRole.textContent = c.role;
      if (cyJobs) cyJobs.textContent = String(c.jobs);
      if (cyNew) cyNew.textContent = String(c.nw);
      if (el) {
        el.textContent = (c.ok ? '✓ ' : '✕ ') + c.e;
        el.className = 'gl-elig ' + (c.ok ? 'yes' : 'no');
      }
      if (d) {
        d.classList.remove('flash');
        void d.offsetWidth;
        d.classList.add('flash');
      }
      cyBtns.forEach((b, n) => {
        b.setAttribute('aria-pressed', n === i ? 'true' : 'false');
      });
      gDraw();
    };

    let touched = false;
    glTouch = function () {
      touched = true;
      gAuto = false;
      if (tourT) clearInterval(tourT);
      if (glFig) glFig.classList.add('touched');
    };

    tour = function () {
      if (touched || reduce) return;
      if (tourT) clearInterval(tourT);
      tourT = setInterval(() => {
        gChoose((gSel + 1) % CITY.length);
      }, 2800);
    };

    const gLoop = () => {
      gPulse += 0.06;
      if (gTarget) {
        const dl = ((gTarget.lon - rot.lon + 540) % 360) - 180;
        rot.lon += dl * 0.08;
        rot.lat += (gTarget.lat - rot.lat) * 0.08;
        if (Math.abs(dl) < 0.3 && Math.abs(gTarget.lat - rot.lat) < 0.3) {
          rot = { lon: gTarget.lon, lat: gTarget.lat };
          gTarget = null;
        }
      } else if (gAuto && !gDrag && touched) {
        rot.lon += 0.12;
      }
      gDraw();
      gLoopReq = requestAnimationFrame(gLoop);
    };
    gLoopReq = requestAnimationFrame(gLoop);

    addListener(cv, 'pointerdown', ((e: Event) => {
      const pe = e as PointerEvent;
      glTouch();
      gDrag = true;
      gTarget = null;
      gMoved = 0;
      gLast = [pe.clientX, pe.clientY];
      if (typeof cv.setPointerCapture === 'function') {
        cv.setPointerCapture(pe.pointerId);
      }
    }) as EventListener);

    addListener(cv, 'pointermove', ((e: Event) => {
      const pe = e as PointerEvent;
      if (!gDrag || !gLast) return;
      const dx = pe.clientX - gLast[0];
      const dy = pe.clientY - gLast[1];
      gMoved += Math.abs(dx) + Math.abs(dy);
      rot.lon += dx * 0.5;
      rot.lat = Math.max(-60, Math.min(60, rot.lat + dy * 0.35));
      gLast = [pe.clientX, pe.clientY];
    }) as EventListener);

    addListener(cv, 'pointerup', ((e: Event) => {
      const pe = e as PointerEvent;
      gDrag = false;
      if (gMoved < 6) {
        const r = cv.getBoundingClientRect();
        const x = pe.clientX - r.left;
        const y = pe.clientY - r.top;
        let best: number | null = null;
        let bd = 22;
        pinXY.forEach((pn) => {
          const d = Math.hypot(pn.x - x, pn.y - y);
          if (d < bd) {
            bd = d;
            best = pn.i;
          }
        });
        if (best !== null) gChoose(best);
      }
    }) as EventListener);

    addListener(cv, 'pointercancel', (() => { gDrag = false; }) as EventListener);
    gChoose(gSel);

    if (glFig && 'IntersectionObserver' in window) {
      globeObserver = new IntersectionObserver((es) => {
        es.forEach((e) => {
          if (!e.isIntersecting && tourT) clearInterval(tourT);
        });
      });
      globeObserver.observe(glFig);
    }
  }

  function countUp(el: HTMLElement | null, to: number, ms: number) {
    if (!el) return;
    if (reduce) {
      el.textContent = to.toLocaleString('en-US');
      return;
    }
    const t0 = performance.now();
    function f(n: number) {
      if (!el) return;
      const p = Math.min(1, (n - t0) / ms);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))).toLocaleString('en-US');
      if (p < 1 && el.isConnected) timers.push(requestAnimationFrame(f));
    }
    timers.push(requestAnimationFrame(f));
  }

  function headRun(f: HTMLElement, at: (ms: number, fn: () => void) => void, total: number) {
    const tr = f.querySelector<HTMLElement>('.fc-track i');
    const ph = f.querySelectorAll<HTMLElement>('.ph');
    const cnt = f.querySelector<HTMLElement>('.fc-count b');
    if (tr) {
      tr.style.transition = 'none';
      tr.style.width = '0';
    }
    ph.forEach((p, i) => { p.classList.toggle('on', i === 0); });
    if (cnt) {
      cnt.textContent = '0';
      const toVal = +(cnt.dataset.to || 0);
      at(80, () => {
        if (tr) {
          tr.style.transition = 'width 1.6s cubic-bezier(.4,0,.2,1)';
          tr.style.width = '42%';
        }
        countUp(cnt, toVal, total);
      });
    }
    at(Math.round(total * 0.45), () => {
      ph.forEach((p, i) => { p.classList.toggle('on', i === 1); });
      if (tr) {
        tr.style.transition = 'width ' + (total * 0.55 / 1000).toFixed(2) + 's cubic-bezier(.4,0,.2,1)';
        tr.style.width = '100%';
      }
    });
  }

  function setRing(rg: SVGElement | null, _b: any, v: number, color?: string) {
    if (rg) {
      (rg as any).style.strokeDashoffset = (119.4 * (1 - v / 100)).toFixed(1);
      if (color) (rg as any).style.stroke = color;
    }
  }

  const RUN: Record<string, (f: HTMLElement, at: (ms: number, fn: () => void) => void) => void> = {
    city: (_f, at) => { at(600, tour); },
    pages: (f, at) => {
      const rows = Array.from(f.querySelectorAll<HTMLElement>('.fr'));
      const total = 500 + rows.length * 1050 + 400;
      headRun(f, at, total);
      rows.forEach((r) => {
        r.classList.remove('in', 'dim');
        const sp = r.querySelector<HTMLElement>('.sp');
        if (sp) sp.className = 'sp q';
      });
      rows.forEach((r, i) => {
        const t = 400 + i * 1050;
        const sp = r.querySelector<HTMLElement>('.sp');
        const ok = sp ? sp.dataset.ok === '1' : false;
        at(t, () => { r.classList.add('in'); });
        at(t + 300, () => { if (sp) sp.className = 'sp c'; });
        at(t + 1050, () => {
          if (sp) sp.className = 'sp ' + (ok ? 'y' : 'n');
          if (!ok) r.classList.add('dim');
        });
      });
    },
    tailor: (f, at) => {
      const rg = f.querySelector<SVGElement>('.rg');
      const pct = f.querySelector<HTMLElement>('.sc b');
      const st = f.querySelector<HTMLElement>('.tl-bar .sp');
      const foot = f.querySelector<HTMLElement>('.doc-f');
      const lis = Array.from(f.querySelectorAll<HTMLElement>('.doc-b li'));

      const score = (v: number) => {
        setRing(rg, null, v);
        if (pct) pct.textContent = v + '%';
      };

      f.querySelectorAll<HTMLElement>('.ch[data-fix]').forEach((c) => { c.className = 'ch gap'; });
      if (foot) foot.classList.remove('show');
      if (st) st.className = 'sp t1';
      score(0);
      lis.forEach((li) => {
        const nw = li.querySelector<HTMLElement>('.new');
        if (nw) nw.textContent = '';
      });
      at(200, () => { score(58); });
      let t = 1100;
      lis.forEach((li, i) => {
        const nw = li.querySelector<HTMLElement>('.new');
        const txt = (nw ? nw.dataset.new : '') || '';
        txt.split('').forEach((_chr, k) => {
          at(t + k * 26, () => { if (nw) nw.textContent = txt.slice(0, k + 1); });
        });
        t += txt.length * 26 + 250;
        at(t, () => {
          const ch = f.querySelector<HTMLElement>('.ch[data-fix="' + (i + 1) + '"]');
          if (ch) ch.className = 'ch y';
          score(i === 0 ? 72 : 86);
        });
        t += 700;
      });
      at(t, () => {
        if (st) st.className = 'sp t2';
        if (foot) foot.classList.add('show');
      });
    },
    match: (f, at) => {
      const rows = Array.from(f.querySelectorAll<HTMLElement>('.fr'));
      const total = 500 + rows.length * 900 + 1400;
      headRun(f, at, total);
      rows.forEach((r, i) => {
        r.classList.remove('in', 'low');
        r.style.top = (i * 100) + 'px';
        r.querySelectorAll<HTMLElement>('.ch').forEach((c) => { c.classList.remove('y', 'n'); });
        const rg = r.querySelector<SVGElement>('.rg');
        if (rg) (rg as any).style.strokeDashoffset = '119.4';
        const scB = r.querySelector<HTMLElement>('.sc b');
        if (scB) scB.textContent = '0';
      });
      rows.forEach((r, i) => {
        const t = 400 + i * 900;
        const chips = r.querySelectorAll<HTMLElement>('.ch');
        const s = +(r.dataset.s || 0);
        at(t, () => { r.classList.add('in'); });
        chips.forEach((c, j) => {
          at(t + 350 + j * 220, () => { c.classList.add(c.dataset.ok === '1' ? 'y' : 'n'); });
        });
        at(t + 350 + chips.length * 220 + 100, () => {
          const rg = r.querySelector<SVGElement>('.rg');
          setRing(rg, null, s, s >= 75 ? '#13914F' : (s >= 40 ? '#B45309' : '#C2410C'));
          countUp(r.querySelector<HTMLElement>('.sc b'), s, 800);
        });
      });
      at(400 + rows.length * 900 + 900, () => {
        rows.slice().sort((a, b) => +(b.dataset.s || 0) - +(a.dataset.s || 0)).forEach((r, i) => {
          r.style.top = (i * 100) + 'px';
          if (+(r.dataset.s || 0) < 50) r.classList.add('low');
        });
      });
    }
  };

  const cardStops: Array<() => void> = [];

  document.querySelectorAll<HTMLElement>('.fc[data-run]').forEach((f) => {
    const kind = f.dataset.run;
    if (!kind || !RUN[kind]) return;
    let ts: (ReturnType<typeof setTimeout>)[] = [];
    let played = false;
    function at(ms: number, fn: () => void) {
      if (reduce) fn(); else ts.push(setTimeout(fn, ms));
    }
    function stop() { ts.forEach(clearTimeout); ts = []; }
    cardStops.push(stop);

    if (reduce || !('IntersectionObserver' in window)) {
      f.classList.add('prep');
      RUN[kind](f, (_ms, fn) => { fn(); });
      f.querySelectorAll<HTMLElement>('.fr').forEach((r) => { r.classList.add('in'); });
      return;
    }
    f.classList.add('prep');
    if (kind === 'match') {
      f.querySelectorAll<HTMLElement>('.fr').forEach((r, i) => { r.style.top = (i * 100) + 'px'; });
    }
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting && e.intersectionRatio >= 0.35 && !played) {
          played = true;
          stop();
          RUN[kind](f, at);
        } else if (!e.isIntersecting && played) {
          played = false;
          stop();
        }
      });
    }, { threshold: [0, 0.35] });
    io.observe(f);
    cardObservers.push(io);
  });

  // Return cleanup function
  return () => {
    clearTimers();
    cleanups.forEach((c) => c());
    cardStops.forEach((stop) => stop());
    if (gLoopReq) cancelAnimationFrame(gLoopReq);
    if (tourT) clearInterval(tourT);
    if (confettiReq) cancelAnimationFrame(confettiReq);
    if (activeConfetti) {
      activeConfetti.remove();
      activeConfetti = null;
    }
    if (compObserver) compObserver.disconnect();
    if (globeObserver) globeObserver.disconnect();
    cardObservers.forEach((io) => io.disconnect());
  };
}
