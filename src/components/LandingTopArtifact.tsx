"use client";

import React, { useEffect, useRef } from "react";
import Link from "next/link";

interface RoleData {
  label: string;
  title: string;
  co: string;
  color: string;
  dom: string;
  loc: string;
  posted: string;
  found: number;
  hidden: number;
  from: number;
  to: number;
  have: string[];
  add: string[];
  before: string;
  after: string;
}

const ROLES: Record<string, RoleData> = {
  backend: {
    label: "Backend",
    title: "Senior Backend Engineer",
    co: "Fernway",
    color: "#4F63E6",
    dom: "careers.fernway.io",
    loc: "Remote, worldwide",
    posted: "Posted 3h ago",
    found: 23,
    hidden: 17,
    from: 68,
    to: 94,
    have: ["Node.js", "PostgreSQL", "Docker"],
    add: ["Kafka", "AWS", "gRPC"],
    before: "Built APIs for a payments app.",
    after: "Built Node.js and Kafka APIs on AWS for 2M daily payments."
  },
  frontend: {
    label: "Frontend",
    title: "Frontend Engineer",
    co: "Kitebird",
    color: "#0EA5E9",
    dom: "jobs.kitebird.com",
    loc: "Remote, Europe",
    posted: "Posted 5h ago",
    found: 31,
    hidden: 22,
    from: 71,
    to: 95,
    have: ["React", "CSS", "Jest"],
    add: ["TypeScript", "Storybook", "Accessibility"],
    before: "Built UI components for the web app.",
    after: "Built a TypeScript component library in Storybook, fully accessible."
  },
  fullstack: {
    label: "Full-stack",
    title: "Full-stack Engineer",
    co: "Paperlane",
    color: "#0E9F8E",
    dom: "paperlane.dev/careers",
    loc: "Bengaluru, hybrid",
    posted: "Posted 2h ago",
    found: 27,
    hidden: 19,
    from: 66,
    to: 93,
    have: ["React", "Node.js", "SQL"],
    add: ["Next.js", "PostgreSQL", "AWS"],
    before: "Worked on the web app and backend.",
    after: "Shipped Next.js features end to end on PostgreSQL and AWS."
  },
  data: {
    label: "Data & AI",
    title: "Machine Learning Engineer",
    co: "Quillhaus",
    color: "#8B5CF6",
    dom: "quillhaus.ai/jobs",
    loc: "Remote, worldwide",
    posted: "Posted 4h ago",
    found: 19,
    hidden: 14,
    from: 64,
    to: 92,
    have: ["Python", "SQL", "Pandas"],
    add: ["PyTorch", "LLMs", "MLOps"],
    before: "Built models to predict churn.",
    after: "Trained PyTorch and LLM models for churn, shipped with MLOps."
  },
  mobile: {
    label: "Mobile",
    title: "iOS Engineer",
    co: "Orbitra",
    color: "#F08C00",
    dom: "orbitra.app/careers",
    loc: "Remote, Americas",
    posted: "Posted 6h ago",
    found: 16,
    hidden: 12,
    from: 70,
    to: 95,
    have: ["Swift", "Xcode", "Git"],
    add: ["SwiftUI", "Combine", "CI/CD"],
    before: "Built features for the iPhone app.",
    after: "Built SwiftUI and Combine features, shipped weekly with CI/CD."
  },
  design: {
    label: "Design",
    title: "Product Designer",
    co: "Tandemly",
    color: "#D6336C",
    dom: "tandemly.co/jobs",
    loc: "Remote, worldwide",
    posted: "Posted 3h ago",
    found: 21,
    hidden: 15,
    from: 67,
    to: 93,
    have: ["Figma", "Wireframes", "UX"],
    add: ["Design systems", "Prototyping", "User research"],
    before: "Designed screens for the mobile app.",
    after: "Led user research, prototyping and a design system for the mobile app."
  }
};

const SITES: [string, string][] = [
  ["careers.hollowpine.com", "#2F9E44"],
  ["jobs.saltandsignal.io", "#1C7ED6"],
  ["brightloom.in/careers", "#E8590C"],
  ["nimbusworks.dev/jobs", "#7048E8"],
  ["tidepool.co/careers", "#0C8599"],
  ["mapleforge.io/join", "#C2255C"],
  ["careers.northvale.com", "#5C940D"],
  ["jobs.copperkite.ai", "#D9480F"],
  ["lumenhaus.de/karriere", "#364FC7"],
  ["careers.oakandoar.com", "#087F5B"],
  ["workat.sproutly.app", "#F59F00"],
  ["jobs.ferrolab.io", "#AE3EC9"]
];

function fmt(n: number | string): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : String(n);
}

function buzz(ms: number | number[] = 8) {
  try {
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      navigator.vibrate(ms);
    }
  } catch {}
}

function renderHighlightedText(container: HTMLElement, text: string, words: string[]): void {
  container.textContent = "";
  const validWords = words.filter((w) => Boolean(w && w.trim()));
  if (validWords.length === 0) {
    container.textContent = text;
    return;
  }

  // Sort by length descending to match longer phrases before shorter substrings
  const sortedWords = [...validWords].sort((a, b) => b.length - a.length);
  const escaped = sortedWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const regex = new RegExp(`(${escaped.join("|")})`, "gi");
  const parts = text.split(regex);
  const wordsLower = new Set(validWords.map((w) => w.toLowerCase()));

  for (const part of parts) {
    if (!part) continue;
    if (wordsLower.has(part.toLowerCase())) {
      const mark = document.createElement("mark");
      mark.textContent = part;
      container.appendChild(mark);
    } else {
      container.appendChild(document.createTextNode(part));
    }
  }
}

export default function LandingTopArtifact() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const $ = (s: string, el: Element | Document = root) => el.querySelector(s) as HTMLElement | null;
    const $$ = (s: string, el: Element | Document = root) => Array.from(el.querySelectorAll(s)) as HTMLElement[];

    const nav = $("#nav");
    const onScroll = () => {
      if (nav) nav.classList.toggle("scrolled", window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    let timers: ReturnType<typeof setTimeout>[] = [];
    let animFrameId: number | null = null;
    let observer: IntersectionObserver | null = null;

    const later = (fn: () => void, ms: number) => {
      const id = setTimeout(fn, reduce ? Math.min(ms, 120) : ms);
      timers.push(id);
      return id;
    };
    const clearTimers = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };

    const demo = $("#demo");
    const wrap = $("#demoWrap");
    if (!demo || !wrap) {
      return () => {
        window.removeEventListener("scroll", onScroll);
        clearTimers();
      };
    }
    const demoEl: HTMLElement = demo;

    const stepEls = $$(".steps li", demo);
    const screens: Record<string, HTMLElement> = {};
    $$(".screen", demo).forEach((s) => {
      if (s.dataset.screen) screens[s.dataset.screen] = s;
    });

    const F = (name: string) => $(`[data-f="${name}"]`, demo);
    const announce = (t: string) => {
      const el = $("#announce");
      if (el) el.textContent = t;
    };

    let R: RoleData | null = null;
    let t0 = 0;
    let busy = false;

    function setStep(i: number) {
      stepEls.forEach((li, k) => {
        li.classList.toggle("done", k < i);
        li.classList.toggle("active", k === i);
      });
    }

    const stage = $(".stage", demo);
    function show(name: string) {
      if (!stage || !screens[name]) return;
      const keyboard = demo?.contains(document.activeElement) && document.activeElement !== document.body;
      const h0 = stage.offsetHeight;
      Object.values(screens).forEach((s) => s.classList.remove("on"));
      screens[name].classList.add("on");

      const h1 = stage.offsetHeight;
      if (!reduce && Math.abs(h1 - h0) > 2) {
        stage.style.height = h0 + "px";
        stage.style.overflow = "hidden";
        void stage.offsetHeight;
        stage.style.transition = "height .4s cubic-bezier(.2,.8,.2,1)";
        stage.style.height = h1 + "px";
        later(() => {
          stage.style.height = stage.style.transition = stage.style.overflow = "";
        }, 420);
      }
      if (keyboard) {
        const h = screens[name].querySelector("[tabindex='-1']") as HTMLElement | null;
        h?.focus({ preventScroll: true });
      }
    }

    let touched = false;
    const stopHint = () => {
      touched = true;
      demo.classList.remove("hinting");
      wrap.classList.add("touched");
    };

    if ("IntersectionObserver" in window) {
      observer = new IntersectionObserver(
        ([e]) => {
          if (!touched) demo.classList.toggle("hinting", e.isIntersecting);
        },
        { threshold: 0.55 }
      );
      observer.observe(demo);
    } else {
      demo.classList.add("hinting");
    }

    demo.addEventListener("pointerdown", stopHint, { once: true });
    demo.addEventListener("keydown", stopHint, { once: true });

    const CIRC = 175.93;
    function setRing(v: number) {
      const ring = F("ring");
      if (!ring) return;
      const val = ring.querySelector(".val") as SVGCircleElement | null;
      if (val) {
        val.style.strokeDashoffset = String(CIRC * (1 - v / 100));
      }
      ring.classList.toggle("great", v >= 85);
      ring.setAttribute("aria-label", `Match score ${v} percent`);
    }

    function countTo(el: HTMLElement | null, from: number, to: number, ms: number, suffix = "") {
      if (!el) return;
      if (reduce) {
        el.textContent = fmt(to) + suffix;
        return;
      }
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / ms);
        const e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(Math.round(from + (to - from) * e)) + suffix;
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    const tileButtons = $$(".tile", demoEl);
    tileButtons.forEach((tile) => {
      tile.addEventListener("click", () => {
        if (busy) return;
        busy = true;
        stopHint();
        buzz(10);
        const role = tile.dataset.role;
        if (!role || !ROLES[role]) return;
        R = ROLES[role];
        t0 = performance.now();
        tile.classList.add("picked");
        tile.parentElement?.classList.add("locked");
        later(scan, 450);
      });
    });

    function scan() {
      if (!R) return;
      setStep(1);
      show("scan");
      const label = F("label");
      if (label) label.textContent = R.label;
      const feed = F("feed");
      if (feed) feed.textContent = "";
      const pagesEl = F("pages");
      const jobsEl = F("jobs");
      if (pagesEl) pagesEl.textContent = "0";
      if (jobsEl) jobsEl.textContent = "0";

      const pages = 2300 + Math.floor(Math.random() * 300);
      const dur = 2600;
      countTo(pagesEl, 0, pages, dur);
      countTo(jobsEl, 0, R.found, dur);
      announce(`Checking company career pages for ${R.label} jobs`);

      const sites: [string, string, boolean?][] = SITES.slice()
        .sort(() => Math.random() - 0.5)
        .slice(0, 9);
      sites.push([R.dom, R.color, true]);

      sites.forEach(([dom, color, best], i) => {
        later(() => {
          if (!feed) return;
          const hit = best ? "best" : Math.random() < 0.55 ? "hit" : "";
          const n = 1 + Math.floor(Math.random() * 3);
          const li = document.createElement("li");
          if (best) li.className = "best";
          const initial = dom.replace(/^(careers|jobs|workat)\./, "")[0].toUpperCase();

          const fav = document.createElement("span");
          fav.className = "fav";
          fav.style.background = color;
          fav.textContent = initial;

          const domEl = document.createElement("span");
          domEl.className = "dom";
          domEl.textContent = dom;

          const res = document.createElement("span");
          res.className = hit ? `res ${hit}` : "res";
          res.textContent = best ? "Best match" : hit ? `+${n} job${n > 1 ? "s" : ""}` : "No fit";

          li.appendChild(fav);
          li.appendChild(domEl);
          li.appendChild(res);
          feed.prepend(li);
          while (feed.children.length > 5) {
            feed.lastChild?.remove();
          }
        }, 120 + i * (dur / 10));
      });

      later(job, dur + 650);
    }

    function job() {
      if (!R) return;
      setStep(2);
      show("job");

      const found = F("found");
      if (found) found.textContent = String(R.found);
      const hidden = F("hidden");
      if (hidden) hidden.textContent = String(R.hidden);

      const logo = F("logo");
      if (logo) {
        logo.textContent = R.co[0];
        logo.style.background = R.color;
      }
      const title = F("title");
      if (title) title.textContent = R.title;
      const co = F("co");
      if (co) co.textContent = R.co;
      const co2 = F("co2");
      if (co2) co2.textContent = R.co;
      const loc = F("loc");
      if (loc) loc.textContent = R.loc;
      const posted = F("posted");
      if (posted) posted.textContent = R.posted;

      setRing(R.from);
      countTo(F("score"), 0, R.from, 550, "%");

      const chips = F("chips");
      if (chips) {
        chips.textContent = "";
        R.have.forEach((s) => {
          const c = document.createElement("span");
          c.className = "chip have";
          c.textContent = "✓ " + s;
          chips.appendChild(c);
        });
        R.add.forEach((s) => {
          const c = document.createElement("span");
          c.className = "chip miss";
          c.textContent = "+ " + s;
          chips.appendChild(c);
        });
      }

      const status = F("status");
      if (status) {
        status.className = "r-status";
        status.textContent = `${R.add.length} skills missing`;
      }
      const line = F("line");
      if (line) {
        line.className = "r-line";
        line.textContent = R.before;
      }

      const btn = F("act");
      if (btn) {
        btn.removeAttribute("aria-disabled");
        btn.textContent = "Tailor my resume";
        btn.dataset.next = "tailor";
      }

      const delta = F("delta");
      if (delta) delta.className = "delta";

      announce(`Found ${R.found} jobs. Best match is ${R.title} at ${R.co}, match score ${R.from} percent.`);
      busy = false;
      if (btn) nudgeLater(btn);
    }

    function nudgeLater(el: HTMLElement) {
      later(() => {
        if (!busy && !touched) {
          el.classList.remove("nudge");
          void el.offsetWidth;
          el.classList.add("nudge");
        }
      }, 700);
    }

    const actBtn = F("act");
    if (actBtn) {
      actBtn.addEventListener("click", () => {
        if (busy) return;
        const next = actBtn.dataset.next;
        if (next === "tailor") tailor();
        else if (next === "send") send();
      });
    }

    function tailor() {
      if (!R || !actBtn) return;
      busy = true;
      buzz(14);
      actBtn.setAttribute("aria-disabled", "true");
      actBtn.classList.remove("nudge");

      const status = F("status");
      if (status) {
        status.textContent = "Rewriting bullet with matching keywords...";
        status.classList.add("busy");
      }

      const line = F("line");
      if (line) line.classList.add("typing");

      let len = R.before.length;
      const erase = () => {
        if (!line || !R) return;
        len = Math.max(0, len - 2);
        line.textContent = R.before.slice(0, len);
        if (len > 0) later(erase, 14);
        else later(() => type(0), 120);
      };

      const type = (i: number) => {
        if (!line || !R) return;
        line.textContent = R.after.slice(0, i);
        if (i < R.after.length) later(() => type(i + 1), 21);
        else {
          line.classList.remove("typing");
          renderHighlightedText(line, R.after, R.add);
        }
      };

      later(erase, 200);

      const chipsEl = F("chips");
      const misses = chipsEl ? ($$(".chip.miss", chipsEl) as HTMLElement[]) : [];
      let score = R.from;
      misses.forEach((chip, k) => {
        later(() => {
          if (!R) return;
          chip.classList.remove("miss");
          chip.classList.add("add");
          chip.textContent = "✓ " + R.add[k];
          const next = Math.round(R.from + ((R.to - R.from) * (k + 1)) / misses.length);
          countTo(F("score"), score, next, 380, "%");
          score = next;
          setRing(next);
          buzz(6);
        }, 650 + k * 520);
      });

      const typeTime = 200 + (R.before.length / 2) * 14 + R.after.length * 21;
      const end = Math.max(typeTime, 650 + misses.length * 520) + 250;

      later(() => {
        if (!R || !actBtn) return;
        const d = F("delta");
        if (d) {
          d.textContent = `+${R.to - R.from}`;
          d.classList.remove("go");
          void d.offsetWidth;
          d.classList.add("go");
        }
        if (status) {
          status.textContent = `Tailored for ${R.co}`;
          status.classList.remove("busy");
          status.classList.add("ok");
        }
        setStep(3);
        actBtn.removeAttribute("aria-disabled");
        actBtn.textContent = "Apply on company site";
        actBtn.dataset.next = "send";
        announce(`Resume tailored. Match is now ${R.to} percent.`);
        busy = false;
        nudgeLater(actBtn);
      }, end);
    }

    function send() {
      busy = true;
      clearTimers();
      const secs = Math.max(1, Math.round((performance.now() - t0) / 1000));
      setStep(4);
      later(() => {
        const secsEl = F("secs");
        if (secsEl) secsEl.textContent = String(secs);
        show("done");
        confetti();
        buzz([12, 40, 18]);
        announce(`Applied in ${secs} seconds.`);
        busy = false;
      }, 180);
    }

    const againBtn = F("again");
    if (againBtn) {
      againBtn.addEventListener("click", () => {
        clearTimers();
        busy = false;
        R = null;
        tileButtons.forEach((t) => t.classList.remove("picked"));
        const tilesEl = $(".tiles", demoEl);
        if (tilesEl) tilesEl.classList.remove("locked");
        setStep(0);
        show("find");
        const first = $(".tile", demoEl);
        if (first) (first as HTMLElement).focus({ preventScroll: true });
      });
    }

    function confetti() {
      if (reduce) return;
      const c = $("canvas", demoEl) as HTMLCanvasElement | null;
      if (!c) return;
      const r = demoEl.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = r.width * dpr;
      c.height = r.height * dpr;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const cols = ["#22C065", "#FFCF3F", "#D93A40", "#2F7BF6", "#0F2E24", "#8B5CF6"];
      const ox = r.width / 2;
      const oy = r.height * 0.3;
      const P = Array.from({ length: 130 }, () => {
        const a = Math.random() * Math.PI * 2;
        const sp = 4 + Math.random() * 8;
        return {
          x: ox,
          y: oy,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 5,
          w: 6 + Math.random() * 6,
          h: 4 + Math.random() * 4,
          c: cols[(Math.random() * cols.length) | 0],
          r: Math.random() * 6.3,
          vr: (Math.random() - 0.5) * 0.35
        };
      });

      let f = 0;
      function tick() {
        if (!ctx) return;
        ctx.clearRect(0, 0, r.width, r.height);
        P.forEach((p) => {
          p.vy += 0.26;
          p.vx *= 0.985;
          p.vy *= 0.985;
          p.x += p.vx;
          p.y += p.vy;
          p.r += p.vr;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.r);
          ctx.globalAlpha = Math.max(0, 1 - f / 110);
          ctx.fillStyle = p.c;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
          ctx.restore();
        });
        if (++f < 110) {
          animFrameId = requestAnimationFrame(tick);
        } else {
          ctx.clearRect(0, 0, r.width, r.height);
        }
      }
      animFrameId = requestAnimationFrame(tick);
    }

    return () => {
      window.removeEventListener("scroll", onScroll);
      clearTimers();
      if (animFrameId) cancelAnimationFrame(animFrameId);
      if (observer) observer.disconnect();
    };
  }, []);

  return (
    <div ref={rootRef} className="landing-top-artifact">
<header className="nav" id="nav">
  <div className="wrap">
    <Link className="brand" href="/" aria-label="CareerMonke home"><img src="/icon.png" alt="CareerMonke" width="40" height="40" /><span>CareerMonke</span></Link>
    <div className="nav-actions">
      <Link className="nav-link" href="/login">Sign in</Link>
      <Link className="btn btn-ink btn-sm" href="/signup">Sign up free</Link>
    </div>
  </div>
</header>


  
  <section className="hero">
    <div className="wrap hero-in">
      <p className="live-pill"><span className="pulse" aria-hidden="true"></span><span><span data-stat="jobsToday">1,240</span> new jobs found today</span></p>
      <h1><span className="kicker">Jobs LinkedIn doesn&apos;t show you</span><span className="big">Get there first.</span></h1>
      <p className="lede">We pull jobs straight from company career pages, match them to you, and tailor your resume in one tap.</p>
      <div className="hero-cta">
        <Link className="btn btn-ink" href="/signup">Sign up free</Link>
        <a className="try-link" href="#try">or try the demo first<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"></path></svg></a>
      </div>
      <ul className="assure">
        <li><svg viewBox="0 0 24 24" fill="none" stroke="#13914F" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Free during early access</li>
        <li><svg viewBox="0 0 24 24" fill="none" stroke="#13914F" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Never a cut of your salary</li>
      </ul>
    </div>
  </section>

  
  <section className="demo-band" id="try">
    <div className="wrap">
      <h2 className="band-title">See it work in 3 <span className="t-touch">taps</span><span className="t-click">clicks</span></h2>
      <div className="demo-wrap" id="demoWrap">
        <div className="float f1" aria-hidden="true"><span className="fav" style={{ background: "#0EA5E9" }}>K</span><span><b>Frontend Engineer</b><small>Kitebird, Remote</small></span><em>95%</em></div>
        <div className="float f2" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.2 2.3-2.4 3.6M6.4 6.4C4.3 7.8 2.8 10 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.5 4.8-1.3"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path></svg>Not on LinkedIn</div>
        <div className="float f3" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>Resume tailored <em>+26%</em></div>
        <div className="float f4" aria-hidden="true"><b>7</b> applied<small>vs 200+ on job boards</small></div>
        <div className="buddy" aria-hidden="true"><span className="bubble">Pick a job type!</span><img src="/mascot.png" alt="CareerMonke mascot" width="84" height="84" /></div>
        <div className="demo" id="demo" role="region" aria-label="Try CareerMonke: interactive demo">
          <canvas aria-hidden="true" />
          <div className="chrome" aria-hidden="true"><span className="dots3"><i></i><i></i><i></i></span><span className="demo-tag"><span className="pulse"></span>Live demo</span><span className="url">careermonke.com</span></div>
          <ol className="steps" aria-label="Demo progress">
            <li className="active"><span className="bar"><i></i></span>Find</li>
            <li><span className="bar"><i></i></span>Match</li>
            <li><span className="bar"><i></i></span>Tailor</li>
            <li><span className="bar"><i></i></span>Send</li>
          </ol>

          <div className="stage">
            
            <div className="screen on" data-screen="find">
              <h2 className="q" tabIndex={-1}>What kind of job do you want?</h2>
              <div className="tiles" role="group" aria-label="Pick a field">
                <button className="tile" data-role="backend">
                  <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="7" width="26" height="11" rx="3.5" fill="#E3E7FF"></rect><rect x="7" y="22" width="26" height="11" rx="3.5" fill="#E3E7FF"></rect><circle cx="13" cy="12.5" r="1.2" fill="currentColor"></circle><circle cx="13" cy="27.5" r="1.2" fill="currentColor"></circle><path d="M19 12.5h8M19 27.5h8"></path></svg>
                  Backend
                  <svg className="hand" viewBox="0 0 46 46" aria-hidden="true"><path d="M14.5 4.5c-2.1 0-3.7 1.7-3.7 3.8v15.9l-2.4-2.5a3.4 3.4 0 0 0-4.9 4.8l9 10.1A10.6 10.6 0 0 0 20.4 40H28a10.4 10.4 0 0 0 10.4-10.4v-8.7c0-2.1-1.6-3.7-3.6-3.7s-3.7 1.6-3.7 3.7v-1.4c0-2-1.6-3.6-3.6-3.6s-3.7 1.6-3.7 3.6v-1c0-2-1.6-3.6-3.6-3.6-.9 0-1.6.3-2.3.8V8.3c0-2.1-1.4-3.8-3.4-3.8z" fill="#fff" stroke="#0F2E24" strokeWidth="2.4" strokeLinejoin="round"></path></svg>
                </button>
                <button className="tile" data-role="frontend">
                  <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="8" width="30" height="24" rx="4" fill="#DDF2FD"></rect><path d="M5 14h30"></path><rect x="10" y="19" width="9" height="8" rx="2" fill="#fff"></rect><path d="M23 20h7M23 25h5"></path></svg>
                  Frontend
                </button>
                <button className="tile" data-role="fullstack">
                  <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6l14 7.5L20 21 6 13.5z" fill="#D8F3EF"></path><path d="M6 20l14 7.5L34 20"></path><path d="M6 26.5L20 34l14-7.5"></path></svg>
                  Full-stack
                </button>
                <button className="tile" data-role="data">
                  <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 33V24M16 33V17M23 33v-7"></path><path d="M29 6l1.9 4.6L35.5 12.5l-4.6 1.9L29 19l-1.9-4.6L22.5 12.5l4.6-1.9z" fill="#EDE5FF"></path><path d="M6 33h28"></path></svg>
                  Data &amp; AI
                </button>
                <button className="tile" data-role="mobile">
                  <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="11" y="4" width="18" height="32" rx="4.5" fill="#FFEBD1"></rect><path d="M17.5 31h5"></path></svg>
                  Mobile
                </button>
                <button className="tile" data-role="design">
                  <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 5a15 15 0 1 0 0 30c2 0 3-1.4 3-3 0-2.2-1.8-2.7-1.8-4.6 0-1.6 1.2-2.7 2.9-2.7H27a8 8 0 0 0 8-8C35 10.6 28.3 5 20 5z" fill="#FFE0EC"></path><circle cx="12.5" cy="19" r="2" fill="currentColor"></circle><circle cx="16.5" cy="12" r="2" fill="currentColor"></circle><circle cx="24.5" cy="12" r="2" fill="currentColor"></circle></svg>
                  Design
                </button>
              </div>
              <p className="hint">Pick one to see your matches</p>
            </div>

            
            <div className="screen" data-screen="scan">
              <div className="scan-head">
                <span className="radar" aria-hidden="true"></span>
                <div>
                  <h3 tabIndex={-1}>Checking career pages</h3>
                  <p>Looking for <span data-f="label">Backend</span> jobs that fit you</p>
                </div>
              </div>
              <div className="counters">
                <div className="counter"><b data-f="pages">0</b><span>pages checked</span></div>
                <div className="counter hit"><b data-f="jobs">0</b><span>jobs for you</span></div>
              </div>
              <ul className="feed" data-f="feed" aria-hidden="true"></ul>
            </div>

            
            <div className="screen job-screen" data-screen="job">
              <p className="found">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#22C065"></circle><path d="M7.5 12.3l3 3 6-6.3" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"></path></svg>
                <span><b data-f="found">23</b> jobs found. <span data-f="hidden">17</span> aren&apos;t on LinkedIn.</span>
              </p>
              <article className="job">
                <div className="job-head">
                  <span className="co" data-f="logo">F</span>
                  <div>
                    <h3 tabIndex={-1} data-f="title">Senior Backend Engineer</h3>
                    <p className="meta"><span data-f="co">Fernway</span>, <span data-f="loc">Remote, worldwide</span></p>
                  </div>
                  <div className="ring" data-f="ring" role="img" aria-label="Match score">
                    <svg viewBox="0 0 66 66" aria-hidden="true"><circle className="track" cx="33" cy="33" r="28"></circle><circle className="val" cx="33" cy="33" r="28" strokeDasharray="175.93" strokeDashoffset="175.93"></circle></svg>
                    <span className="num"><span data-f="score">0%</span><small>match</small></span>
                    <span className="delta" data-f="delta">+26</span>
                  </div>
                </div>
                <div className="tags"><span className="tag src">Only on company site</span><span className="tag" data-f="posted">Posted 3h ago</span></div>
              </article>
              <div className="resume">
                <div className="r-top">
                  <span className="r-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h8l5 5v13H6z"></path><path d="M14 3v5h5M9 13h7M9 17h5" strokeLinecap="round"></path></svg>Your resume</span>
                  <span className="r-status" data-f="status">3 skills missing</span>
                </div>
                <p className="r-line" data-f="line">Built APIs for a payments app.</p>
                <div className="chips" data-f="chips"></div>
              </div>
              <button className="btn" data-f="act">Tailor my resume</button>
            </div>

            
            <div className="screen done-screen" data-screen="done">
              <div className="medal" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg></div>
              <h3 tabIndex={-1}>Applied in <span data-f="secs">14</span> seconds.</h3>
              <p>Found early, tailored for the role, and sent straight to <span data-f="co2">Fernway</span>. That&apos;s the whole hunt.</p>
              <Link className="btn" href="/early-access">Get my real matches</Link>
              <button className="again" data-f="again">Try another field</button>
            </div>
          </div>
          <p className="demo-foot">Demo with sample jobs</p>
        </div>
      </div>
    </div>
    <p className="sr" aria-live="polite" id="announce"></p>
  </section>

  
  
    </div>
  );
}
