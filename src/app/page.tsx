/* eslint-disable @next/next/no-img-element, jsx-a11y/no-noninteractive-tabindex, react/no-unescaped-entities */
"use client";

// Home page: top fold = ORM-git/ssampe index.html @ f21504b (scoped .cm-top);
// lower page = ORM-git/ssampe @ 3386250 stats row .. footer + sticky bar (scoped .landing-wrapper).
import React, { useEffect, useRef } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import "@/styles/careermonke-landing.css";
import "@/styles/careermonke-landing-lower.css";
import { initCareerMonkeLanding } from "@/components/landing/careermonke-landing-runtime";
import { initCareerMonkeLandingLower } from "@/components/landing/careermonke-landing-lower-runtime";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-cm-jakarta",
  adjustFontFallback: false, // glyphs Jakarta lacks (→ ✓) must fall back to system-ui, as in the source
});

export default function HomePage() {
  const lowerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stopTop = initCareerMonkeLanding();
    const stopLower = lowerRef.current ? initCareerMonkeLandingLower(lowerRef.current) : () => {};
    return () => {
      stopTop();
      stopLower();
    };
  }, []);

  return (
    <>
      <div className={`cm-top ${jakarta.variable}`}>
        <main className="fold">
          <header className="hero">
            <div className="container">
              <nav className="nav">
                <a href="#" className="brand" aria-label="CareerMonke home">
                  <img
                    className="brand-logo"
                    src="/careermonke-logo.png"
                    alt=""
                    width="617"
                    height="749"
                  />
                  CareerMonke
                </a>
                <div className="nav-actions">
                  <a href="/login" className="btn-ghost">
                    Sign in
                  </a>
                  <a href="/signup" className="btn-dark">
                    Sign up free
                  </a>
                </div>
              </nav>

              <div className="hero-inner">
                <span className="pill">
                  <span className="pill-dot"></span>1,240 new jobs found today
                </span>
                <p className="kicker">Skip LinkedIn competition</p>
                <h1>
                  Start jobma<span className="xx">XX</span>ing with AI
                </h1>
                <p className="subhead">
                  Find verified employer jobs and tailor your resume to clear their ATS in seconds.
                </p>
              </div>
            </div>
          </header>

          <section className="stage">
            <div className="container">
              <div className="listings">
                {/* Listing 1 (full) */}
                <article className="card" id="first-card">
                  <div className="job">
                    <div className="job-main">
                      <div className="job-head">
                        <div className="logo indigo">N</div>
                        <div className="job-title-block">
                          <div className="tags">
                            <span className="tag tag-blue">
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                              >
                                <circle cx="12" cy="12" r="9" />
                                <path d="M12 7v5l3 2" />
                              </svg>
                              12 hours ago
                            </span>
                            <span className="tag tag-blue">Early applicant</span>
                            <span className="tag tag-gray">Remote eligible</span>
                          </div>
                          <h3 className="job-title">Senior Backend Engineer</h3>
                          <div className="company">
                            Northwind Pay <span className="tag tag-green">Fintech</span>
                          </div>
                        </div>
                        <div className="match-mini" aria-label="85% experience match">
                          <svg viewBox="0 0 40 40">
                            <circle
                              cx="20"
                              cy="20"
                              r="17"
                              fill="none"
                              stroke="rgba(255,255,255,.12)"
                              strokeWidth="3.5"
                            />
                            <circle
                              cx="20"
                              cy="20"
                              r="17"
                              fill="none"
                              stroke="#2dd4bf"
                              strokeWidth="3.5"
                              strokeLinecap="round"
                              strokeDasharray="106.8"
                              strokeDashoffset="16"
                            />
                          </svg>
                          85%
                        </div>
                        <button className="more" aria-label="More options">
                          •••
                        </button>
                      </div>

                      <div className="job-bottom">
                        <div className="meta">
                          <div className="meta-item">
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z" />
                              <circle cx="12" cy="10" r="2.5" />
                            </svg>
                            Remote, Worldwide
                          </div>
                          <div className="meta-item">
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <rect x="3" y="7" width="18" height="13" rx="2" />
                              <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                            </svg>
                            Full-time
                          </div>
                          <div className="meta-item">
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                            </svg>
                            $120k – $165k
                          </div>
                          <div className="meta-item hide-sm">
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <rect x="4" y="5" width="16" height="11" rx="1.5" />
                              <path d="M2 19h20" />
                            </svg>
                            Remote
                          </div>
                          <div className="meta-item hide-sm">
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />
                            </svg>
                            Senior level
                          </div>
                        </div>

                        <div className="job-actions">
                          <button className="icon-btn" aria-label="Not interested">
                            <svg
                              width="17"
                              height="17"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <circle cx="12" cy="12" r="9" />
                              <path d="M5.6 5.6l12.8 12.8" />
                            </svg>
                          </button>
                          <button className="icon-btn" aria-label="Save">
                            <svg
                              width="17"
                              height="17"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                            >
                              <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z" />
                            </svg>
                          </button>
                          <button className="btn-apply">
                            Apply
                            <svg
                              width="15"
                              height="15"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.5"
                            >
                              <path d="M5 12h14M13 6l6 6-6 6" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>

                    <aside className="match">
                      <div className="ring">
                        <svg viewBox="0 0 96 96">
                          <circle
                            cx="48"
                            cy="48"
                            r="40"
                            fill="none"
                            stroke="rgba(255,255,255,.1)"
                            strokeWidth="8"
                          />
                          <circle
                            cx="48"
                            cy="48"
                            r="40"
                            fill="none"
                            stroke="#2dd4bf"
                            strokeWidth="8"
                            strokeLinecap="round"
                            strokeDasharray="251.3"
                            strokeDashoffset="37.7"
                          />
                        </svg>
                        <span className="ring-label">85%</span>
                      </div>
                      <div>
                        <p className="match-title">Experience match</p>
                        <ul className="match-list">
                          <li>Remote eligible</li>
                          <li>Direct feed</li>
                        </ul>
                      </div>
                    </aside>
                  </div>
                </article>

                {/* Listing 2 (top half visible) */}
                <div className="peek" aria-hidden="true">
                  <article className="card">
                    <div className="job">
                      <div className="job-main">
                        <div className="job-head">
                          <div className="logo green">L</div>
                          <div className="job-title-block">
                            <div className="tags">
                              <span className="tag tag-blue">
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                >
                                  <circle cx="12" cy="12" r="9" />
                                  <path d="M12 7v5l3 2" />
                                </svg>
                                5 hours ago
                              </span>
                              <span className="tag tag-blue">Early applicant</span>
                              <span className="tag tag-gray">Remote eligible</span>
                            </div>
                            <h3 className="job-title">Data Analyst</h3>
                            <div className="company">
                              Lumen Audio <span className="tag tag-amber">Music streaming</span>
                            </div>
                          </div>
                          <div className="match-mini">
                            <svg viewBox="0 0 40 40">
                              <circle
                                cx="20"
                                cy="20"
                                r="17"
                                fill="none"
                                stroke="rgba(255,255,255,.12)"
                                strokeWidth="3.5"
                              />
                              <circle
                                cx="20"
                                cy="20"
                                r="17"
                                fill="none"
                                stroke="#2dd4bf"
                                strokeWidth="3.5"
                                strokeLinecap="round"
                                strokeDasharray="106.8"
                                strokeDashoffset="23.5"
                              />
                            </svg>
                            78%
                          </div>
                          <button className="more" aria-label="More options">
                            •••
                          </button>
                        </div>
                        <div className="job-bottom">
                          <div className="meta">
                            <div className="meta-item">
                              <svg
                                width="15"
                                height="15"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z" />
                                <circle cx="12" cy="10" r="2.5" />
                              </svg>
                              New York, NY
                            </div>
                            <div className="meta-item">
                              <svg
                                width="15"
                                height="15"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <rect x="3" y="7" width="18" height="13" rx="2" />
                                <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
                              </svg>
                              Full-time
                            </div>
                            <div className="meta-item">
                              <svg
                                width="15"
                                height="15"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                              </svg>
                              $95k – $130k
                            </div>
                          </div>
                          <div className="job-actions">
                            <span className="icon-btn"></span>
                            <span className="icon-btn"></span>
                            <span className="btn-apply">Apply</span>
                          </div>
                        </div>
                      </div>
                      <aside className="match">
                        <div className="ring">
                          <svg viewBox="0 0 96 96">
                            <circle
                              cx="48"
                              cy="48"
                              r="40"
                              fill="none"
                              stroke="rgba(255,255,255,.1)"
                              strokeWidth="8"
                            />
                            <circle
                              cx="48"
                              cy="48"
                              r="40"
                              fill="none"
                              stroke="#2dd4bf"
                              strokeWidth="8"
                              strokeLinecap="round"
                              strokeDasharray="251.3"
                              strokeDashoffset="55.3"
                            />
                          </svg>
                          <span className="ring-label">78%</span>
                        </div>
                        <div>
                          <p className="match-title">Experience match</p>
                          <ul className="match-list">
                            <li>Hybrid</li>
                            <li>Direct feed</li>
                          </ul>
                        </div>
                      </aside>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </section>

          <section className="cta">
            <a href="/jobs" className="btn-cta">
              View Jobs <span aria-hidden="true">→</span>
            </a>
            <span className="cta-note">Free preview</span>
          </section>
        </main>{" "}
      </div>
      <div className="landing-wrapper" ref={lowerRef}>
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
          <symbol id="laurel" viewBox="0 0 20 48">
            <path
              d="M17 47C5 40 3 20 11 2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
            <g fill="currentColor">
              <ellipse cx="9.9" cy="44.4" rx="2.3" ry="4.6" transform="rotate(-78 9.9 44.4)" />
              <ellipse cx="15.7" cy="42.4" rx="1.9" ry="3.8" transform="rotate(-8 15.7 42.4)" />
              <ellipse cx="6.3" cy="39.3" rx="2.3" ry="4.6" transform="rotate(-62 6.3 39.3)" />
              <ellipse cx="12.1" cy="37.3" rx="1.9" ry="3.8" transform="rotate(8 12.1 37.3)" />
              <ellipse cx="4.0" cy="32.9" rx="2.3" ry="4.6" transform="rotate(-48 4.0 32.9)" />
              <ellipse cx="9.8" cy="30.9" rx="1.9" ry="3.8" transform="rotate(22 9.8 30.9)" />
              <ellipse cx="3.0" cy="25.6" rx="2.3" ry="4.6" transform="rotate(-37 3.0 25.6)" />
              <ellipse cx="8.8" cy="23.6" rx="1.9" ry="3.8" transform="rotate(33 8.8 23.6)" />
              <ellipse cx="3.4" cy="17.8" rx="2.3" ry="4.6" transform="rotate(-27 3.4 17.8)" />
              <ellipse cx="9.2" cy="15.8" rx="1.9" ry="3.8" transform="rotate(43 9.2 15.8)" />
              <ellipse cx="5.2" cy="9.6" rx="2.3" ry="4.6" transform="rotate(-18 5.2 9.6)" />
            </g>
          </symbol>
        </svg>
        <section className="wrap s stats-row" aria-label="CareerMonke in numbers">
          <dl className="stats" aria-describedby="stats-note">
            <div>
              <dd>
                <span className="wr">
                  <svg className="lf" aria-hidden="true">
                    <use href="#laurel" />
                  </svg>
                  <b>3x</b>
                  <svg className="lf r" aria-hidden="true">
                    <use href="#laurel" />
                  </svg>
                </span>
              </dd>
              <dt>higher callback rate</dt>
            </div>
            <div>
              <dd>
                <span className="wr">
                  <svg className="lf" aria-hidden="true">
                    <use href="#laurel" />
                  </svg>
                  <b>94%</b>
                  <svg className="lf r" aria-hidden="true">
                    <use href="#laurel" />
                  </svg>
                </span>
              </dd>
              <dt>ATS keyword alignment</dt>
            </div>
            <div>
              <dd>
                <span className="wr">
                  <svg className="lf" aria-hidden="true">
                    <use href="#laurel" />
                  </svg>
                  <b>1,200+</b>
                  <svg className="lf r" aria-hidden="true">
                    <use href="#laurel" />
                  </svg>
                </span>
              </dd>
              <dt>
                fresh roles <span className="sbr">active</span>
              </dt>
            </div>
          </dl>
          <p className="stats-note" id="stats-note">
            *Based on early access user surveys
          </p>
        </section>

        <section className="ls" aria-label="Companies hiring now (sample)">
          <div className="ls-track">
            <div className="ls-set">
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">L</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Lumen Labs</b> · 2 hours ago
                  </span>
                  <span className="ls-title">Frontend Developer</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">N</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Northwind</b> · 3 hours ago
                  </span>
                  <span className="ls-title">BI Analyst</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">B</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Brightline</b> · 1 hour ago
                  </span>
                  <span className="ls-title">Data Analyst</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">F</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Fernway</b> · 3 hours ago
                  </span>
                  <span className="ls-title">Senior Backend Engineer</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">D</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Driftwell</b> · 1 hour ago
                  </span>
                  <span className="ls-title">Product Manager</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">B</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Brightside</b> · 2 hours ago
                  </span>
                  <span className="ls-title">Growth Marketing Manager</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">Q</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Quillhaus</b> · 4 hours ago
                  </span>
                  <span className="ls-title">Machine Learning Engineer</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">L</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Ledgerly</b> · 3 hours ago
                  </span>
                  <span className="ls-title">Account Executive</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">T</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Tandemly</b> · 3 hours ago
                  </span>
                  <span className="ls-title">Product Designer</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs">
                <span className="ls-logo">O</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Orbit</b> · 5 hours ago
                  </span>
                  <span className="ls-title">Data Scientist</span>
                </span>
              </a>
            </div>
            <div className="ls-set" aria-hidden="true">
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">L</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Lumen Labs</b> · 2 hours ago
                  </span>
                  <span className="ls-title">Frontend Developer</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">N</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Northwind</b> · 3 hours ago
                  </span>
                  <span className="ls-title">BI Analyst</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">B</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Brightline</b> · 1 hour ago
                  </span>
                  <span className="ls-title">Data Analyst</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">F</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Fernway</b> · 3 hours ago
                  </span>
                  <span className="ls-title">Senior Backend Engineer</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">D</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Driftwell</b> · 1 hour ago
                  </span>
                  <span className="ls-title">Product Manager</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">B</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Brightside</b> · 2 hours ago
                  </span>
                  <span className="ls-title">Growth Marketing Manager</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">Q</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Quillhaus</b> · 4 hours ago
                  </span>
                  <span className="ls-title">Machine Learning Engineer</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">L</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Ledgerly</b> · 3 hours ago
                  </span>
                  <span className="ls-title">Account Executive</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">T</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Tandemly</b> · 3 hours ago
                  </span>
                  <span className="ls-title">Product Designer</span>
                </span>
              </a>
              <a className="ls-card" href="/jobs" tabIndex={-1}>
                <span className="ls-logo">O</span>
                <span className="ls-txt">
                  <span className="ls-meta">
                    <b>Orbit</b> · 5 hours ago
                  </span>
                  <span className="ls-title">Data Scientist</span>
                </span>
              </a>
            </div>
          </div>
        </section>

        <section className="wrap s" aria-labelledby="cmp-h">
          <h2 className="h2" id="cmp-h">
            The Usual Grind vs The CareerMonke Way
          </h2>
          <table className="vs" id="vs">
            <caption className="sr">The usual grind compared with the CareerMonke way</caption>
            <thead>
              <tr>
                <th scope="col">The Usual Grind</th>
                <th scope="col">
                  <img src="/mascot.png" alt="" width="22" height="22" />
                  The CareerMonke Way
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <g className="a-bob">
                        <circle cx="8" cy="12" r="2.6" />
                        <path d="M4 21a4 4 0 0 1 8 0" />
                      </g>
                      <g className="a-bob d2">
                        <circle cx="16" cy="10" r="2.8" />
                        <path d="M11.5 19.5a4.5 4.5 0 0 1 9 0" />
                      </g>
                      <g className="a-bob d3">
                        <circle cx="24" cy="12" r="2.6" />
                        <path d="M20 21a4 4 0 0 1 8 0" />
                      </g>
                      <path d="M5 27h22" opacity=".5" />
                    </svg>
                    <i className="vb no" aria-hidden="true">
                      ✕
                    </i>
                  </span>
                  <span className="vx">800+ applicants per listing</span>
                </td>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="3" y="8" width="11" height="19" rx="1.5" />
                      <path d="M6.5 12h1M10 12h1M6.5 16h1M10 16h1M6.5 20h1M10 20h1" />
                      <path className="a-dash" d="M15 17.5h8" />
                      <path d="M21 14.5l3 3-3 3" />
                      <circle cx="28" cy="12" r="2.2" />
                      <path d="M25 20a3 3 0 0 1 6 0" />
                    </svg>
                    <i className="vb ok" aria-hidden="true">
                      ✓
                    </i>
                  </span>
                  <span className="vx">Jobs matched to your resume</span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="6" y="5" width="15" height="21" rx="2" />
                      <path d="M9.5 10h8M9.5 14h8M9.5 18h5" />
                      <g className="a-write">
                        <path d="M21 23l6-9 2.5 1.6-6 9-3 1z" />
                      </g>
                    </svg>
                    <i className="vb no" aria-hidden="true">
                      ✕
                    </i>
                  </span>
                  <span className="vx">Hours tailoring every bullet</span>
                </td>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="5" y="6" width="15" height="21" rx="2" />
                      <path d="M8.5 11h8M8.5 15h8M8.5 19h5" />
                      <path
                        className="a-twinkle"
                        d="M25 4.5l1.3 3.2 3.2 1.3-3.2 1.3L25 13.5l-1.3-3.2L20.5 9l3.2-1.3z"
                        fill="currentColor"
                        stroke="none"
                      />
                    </svg>
                    <i className="vb ok" aria-hidden="true">
                      ✓
                    </i>
                  </span>
                  <span className="vx">See your percentage match score</span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <g className="a-spin">
                        <circle cx="16" cy="16" r="11" strokeDasharray="3 3" />
                      </g>
                      <circle cx="16" cy="16" r="6" />
                      <circle cx="16" cy="16" r="2.2" fill="currentColor" />
                    </svg>
                    <i className="vb no" aria-hidden="true">
                      ✕
                    </i>
                  </span>
                  <span className="vx">Resumes lost in black holes</span>
                </td>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M5 22a11 11 0 0 1 22 0" />
                      <path d="M8.5 14.5l1.4 1.2M16 11v2M23.5 14.5l-1.4 1.2" opacity=".6" />
                      <g className="a-needle">
                        <path d="M16 22l0-8.5" />
                      </g>
                      <circle cx="16" cy="22" r="2" fill="currentColor" />
                    </svg>
                    <i className="vb ok" aria-hidden="true">
                      ✓
                    </i>
                  </span>
                  <span className="vx">Verified employer job listings</span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <g className="a-bob">
                        <path d="M9 27V14a7 7 0 0 1 14 0v13l-2.4-2-2.3 2-2.3-2-2.3 2-2.3-2z" />
                        <circle cx="13.5" cy="15" r="1" fill="currentColor" />
                        <circle cx="18.5" cy="15" r="1" fill="currentColor" />
                      </g>
                    </svg>
                    <i className="vb no" aria-hidden="true">
                      ✕
                    </i>
                  </span>
                  <span className="vx">Ghost and expired reposts</span>
                </td>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 27V17h7v10M22.5 20.5h2M22.5 23.5h2" opacity=".55" />
                      <g className="a-seek">
                        <circle cx="12" cy="12" r="6.5" />
                        <path d="M16.8 16.8L21 21" />
                      </g>
                    </svg>
                    <i className="vb ok" aria-hidden="true">
                      ✓
                    </i>
                  </span>
                  <span className="vx">Filter jobs by role, location and work mode</span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="4" y="8" width="20" height="15" rx="2" />
                      <path d="M4.5 9l9.5 7 9.5-7" />
                      <g className="a-bob">
                        <circle cx="25" cy="22" r="5" fill="#fff" />
                        <path d="M23 20l4 4M27 20l-4 4" />
                      </g>
                    </svg>
                    <i className="vb no" aria-hidden="true">
                      ✕
                    </i>
                  </span>
                  <span className="vx">Auto-rejected in 10 minutes</span>
                </td>
                <td>
                  <span className="vt">
                    <svg
                      className="vi"
                      viewBox="0 0 32 32"
                      width="28"
                      height="28"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <g className="a-blink">
                        <path d="M3 16s4.5-8 13-8 13 8 13 8-4.5 8-13 8S3 16 3 16z" />
                        <circle cx="16" cy="16" r="3.6" />
                      </g>
                    </svg>
                    <i className="vb ok" aria-hidden="true">
                      ✓
                    </i>
                  </span>
                  <span className="vx">Apply on the employer's careers page</span>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="wrap s" aria-labelledby="feat-h">
          <h2 className="h2" id="feat-h">
            The whole hunt, in one place
          </h2>
          <ol className="fx">
            <li className="fxi">
              <div className="fx-copy">
                <h3>
                  <span className="fnum" aria-hidden="true">
                    1
                  </span>
                  <span>Explore jobs by city</span>
                </h3>
                <p>Work setup and eligibility, checked.</p>
              </div>
              <figure className="fc gl" data-run="city">
                <div className="gl-stage">
                  <canvas
                    className="globe"
                    id="globe"
                    width="248"
                    height="248"
                    role="img"
                    aria-label="Interactive globe with six sample cities. Drag to spin, or pick a city below."
                  ></canvas>
                  <span className="gl-hint" id="gl-hint" aria-hidden="true">
                    Drag to spin · tap a city
                  </span>
                </div>
                <div className="gl-detail" aria-live="polite">
                  <div className="gl-row1">
                    <p className="gl-city">
                      <span id="cy-name">London</span>
                      <small>Sample</small>
                    </p>
                    <p className="gl-stats">
                      <b id="cy-jobs">37</b> jobs · <b id="cy-new">5</b> new today
                    </p>
                  </div>
                  <p className="gl-role" id="cy-role">
                    Data Engineer · Hybrid
                  </p>
                  <p className="gl-elig yes" id="cy-elig">
                    ✓ Visa sponsorship offered
                  </p>
                </div>
                <div className="gl-cities" role="group" aria-label="Choose a city"></div>
                <figcaption className="fc-foot">Illustrative preview · sample data</figcaption>
              </figure>
              <a className="btn btn-ghost fbtn" href="/radar">
                Open the map
              </a>
            </li>
            <li className="fxi">
              <div className="fx-copy">
                <h3>
                  <span className="fnum" aria-hidden="true">
                    2
                  </span>
                  <span>Verified employer jobs</span>
                </h3>
                <p>Reposts and expired ads dropped.</p>
              </div>
              <figure className="fc" data-run="pages">
                <div className="fc-head">
                  <p className="fc-title">Frontend Developer · Bengaluru</p>
                  <div className="fc-track">
                    <i></i>
                  </div>
                  <div className="fc-status">
                    <span className="fc-phase">
                      <span className="ph on">
                        Scanning career sites <b>4,200</b>
                      </span>
                      <span className="ph">
                        Dropping reposts <b>2 hidden</b>
                      </span>
                    </span>
                    <span className="fc-count">
                      <b data-to="126">126</b>found
                    </span>
                  </div>
                </div>
                <ul className="fc-rows">
                  <li className="fr">
                    <div className="fr-in">
                      <span className="lg" style={{ background: "#0B1026" }}>
                        L
                      </span>
                      <span className="fr-txt">
                        <span className="fr-name">Lumen Labs</span>
                        <span className="fr-meta">lumenlabs.com/careers · 2h ago</span>
                      </span>
                      <span className="sp q" data-ok="1" aria-hidden="true"></span>
                    </div>
                  </li>
                  <li className="fr">
                    <div className="fr-in">
                      <span className="lg" style={{ background: "#8A93AE" }}>
                        J
                      </span>
                      <span className="fr-txt">
                        <span className="fr-name">JobHub</span>
                        <span className="fr-meta">Repost · listing 34 days old</span>
                      </span>
                      <span className="sp q" data-ok="0" aria-hidden="true"></span>
                    </div>
                  </li>
                  <li className="fr">
                    <div className="fr-in">
                      <span className="lg" style={{ background: "#2563EB" }}>
                        N
                      </span>
                      <span className="fr-txt">
                        <span className="fr-name">Northwind</span>
                        <span className="fr-meta">northwind.com/jobs · open now</span>
                      </span>
                      <span className="sp q" data-ok="1" aria-hidden="true"></span>
                    </div>
                  </li>
                  <li className="fr">
                    <div className="fr-in">
                      <span className="lg" style={{ background: "#8A93AE" }}>
                        ?
                      </span>
                      <span className="fr-txt">
                        <span className="fr-name">Unknown agency</span>
                        <span className="fr-meta">No employer link · unverified</span>
                      </span>
                      <span className="sp q" data-ok="0" aria-hidden="true"></span>
                    </div>
                  </li>
                </ul>
                <figcaption className="fc-foot">Illustration · sample data</figcaption>
              </figure>
              <a className="btn btn-ghost fbtn" href="/jobs">
                Explore jobs
              </a>
            </li>
            <li className="fxi">
              <div className="fx-copy">
                <h3>
                  <span className="fnum" aria-hidden="true">
                    3
                  </span>
                  <span>Personalized matches</span>
                </h3>
                <p>Know your fit before applying.</p>
              </div>
              <figure className="fc" data-run="match">
                <div className="fc-head">
                  <p className="fc-title">You: Data Analyst · 3 yrs · SQL, Python</p>
                  <div className="fc-track">
                    <i></i>
                  </div>
                  <div className="fc-status">
                    <span className="fc-phase">
                      <span className="ph on">
                        Matching open roles <b>1,860</b>
                      </span>
                      <span className="ph">
                        Ranking by fit <b>top 4</b>
                      </span>
                    </span>
                    <span className="fc-count">
                      <b data-to="38">38</b>strong fits
                    </span>
                  </div>
                </div>
                <ul className="fc-rows fc-rank">
                  <li className="fr" data-s="18">
                    <div className="fr-in">
                      <span className="lg" style={{ background: "#8A93AE" }}>
                        Z
                      </span>
                      <span className="fr-txt">
                        <span className="fr-name">
                          Sales Lead<small>@ZentroCRM</small>
                        </span>
                        <span className="chips">
                          <span className="ch" data-ok="0">
                            Sales exp
                          </span>
                          <span className="ch" data-ok="0">
                            CRM
                          </span>
                          <span className="ch" data-ok="1">
                            Excel
                          </span>
                        </span>
                      </span>
                      <span className="sc" aria-hidden="true">
                        <svg width="44" height="44" viewBox="0 0 44 44">
                          <circle
                            cx="22"
                            cy="22"
                            r="19"
                            stroke="#EEF0F5"
                            strokeWidth="3.5"
                            fill="none"
                          />
                          <circle
                            className="rg"
                            cx="22"
                            cy="22"
                            r="19"
                            fill="none"
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeDasharray="119.4"
                            strokeDashoffset="119.4"
                          />
                        </svg>
                        <b>0</b>
                      </span>
                    </div>
                  </li>
                  <li className="fr" data-s="92">
                    <div className="fr-in">
                      <span className="lg" style={{ background: "#2563EB" }}>
                        B
                      </span>
                      <span className="fr-txt">
                        <span className="fr-name">
                          Data Analyst<small>@Brightline</small>
                        </span>
                        <span className="chips">
                          <span className="ch" data-ok="1">
                            SQL
                          </span>
                          <span className="ch" data-ok="1">
                            Python
                          </span>
                          <span className="ch" data-ok="1">
                            3 yrs
                          </span>
                        </span>
                      </span>
                      <span className="sc" aria-hidden="true">
                        <svg width="44" height="44" viewBox="0 0 44 44">
                          <circle
                            cx="22"
                            cy="22"
                            r="19"
                            stroke="#EEF0F5"
                            strokeWidth="3.5"
                            fill="none"
                          />
                          <circle
                            className="rg"
                            cx="22"
                            cy="22"
                            r="19"
                            fill="none"
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeDasharray="119.4"
                            strokeDashoffset="119.4"
                          />
                        </svg>
                        <b>0</b>
                      </span>
                    </div>
                  </li>
                  <li className="fr" data-s="41">
                    <div className="fr-in">
                      <span className="lg" style={{ background: "#8A93AE" }}>
                        O
                      </span>
                      <span className="fr-txt">
                        <span className="fr-name">
                          Data Scientist<small>@Orbit</small>
                        </span>
                        <span className="chips">
                          <span className="ch" data-ok="1">
                            Python
                          </span>
                          <span className="ch" data-ok="0">
                            ML models
                          </span>
                          <span className="ch" data-ok="0">
                            PhD
                          </span>
                        </span>
                      </span>
                      <span className="sc" aria-hidden="true">
                        <svg width="44" height="44" viewBox="0 0 44 44">
                          <circle
                            cx="22"
                            cy="22"
                            r="19"
                            stroke="#EEF0F5"
                            strokeWidth="3.5"
                            fill="none"
                          />
                          <circle
                            className="rg"
                            cx="22"
                            cy="22"
                            r="19"
                            fill="none"
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeDasharray="119.4"
                            strokeDashoffset="119.4"
                          />
                        </svg>
                        <b>0</b>
                      </span>
                    </div>
                  </li>
                  <li className="fr" data-s="78">
                    <div className="fr-in">
                      <span className="lg" style={{ background: "#0B1026" }}>
                        N
                      </span>
                      <span className="fr-txt">
                        <span className="fr-name">
                          BI Analyst<small>@Northwind</small>
                        </span>
                        <span className="chips">
                          <span className="ch" data-ok="1">
                            SQL
                          </span>
                          <span className="ch" data-ok="1">
                            Excel
                          </span>
                          <span className="ch" data-ok="0">
                            Tableau
                          </span>
                        </span>
                      </span>
                      <span className="sc" aria-hidden="true">
                        <svg width="44" height="44" viewBox="0 0 44 44">
                          <circle
                            cx="22"
                            cy="22"
                            r="19"
                            stroke="#EEF0F5"
                            strokeWidth="3.5"
                            fill="none"
                          />
                          <circle
                            className="rg"
                            cx="22"
                            cy="22"
                            r="19"
                            fill="none"
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeDasharray="119.4"
                            strokeDashoffset="119.4"
                          />
                        </svg>
                        <b>0</b>
                      </span>
                    </div>
                  </li>
                </ul>
                <figcaption className="fc-foot">Illustration · sample data</figcaption>
              </figure>
              <a className="btn btn-ghost fbtn" href="/signup">
                Find my matches
              </a>
            </li>
          </ol>
        </section>

        <section className="s rv" aria-labelledby="rv-h">
          <div className="wrap">
            <h2 className="h2" id="rv-h">
              From early&#8209;access users
            </h2>
          </div>
          <ul className="rv-track" tabIndex={0} aria-label="Reviews, scroll sideways for more">
            <li className="rv-card">
              <blockquote>
                “Honestly didn't expect much but found an early-stage startup role here that wasn't
                on Naukri at all. Resume score feature is quite strict though!”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-1.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>RS</i>
                </span>
                <span>
                  <b>Rohan S.</b>
                  <small>Bengaluru</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “The AI editor caught so many formatting flaws in my CV. Got two interview callbacks
                within 10 days of fixing my score.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-1.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>PV</i>
                </span>
                <span>
                  <b>Pooja Verma</b>
                  <small>Pune</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “Job market is brutal right now, applying on LinkedIn felt useless. Found my current
                role listed here in the first week itself.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-2.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>AK</i>
                </span>
                <span>
                  <b>Aditya K.</b>
                  <small>Gurgaon</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “Resume scanner is super helpful, pointed out missing action verbs immediately. Site
                took a few seconds to load the jobs list once, but good tool overall.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-2.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>SM</i>
                </span>
                <span>
                  <b>Sneha M.</b>
                  <small>Hyderabad</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “Loved that it cuts through the usual sponsored listings garbage. Re-wrote my
                project points using the suggestions and my profile looks way sharper.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-3.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>TD</i>
                </span>
                <span>
                  <b>Tanmay Das</b>
                  <small>Kolkata</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “Such a clean concept. Most platforms just repost the same 50 corporate openings,
                but here I actually saw genuine hidden vacancies.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-3.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>KR</i>
                </span>
                <span>
                  <b>Kavita R.</b>
                  <small>Mumbai</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “Tired of competing with 800 applicants on every single posting. Found a niche
                seed-round role listed here that fit my background cleanly.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-4.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>BH</i>
                </span>
                <span>
                  <b>Brett H.</b>
                  <small>Austin, TX</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “UI has a few rough edges, but the verified job feed is legit. Easily saved me 10+
                hours of doomscrolling this week.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-4.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>EC</i>
                </span>
                <span>
                  <b>Elena C.</b>
                  <small>Seattle, WA</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “Resume review pointed out my bullets were way too wordy and gave me concrete fixes.
                Landed an interview 4 days later.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-5.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>MT</i>
                </span>
                <span>
                  <b>Marcus T.</b>
                  <small>Chicago, IL</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “Applying for remote global roles from China is usually painful. This helped me find
                open global positions that never show up locally.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-5.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>LW</i>
                </span>
                <span>
                  <b>Lin Wei</b>
                  <small>Shanghai</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “English resume scoring gave very practical suggestions for Western ATS systems.
                Fixed my grammar issues and boosted my score to 88.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-6.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>CH</i>
                </span>
                <span>
                  <b>Chen Hao</b>
                  <small>Beijing</small>
                </span>
              </div>
            </li>
            <li className="rv-card">
              <blockquote>
                “Very useful for discovering stealth and cross-border startups. Good tool, already
                recommended it to two college friends.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-6.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>YZ</i>
                </span>
                <span>
                  <b>Yifei Z.</b>
                  <small>Shenzhen</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Honestly didn't expect much but found an early-stage startup role here that wasn't
                on Naukri at all. Resume score feature is quite strict though!”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-1.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>RS</i>
                </span>
                <span>
                  <b>Rohan S.</b>
                  <small>Bengaluru</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “The AI editor caught so many formatting flaws in my CV. Got two interview callbacks
                within 10 days of fixing my score.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-1.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>PV</i>
                </span>
                <span>
                  <b>Pooja Verma</b>
                  <small>Pune</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Job market is brutal right now, applying on LinkedIn felt useless. Found my current
                role listed here in the first week itself.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-2.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>AK</i>
                </span>
                <span>
                  <b>Aditya K.</b>
                  <small>Gurgaon</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Resume scanner is super helpful, pointed out missing action verbs immediately. Site
                took a few seconds to load the jobs list once, but good tool overall.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-2.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>SM</i>
                </span>
                <span>
                  <b>Sneha M.</b>
                  <small>Hyderabad</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Loved that it cuts through the usual sponsored listings garbage. Re-wrote my
                project points using the suggestions and my profile looks way sharper.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-3.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>TD</i>
                </span>
                <span>
                  <b>Tanmay Das</b>
                  <small>Kolkata</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Such a clean concept. Most platforms just repost the same 50 corporate openings,
                but here I actually saw genuine hidden vacancies.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-3.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>KR</i>
                </span>
                <span>
                  <b>Kavita R.</b>
                  <small>Mumbai</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Tired of competing with 800 applicants on every single posting. Found a niche
                seed-round role listed here that fit my background cleanly.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-4.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>BH</i>
                </span>
                <span>
                  <b>Brett H.</b>
                  <small>Austin, TX</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “UI has a few rough edges, but the verified job feed is legit. Easily saved me 10+
                hours of doomscrolling this week.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-4.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>EC</i>
                </span>
                <span>
                  <b>Elena C.</b>
                  <small>Seattle, WA</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Resume review pointed out my bullets were way too wordy and gave me concrete fixes.
                Landed an interview 4 days later.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-5.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>MT</i>
                </span>
                <span>
                  <b>Marcus T.</b>
                  <small>Chicago, IL</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Applying for remote global roles from China is usually painful. This helped me find
                open global positions that never show up locally.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-5.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>LW</i>
                </span>
                <span>
                  <b>Lin Wei</b>
                  <small>Shanghai</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “English resume scoring gave very practical suggestions for Western ATS systems.
                Fixed my grammar issues and boosted my score to 88.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/male-6.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>CH</i>
                </span>
                <span>
                  <b>Chen Hao</b>
                  <small>Beijing</small>
                </span>
              </div>
            </li>
            <li className="rv-card" aria-hidden="true">
              <blockquote>
                “Very useful for discovering stealth and cross-border startups. Good tool, already
                recommended it to two college friends.”
              </blockquote>
              <div className="rv-by">
                <span className="mq-av">
                  <img
                    src="/images/avatars/female-6.webp"
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                  />
                  <i>YZ</i>
                </span>
                <span>
                  <b>Yifei Z.</b>
                  <small>Shenzhen</small>
                </span>
              </div>
            </li>
          </ul>
          <p className="rv-hint">Swipe for more</p>
        </section>

        <section className="wrap s fd" aria-labelledby="fd-h">
          <div className="founder">
            <img
              src="/owner.jpg"
              alt="Orissa Lee Patnaik, founder of CareerMonke"
              width="112"
              height="112"
              loading="lazy"
            />
            <div className="founder-body">
              <h2 id="fd-h">Orissa here!</h2>
              <p className="role">Creator of CareerMonke</p>
              <p className="bio">
                Growing up in the US and living in India showed me the friction of job hunting is
                universal. Broken software discards qualified people, and legacy sites make every
                role a cattle call.
              </p>
              <p className="bio">
                I built CareerMonke to cut through the noise, give candidates leverage back, and
                land your story directly with real people without the unnecessary hollow hustle
                rhetoric.
              </p>
              <div className="socials">
                <a
                  href="https://www.instagram.com/orissa.patnaik"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
                  </svg>
                </a>
                <a
                  href="https://www.linkedin.com/in/orissa-patnaik-85071a1aa/"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="LinkedIn"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
                    <rect x="2" y="9" width="4" height="12" />
                    <circle cx="4" cy="4" r="2" />
                  </svg>
                </a>
                <a href="mailto:support@careermonke.com" aria-label="Email">
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="wrap s band" aria-labelledby="q-h">
          <h2 className="h2" id="q-h">
            Frequently asked questions
          </h2>
          <div className="faq">
            <details>
              <summary>How is CareerMonke different from LinkedIn or Indeed?</summary>
              <p>
                Conventional job boards rely on sponsored placements, which creates huge applicant
                backlogs and ghost listings. CareerMonke focuses on verified, active openings so you
                spend your time on roles that are actually hiring.
              </p>
            </details>
            <details>
              <summary>Do you take a percentage of my compensation if I get hired?</summary>
              <p>
                Never. We are not a staffing agency, headhunter, or contingency recruiter. 100% of
                your compensation, equity offer, and signing bonus stays with you. We simply give
                you direct, unmediated access to open employer requisitions.
              </p>
            </details>
            <details>
              <summary>How often are the job feeds and ATS links updated?</summary>
              <p>
                Our job listings are refreshed regularly, and expired or closed positions are
                removed so you don't waste time applying to roles that are no longer open.
              </p>
            </details>
            <details>
              <summary>Can I filter jobs by remote status, country, and tech stack?</summary>
              <p>
                Yes! You can filter requisitions by global worldwide eligibility, timezone
                requirements, specific tech stacks (e.g., React, Node, Python, AI/ML), and seniority
                levels to find matches that fit your exact background.
              </p>
            </details>
            <details>
              <summary>Do I apply directly on the company website?</summary>
              <p>
                Yes, 100% of the time. Every job on CareerMonke links directly to the official
                company careers page or official ATS application form. There are no middleman forms,
                third-party redirects, or spam filters between you and the hiring team.
              </p>
            </details>
          </div>
        </section>

        <section className="wrap s" aria-labelledby="w-h">
          <h2 className="h2" id="w-h">
            What job seekers are saying
          </h2>
          <div className="wl" tabIndex={0} aria-label="Wall of reviews. Hover or focus to pause.">
            <ul className="wl-col wl-down">
              <li className="wl-card">
                <blockquote>
                  “Honestly didn't expect much but found an early-stage startup role here that
                  wasn't on Naukri at all. Resume score feature is quite strict though!”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-1.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>RS</i>
                  </span>
                  <span>
                    <b>Rohan S.</b>
                    <small>Bengaluru</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “Resume scanner is super helpful, pointed out missing action verbs immediately.
                  Site took a few seconds to load the jobs list once, but good tool overall.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-2.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>SM</i>
                  </span>
                  <span>
                    <b>Sneha M.</b>
                    <small>Hyderabad</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “Tired of competing with 800 applicants on every single posting. Found a niche
                  seed-round role listed here that fit my background cleanly.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-4.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>BH</i>
                  </span>
                  <span>
                    <b>Brett H.</b>
                    <small>Austin, TX</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “Applying for remote global roles from China is usually painful. This helped me
                  find open global positions that never show up locally.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-5.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>LW</i>
                  </span>
                  <span>
                    <b>Lin Wei</b>
                    <small>Shanghai</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Honestly didn't expect much but found an early-stage startup role here that
                  wasn't on Naukri at all. Resume score feature is quite strict though!”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-1.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>RS</i>
                  </span>
                  <span>
                    <b>Rohan S.</b>
                    <small>Bengaluru</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Resume scanner is super helpful, pointed out missing action verbs immediately.
                  Site took a few seconds to load the jobs list once, but good tool overall.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-2.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>SM</i>
                  </span>
                  <span>
                    <b>Sneha M.</b>
                    <small>Hyderabad</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Tired of competing with 800 applicants on every single posting. Found a niche
                  seed-round role listed here that fit my background cleanly.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-4.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>BH</i>
                  </span>
                  <span>
                    <b>Brett H.</b>
                    <small>Austin, TX</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Applying for remote global roles from China is usually painful. This helped me
                  find open global positions that never show up locally.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-5.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>LW</i>
                  </span>
                  <span>
                    <b>Lin Wei</b>
                    <small>Shanghai</small>
                  </span>
                </p>
              </li>
            </ul>
            <ul className="wl-col wl-up">
              <li className="wl-card">
                <blockquote>
                  “The AI editor caught so many formatting flaws in my CV. Got two interview
                  callbacks within 10 days of fixing my score.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-1.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>PV</i>
                  </span>
                  <span>
                    <b>Pooja Verma</b>
                    <small>Pune</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “Loved that it cuts through the usual sponsored listings garbage. Re-wrote my
                  project points using the suggestions and my profile looks way sharper.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-3.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>TD</i>
                  </span>
                  <span>
                    <b>Tanmay Das</b>
                    <small>Kolkata</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “UI has a few rough edges, but the verified job feed is legit. Easily saved me 10+
                  hours of doomscrolling this week.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-4.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>EC</i>
                  </span>
                  <span>
                    <b>Elena C.</b>
                    <small>Seattle, WA</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “English resume scoring gave very practical suggestions for Western ATS systems.
                  Fixed my grammar issues and boosted my score to 88.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-6.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>CH</i>
                  </span>
                  <span>
                    <b>Chen Hao</b>
                    <small>Beijing</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “The AI editor caught so many formatting flaws in my CV. Got two interview
                  callbacks within 10 days of fixing my score.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-1.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>PV</i>
                  </span>
                  <span>
                    <b>Pooja Verma</b>
                    <small>Pune</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Loved that it cuts through the usual sponsored listings garbage. Re-wrote my
                  project points using the suggestions and my profile looks way sharper.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-3.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>TD</i>
                  </span>
                  <span>
                    <b>Tanmay Das</b>
                    <small>Kolkata</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “UI has a few rough edges, but the verified job feed is legit. Easily saved me 10+
                  hours of doomscrolling this week.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-4.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>EC</i>
                  </span>
                  <span>
                    <b>Elena C.</b>
                    <small>Seattle, WA</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “English resume scoring gave very practical suggestions for Western ATS systems.
                  Fixed my grammar issues and boosted my score to 88.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-6.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>CH</i>
                  </span>
                  <span>
                    <b>Chen Hao</b>
                    <small>Beijing</small>
                  </span>
                </p>
              </li>
            </ul>
            <ul className="wl-col wl-down">
              <li className="wl-card">
                <blockquote>
                  “Job market is brutal right now, applying on LinkedIn felt useless. Found my
                  current role listed here in the first week itself.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-2.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>AK</i>
                  </span>
                  <span>
                    <b>Aditya K.</b>
                    <small>Gurgaon</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “Such a clean concept. Most platforms just repost the same 50 corporate openings,
                  but here I actually saw genuine hidden vacancies.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-3.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>KR</i>
                  </span>
                  <span>
                    <b>Kavita R.</b>
                    <small>Mumbai</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “Resume review pointed out my bullets were way too wordy and gave me concrete
                  fixes. Landed an interview 4 days later.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-5.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>MT</i>
                  </span>
                  <span>
                    <b>Marcus T.</b>
                    <small>Chicago, IL</small>
                  </span>
                </p>
              </li>
              <li className="wl-card">
                <blockquote>
                  “Very useful for discovering stealth and cross-border startups. Good tool, already
                  recommended it to two college friends.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-6.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>YZ</i>
                  </span>
                  <span>
                    <b>Yifei Z.</b>
                    <small>Shenzhen</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Job market is brutal right now, applying on LinkedIn felt useless. Found my
                  current role listed here in the first week itself.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-2.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>AK</i>
                  </span>
                  <span>
                    <b>Aditya K.</b>
                    <small>Gurgaon</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Such a clean concept. Most platforms just repost the same 50 corporate openings,
                  but here I actually saw genuine hidden vacancies.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-3.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>KR</i>
                  </span>
                  <span>
                    <b>Kavita R.</b>
                    <small>Mumbai</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Resume review pointed out my bullets were way too wordy and gave me concrete
                  fixes. Landed an interview 4 days later.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/male-5.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>MT</i>
                  </span>
                  <span>
                    <b>Marcus T.</b>
                    <small>Chicago, IL</small>
                  </span>
                </p>
              </li>
              <li className="wl-card" aria-hidden="true">
                <blockquote>
                  “Very useful for discovering stealth and cross-border startups. Good tool, already
                  recommended it to two college friends.”
                </blockquote>
                <p className="wl-by">
                  <span className="mq-av">
                    <img
                      src="/images/avatars/female-6.webp"
                      alt=""
                      width="28"
                      height="28"
                      loading="lazy"
                    />
                    <i>YZ</i>
                  </span>
                  <span>
                    <b>Yifei Z.</b>
                    <small>Shenzhen</small>
                  </span>
                </p>
              </li>
            </ul>
          </div>
        </section>

        <section className="free-preview-band" aria-labelledby="cta-h">
          <div className="wrap free-preview">
            <h2 className="fp-title" id="cta-h">
              Free preview
            </h2>
            <p className="fp-sub">
              No commitment. Just window shopping for your dream job. Job maxxing starts here.
            </p>
            <div className="fp-row">
              <a className="fp-btn fp-btn-white" href="/jobs">
                View Jobs <span aria-hidden="true">→</span>
              </a>
              <a className="fp-btn fp-btn-outline" href="/signup">
                See my Ideal Match <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        </section>
        <footer>
          <div className="wrap">
            <div className="f-top">
              <a href="/" aria-label="CareerMonke home">
                <img
                  src="/careermonke-logo.png"
                  alt="CareerMonke"
                  width="66"
                  height="80"
                  loading="lazy"
                />
              </a>
            </div>
            <nav className="f-grid" aria-label="Footer">
              <div className="f-group">
                <h3>Product</h3>
                <a href="/jobs">Live Job Search</a>
                <a href="/worldwide">Companies Hiring</a>
                <a href="/pricing">Pricing &amp; Plans</a>
                <a href="/login">Member Sign In</a>
                <a href="/worldwide">Worldwide Directory</a>
                <a href="mailto:support@careermonke.com">Support</a>
              </div>
              <div className="f-group">
                <h3>Company</h3>
                <a href="/about">About Us</a>
                <a href="/contact">Contact Us</a>
                <a href="/privacy-policy">Privacy Policy</a>
                <a href="/terms-and-conditions">Terms &amp; Conditions</a>
                <a href="/refund-policy">Refund Policy</a>
                <a href="https://x.com/careermonke">X (Twitter)</a>
                <a href="https://linkedin.com/company/careermonke">LinkedIn</a>
              </div>
            </nav>
            <p className="copy">© 2026 Olive Ridley Media Private Limited. All rights reserved.</p>
          </div>
        </footer>

        <aside className="sb" aria-label="View jobs">
          <img src="/careermonke-logo.png" alt="CareerMonke logo" width="56" height="56" />
          <p>
            <b>CareerMonke</b>
            <span>Verified jobs, direct from employers</span>
          </p>
          <a href="/jobs">
            View Jobs <span aria-hidden="true">→</span>
          </a>
        </aside>
      </div>
    </>
  );
}
