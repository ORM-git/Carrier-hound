// Lower landing runtime: port of ORM-git/ssampe@3386250 src/runtime.ts + the reviews marquee and
// sticky View Jobs bar from src/main.ts. Every query is scoped to `root` (the lower .landing-wrapper)
// and the returned cleanup stops all observers, listeners, timers and animation frames.
export function initCareerMonkeLandingLower(root: HTMLElement): () => void {
  if (typeof window === "undefined") return () => {};

  const reduce =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  const $ = (id: string) => root.querySelector<HTMLElement>('#' + id);
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

  let timers: (ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | number)[] = [];

  function clearTimers() {
    timers.forEach((t) => {
      clearTimeout(t as any);
      clearInterval(t as any);
      cancelAnimationFrame(t as number);
    });
    timers = [];
  }

  /* ---------- COMPARISON REVEAL ---------- */
  let compObserver: IntersectionObserver | null = null;
  const vsTable = $('vs');
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

  const cv = $('globe') as HTMLCanvasElement | null;
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

  root.querySelectorAll<HTMLElement>('.fc[data-run]').forEach((f) => {
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

  /* ---------- REVIEWS MARQUEE (src/main.ts) ---------- */
  // Auto-scrolls the native scroller so swipe keeps working. The track holds the cards twice;
  // jumping back by one set length is invisible.
  let rvReq = 0;
  const track = root.querySelector<HTMLElement>(".rv-track");
  if (track && !reduce) {
    const dup = track.querySelector<HTMLElement>(':scope > [aria-hidden="true"]');
    const first = track.firstElementChild as HTMLElement | null;
    if (dup && first) {
      const SPEED = 40; // px per second
      let pos = track.scrollLeft, last = 0, holds = 0, resumeAt = 0;
      const hold = () => { holds++; };
      const release = (delay = 0) => { holds = Math.max(0, holds - 1); resumeAt = performance.now() + delay; };
      addListener(track, "pointerenter", ((e: PointerEvent) => { if (e.pointerType === "mouse") hold(); }) as EventListener);
      addListener(track, "pointerleave", ((e: PointerEvent) => { if (e.pointerType === "mouse") release(); }) as EventListener);
      addListener(track, "touchstart", hold, { passive: true });
      addListener(track, "touchend", () => release(1500), { passive: true });
      addListener(track, "touchcancel", () => release(1500), { passive: true });
      addListener(track, "focusin", hold);
      addListener(track, "focusout", () => release());
      const tick = (t: number) => {
        const dt = last ? Math.min(t - last, 50) : 0; // clamp so a background tab doesn't jump on return
        last = t;
        const loop = dup.offsetLeft - first.offsetLeft;
        if (holds || t < resumeAt || Math.abs(track.scrollLeft - pos) > 2) {
          pos = track.scrollLeft; // follow the user's swipe, wheel or keyboard scroll
        } else {
          pos += (SPEED * dt) / 1000;
          if (pos >= loop) pos -= loop;
          track.scrollLeft = pos;
        }
        if (loop > 0 && track.scrollLeft >= loop) { pos = track.scrollLeft - loop; track.scrollLeft = pos; }
        rvReq = requestAnimationFrame(tick);
      };
      rvReq = requestAnimationFrame(tick);
    }
  }

  /* ---------- STICKY VIEW JOBS BAR (src/main.ts) ---------- */
  // Shown only while the comparison section is reached or scrolled past; hides again above it.
  // CSS does the slide both ways.
  const bar = root.querySelector<HTMLElement>(".sb");
  const cmp = $("vs")?.closest("section");
  if (bar && cmp) {
    const check = () => bar.classList.toggle("on", cmp.getBoundingClientRect().top < innerHeight * 0.5);
    addListener(window, "scroll", check, { passive: true });
    addListener(window, "resize", check);
    check(); // page may load already scrolled (reload, anchor, Back)
  }

  return () => {
    clearTimers();
    cleanups.forEach((c) => c());
    cardStops.forEach((stop) => stop());
    if (gLoopReq) cancelAnimationFrame(gLoopReq);
    if (rvReq) cancelAnimationFrame(rvReq);
    if (tourT) clearInterval(tourT);
    if (compObserver) compObserver.disconnect();
    if (globeObserver) globeObserver.disconnect();
    cardObservers.forEach((io) => io.disconnect());
    bar?.classList.remove("on");
  };
}
