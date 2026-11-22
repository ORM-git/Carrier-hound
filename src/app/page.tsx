/* eslint-disable react/no-unescaped-entities */
"use client";

// Home page: exact port of the approved landing in ORM-git/ssampe index.html @ f21504b.
import React, { useEffect } from "react";
import { Plus_Jakarta_Sans } from "next/font/google";
import "@/styles/careermonke-landing.css";
import { initCareerMonkeLanding } from "@/components/landing/careermonke-landing-runtime";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
  variable: "--font-cm-jakarta",
  adjustFontFallback: false, // glyphs Jakarta lacks (→ ✓) must fall back to system-ui, as in the source
});

export default function HomePage() {
  useEffect(() => initCareerMonkeLanding(), []);

  return (
    <div className={`landing-wrapper ${jakarta.variable}`}>
      <main className="fold">
        <header className="hero">
          <div className="container">
            <nav className="nav">
              <a href="#" className="brand">
                <span className="brand-mark">CM</span>CareerMonke
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
                        <button className="more" aria-label="More options">•••</button>
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
  );
}
