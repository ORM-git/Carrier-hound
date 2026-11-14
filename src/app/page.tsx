/* eslint-disable @next/next/no-img-element, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/heading-has-content, react/no-unescaped-entities */
"use client";

import React, { useEffect } from "react";
import "@/styles/careermonke-landing.css";
import { initCareerMonkeLanding } from "@/components/landing/careermonke-landing-runtime";
import LandingJobsTickerStrip from "@/components/LandingJobsTickerStrip";

export default function HomePage() {
  useEffect(() => {
    const cleanup = initCareerMonkeLanding();
    return cleanup;
  }, []);

  return (
    <div className="landing-wrapper">

<a className="skip" href="#main">Skip to content</a>
<svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true"><symbol id="laurel" viewBox="0 0 20 48"><path d="M17 47C5 40 3 20 11 2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><g fill="currentColor"><ellipse cx="9.9" cy="44.4" rx="2.3" ry="4.6" transform="rotate(-78 9.9 44.4)"/><ellipse cx="15.7" cy="42.4" rx="1.9" ry="3.8" transform="rotate(-8 15.7 42.4)"/><ellipse cx="6.3" cy="39.3" rx="2.3" ry="4.6" transform="rotate(-62 6.3 39.3)"/><ellipse cx="12.1" cy="37.3" rx="1.9" ry="3.8" transform="rotate(8 12.1 37.3)"/><ellipse cx="4.0" cy="32.9" rx="2.3" ry="4.6" transform="rotate(-48 4.0 32.9)"/><ellipse cx="9.8" cy="30.9" rx="1.9" ry="3.8" transform="rotate(22 9.8 30.9)"/><ellipse cx="3.0" cy="25.6" rx="2.3" ry="4.6" transform="rotate(-37 3.0 25.6)"/><ellipse cx="8.8" cy="23.6" rx="1.9" ry="3.8" transform="rotate(33 8.8 23.6)"/><ellipse cx="3.4" cy="17.8" rx="2.3" ry="4.6" transform="rotate(-27 3.4 17.8)"/><ellipse cx="9.2" cy="15.8" rx="1.9" ry="3.8" transform="rotate(43 9.2 15.8)"/><ellipse cx="5.2" cy="9.6" rx="2.3" ry="4.6" transform="rotate(-18 5.2 9.6)"/></g></symbol></svg>

<header className="wrap top band">
  <a className="brand" href="/" aria-label="CareerMonke home">
    <img src="/icon.png" alt="" width="32" height="32" />CareerMonke
  </a>
  <nav aria-label="Account">
    <a className="signin" href="/login">Sign in</a>
    <a className="btn btn-primary btn-sm" href="/signup">Sign up free</a>
  </nav>
</header>

<main className="min-h-screen" id="main">
  {/* HERO */}
  <section className="wrap hero band" aria-labelledby="hero-h">
    <div className="hsp hsp0" aria-hidden="true"></div>
    <div className="hero-top">
    <p className="badge"><i aria-hidden="true"></i>1,240 new jobs found today</p>
    <h1 id="hero-h"><span className="l1">Skip LinkedIn competition</span> <span className="l2">Start <span className="nw">job<span className="mx" aria-label="maxx"><span className="m1" aria-hidden="true">m</span><span className="m2" aria-hidden="true">a</span><span className="m3" aria-hidden="true">x</span><span className="m4" aria-hidden="true">x</span></span>ing</span> with&nbsp;AI</span></h1>
    <p className="sub">Get direct roles from company sites and tailor your resume to clear their ATS in seconds.</p>
    <div className="cta-row">
      <a className="btn btn-primary" href="/signup">Sign up for free</a>
      <a className="btn btn-ghost" href="#demo" id="try-demo">Try the demo</a>
    </div>
    </div>

    {/* DEMO */}
    <div className="hsp hsp1" aria-hidden="true"></div>
    <div className="demo-wrap" id="demo">
      <section className="demo" aria-label="Interactive demo with sample jobs">
        <div className="demo-bar">
          <span className="dots" aria-hidden="true"><i></i><i></i><i></i></span>
          <ol className="steps" aria-label="Demo progress">
            <li data-step="0" className="on" aria-current="step">Find</li>
            <li data-step="1">Match</li>
            <li data-step="2">Tailor</li>
            <li data-step="3">Send</li>
          </ol>
          <span className="demo-tag">Sample jobs</span>
        </div>
        <div className="demo-body">
          {/* 1 pick */}
          <div className="state" data-state="pick">
            <h2 className="q" tabIndex={-1}>What kind of job do you want?</h2>
            <div className="fields" role="group" aria-label="Job fields">
              <span className="hand" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24"><path d="M9 11.2V4.6a1.6 1.6 0 0 1 3.2 0v5.2l.1-.9a1.6 1.6 0 0 1 3.2.2v1.1a1.6 1.6 0 0 1 3.2.3v.9a1.5 1.5 0 0 1 3 .2v3.9c0 3.6-2.6 6.5-6.2 6.5h-1.6c-2 0-3.8-1-4.9-2.6L4.6 14a1.6 1.6 0 0 1 2.6-1.9z" fill="#fff" stroke="#090E34" strokeWidth="1.5" strokeLinejoin="round"/></svg></span>
              <button className="chip" type="button" data-field="backend">Backend</button>
              <button className="chip" type="button" data-field="remote">Remote</button>
              <button className="chip" type="button" data-field="marketing">Marketing</button>
              <button className="chip" type="button" data-field="data">Data &amp; AI</button>
              <button className="chip" type="button" data-field="sales">Sales</button>
              <button className="chip" type="button" data-field="design">Design</button>
            </div>
            <p className="hint">Tap a job type to try it.</p>
          </div>
          {/* 2 scan */}
          <div className="state" data-state="scan" hidden>
            <div className="scan">
              <h2 className="q" tabIndex={-1}>Checking career pages…</h2>
              <p className="hint" id="scan-sub">Looking for jobs that fit you</p>
              <div className="bar" aria-hidden="true"><b id="scan-bar"></b></div>
              <div className="counters">
                <div className="counter"><strong id="c-pages">0</strong><span>pages checked</span></div>
                <div className="counter"><strong id="c-jobs">0</strong><span>jobs for you</span></div>
              </div>
            </div>
          </div>
          {/* 3 match / 4 tailor */}
          <div className="state" data-state="match" hidden>
            <p className="found" id="found"></p>
            <div className="job">
              <span className="logo" id="j-logo" aria-hidden="true">F</span>
              <div className="job-txt">
                <h2 className="job-title q" tabIndex={-1} id="j-title"></h2>
                <p className="job-meta" id="j-meta"></p>
                <p className="job-meta2"><span>Only on company site</span> · <span id="j-posted"></span></p>
              </div>
              <div className="score" role="img" id="score" aria-label="">
                <svg width="52" height="52" viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="22" stroke="#EFF4FF" strokeWidth="6" fill="none"/><circle id="ring" cx="26" cy="26" r="22" stroke="#2563EB" strokeWidth="6" fill="none" strokeLinecap="round" strokeDasharray="138.2" strokeDashoffset="138.2" style={{ transition: "stroke-dashoffset .6s ease" }}/></svg>
                <span className="num" id="score-num" aria-hidden="true">0%</span>
                <span className="gain" id="j-gain" aria-hidden="true"></span>
              </div>
            </div>
            <div id="m-panel">
              <div className="skills"><span id="m-label">3 skills missing:</span><span id="m-skills" style={{ display: "contents" }}></span></div>
            </div>
            <div id="t-panel" hidden>
              <div className="resume" aria-live="polite"><small id="t-for"></small><span id="t-line"></span></div>
            </div>
            <button className="btn btn-primary" type="button" id="act" aria-label="Tailor my resume">Tailor my resume</button>
          </div>
          {/* 5 applied */}
          <div className="state" data-state="applied" hidden>
            <div className="done-wrap">
              <span className="done-ico" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 22 22"><path d="M5 11.5l4 4 8-9" stroke="#0F7A42" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
              <h2 className="q" tabIndex={-1}>Applied in 18 seconds.</h2>
              <p id="applied-sub">Found early, tailored for the role, and sent straight to the company. That&apos;s the whole hunt.</p>
              <div className="done-btns">
                <a className="btn btn-primary" href="/signup">Get my real matches</a>
                <button className="btn btn-ghost" type="button" id="again">Try another field</button>
              </div>
            </div>
          </div>
        </div>
        <p className="sr" aria-live="polite" id="announce"></p>
      </section>
    </div>
    <div className="hsp hsp2" aria-hidden="true"></div>
    <dl className="stats" aria-label="CareerMonke in numbers" aria-describedby="stats-note">
      <div><dd><span className="wr"><svg className="lf" aria-hidden="true"><use href="#laurel"/></svg><b>3x</b><svg className="lf r" aria-hidden="true"><use href="#laurel"/></svg></span></dd><dt>higher callback rate</dt></div>
      <div><dd><span className="wr"><svg className="lf" aria-hidden="true"><use href="#laurel"/></svg><b>94%</b><svg className="lf r" aria-hidden="true"><use href="#laurel"/></svg></span></dd><dt>ATS keyword alignment</dt></div>
      <div><dd><span className="wr"><svg className="lf" aria-hidden="true"><use href="#laurel"/></svg><b>1,200+</b><svg className="lf r" aria-hidden="true"><use href="#laurel"/></svg></span></dd><dt>fresh roles <span className="sbr">daily</span></dt></div>
    </dl>
    <p className="stats-note" id="stats-note">*Based on early access user surveys</p>
  </section>

  <LandingJobsTickerStrip />

  {/* FEATURES */}
  <section className="wrap s" aria-labelledby="feat-h">
    <h2 className="h2" id="feat-h">The whole hunt, in one place</h2>
    <ol className="fx">
      <li className="fxi">
        <div className="fx-copy">
          <h3><span className="fnum" aria-hidden="true">1</span><span>Explore jobs by city</span></h3>
          <p>Work setup and eligibility, checked.</p>
        </div>
        <figure className="fc gl" data-run="city">
          <div className="gl-stage">
            <canvas className="globe" id="globe" width="248" height="248" role="img" aria-label="Interactive globe with six sample cities. Drag to spin, or pick a city below."></canvas>
            <span className="gl-hint" id="gl-hint" aria-hidden="true">Drag to spin · tap a city</span>
          </div>
          <div className="gl-detail" aria-live="polite">
            <div className="gl-row1"><p className="gl-city"><span id="cy-name">London</span><small>Sample</small></p><p className="gl-stats"><b id="cy-jobs">37</b> jobs · <b id="cy-new">5</b> new today</p></div>
            <p className="gl-role" id="cy-role">Data Engineer · Hybrid</p>
            <p className="gl-elig yes" id="cy-elig">✓ Visa sponsorship offered</p>
          </div>
          <div className="gl-cities" role="group" aria-label="Choose a city"></div>
          <figcaption className="fc-foot">Illustrative preview · sample data</figcaption>
        </figure>
        <a className="btn btn-ghost fbtn" href="/radar">Open the map</a>
      </li>
      <li className="fxi">
        <div className="fx-copy">
          <h3><span className="fnum" aria-hidden="true">2</span><span>Jobs from career pages</span></h3>
          <p>Reposts and expired ads dropped.</p>
        </div>
        <figure className="fc" data-run="pages">
        <div className="fc-head">
          <p className="fc-title">Frontend Developer · Bengaluru</p>
          <div className="fc-track"><i></i></div>
          <div className="fc-status"><span className="fc-phase"><span className="ph on">Scanning career sites <b>4,200</b></span><span className="ph">Dropping reposts <b>2 hidden</b></span></span><span className="fc-count"><b data-to="126">126</b>found</span></div>
        </div>
          <ul className="fc-rows">
          <li className="fr"><div className="fr-in"><span className="lg" style={{ background: "#0B1026" }}>L</span><span className="fr-txt"><span className="fr-name">Lumen Labs</span><span className="fr-meta">lumenlabs.com/careers · 2h ago</span></span><span className="sp q" data-ok="1" aria-hidden="true"></span></div></li>
          <li className="fr"><div className="fr-in"><span className="lg" style={{ background: "#8A93AE" }}>J</span><span className="fr-txt"><span className="fr-name">JobHub</span><span className="fr-meta">Repost · listing 34 days old</span></span><span className="sp q" data-ok="0" aria-hidden="true"></span></div></li>
          <li className="fr"><div className="fr-in"><span className="lg" style={{ background: "#2563EB" }}>N</span><span className="fr-txt"><span className="fr-name">Northwind</span><span className="fr-meta">northwind.com/jobs · open now</span></span><span className="sp q" data-ok="1" aria-hidden="true"></span></div></li>
          <li className="fr"><div className="fr-in"><span className="lg" style={{ background: "#8A93AE" }}>?</span><span className="fr-txt"><span className="fr-name">Unknown agency</span><span className="fr-meta">No employer link · unverified</span></span><span className="sp q" data-ok="0" aria-hidden="true"></span></div></li>
          </ul>
          <figcaption className="fc-foot">Illustration · sample data</figcaption>
        </figure>
        <a className="btn btn-ghost fbtn" href="/jobs">Explore jobs</a>
      </li>
      <li className="fxi">
        <div className="fx-copy">
          <h3><span className="fnum" aria-hidden="true">3</span><span>A resume for every role</span></h3>
          <p>Honest edits, plus a cover letter.</p>
        </div>
        <figure className="fc" data-run="tailor">
          <div className="tl-top"><span className="lg" style={{ background: "#0B1026" }}>L</span><span className="fr-txt"><span className="fr-name">Frontend Developer</span><span className="fr-meta">@Lumen Labs · resume match</span></span><span className="sc big" aria-hidden="true"><svg width="56" height="56" viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" stroke="#EFF4FF" strokeWidth="3" fill="none"/><circle className="rg" cx="22" cy="22" r="19" stroke="#2563EB" fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray="119.4" strokeDashoffset="119.4"/></svg><b>0%</b></span></div>
          <div className="tl-bar"><b>Tailoring your resume</b><span className="sp t1" aria-hidden="true"></span></div>
          <div className="doc">
            <div className="doc-h"><b>Your resume</b><span>for Lumen Labs</span></div>
            <div className="chips"><span className="ch y">React</span><span className="ch y">TypeScript</span><span className="ch gap" data-fix="1">GraphQL APIs</span><span className="ch gap" data-fix="2">Accessibility</span><span className="ch none">Leadership · not in your history</span></div>
            <ul className="doc-b">
              <li><span className="old">Built APIs for the checkout team</span><span className="new" data-new="Built GraphQL APIs for the checkout team">Built GraphQL APIs for the checkout team</span></li>
              <li><span className="old">Improved the web app's usability</span><span className="new" data-new="Made checkout accessible (WCAG AA) for screen readers">Made checkout accessible (WCAG AA) for screen readers</span></li>
            </ul>
            <p className="doc-f show">✓ Cover letter drafted · 1 gap left honest</p>
          </div>
          <figcaption className="fc-foot">Illustration · sample data</figcaption>
        </figure>
        <a className="btn btn-ghost fbtn" href="/signup">Try AI resume tools</a>
      </li>
      <li className="fxi">
        <div className="fx-copy">
          <h3><span className="fnum" aria-hidden="true">4</span><span>Personalized matches</span></h3>
          <p>Know your fit before applying.</p>
        </div>
        <figure className="fc" data-run="match">
        <div className="fc-head">
          <p className="fc-title">You: Data Analyst · 3 yrs · SQL, Python</p>
          <div className="fc-track"><i></i></div>
          <div className="fc-status"><span className="fc-phase"><span className="ph on">Matching open roles <b>1,860</b></span><span className="ph">Ranking by fit <b>top 4</b></span></span><span className="fc-count"><b data-to="38">38</b>strong fits</span></div>
        </div>
          <ul className="fc-rows fc-rank">
          <li className="fr" data-s="18"><div className="fr-in"><span className="lg" style={{ background: "#8A93AE" }}>Z</span><span className="fr-txt"><span className="fr-name">Sales Lead<small>@ZentroCRM</small></span><span className="chips"><span className="ch" data-ok="0">Sales exp</span><span className="ch" data-ok="0">CRM</span><span className="ch" data-ok="1">Excel</span></span></span><span className="sc" aria-hidden="true"><svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" stroke="#EEF0F5" strokeWidth="3.5" fill="none"/><circle className="rg" cx="22" cy="22" r="19" fill="none" strokeWidth="3.5" strokeLinecap="round" strokeDasharray="119.4" strokeDashoffset="119.4"/></svg><b>0</b></span></div></li>
          <li className="fr" data-s="92"><div className="fr-in"><span className="lg" style={{ background: "#2563EB" }}>B</span><span className="fr-txt"><span className="fr-name">Data Analyst<small>@Brightline</small></span><span className="chips"><span className="ch" data-ok="1">SQL</span><span className="ch" data-ok="1">Python</span><span className="ch" data-ok="1">3 yrs</span></span></span><span className="sc" aria-hidden="true"><svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" stroke="#EEF0F5" strokeWidth="3.5" fill="none"/><circle className="rg" cx="22" cy="22" r="19" fill="none" strokeWidth="3.5" strokeLinecap="round" strokeDasharray="119.4" strokeDashoffset="119.4"/></svg><b>0</b></span></div></li>
          <li className="fr" data-s="41"><div className="fr-in"><span className="lg" style={{ background: "#8A93AE" }}>O</span><span className="fr-txt"><span className="fr-name">Data Scientist<small>@Orbit</small></span><span className="chips"><span className="ch" data-ok="1">Python</span><span className="ch" data-ok="0">ML models</span><span className="ch" data-ok="0">PhD</span></span></span><span className="sc" aria-hidden="true"><svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" stroke="#EEF0F5" strokeWidth="3.5" fill="none"/><circle className="rg" cx="22" cy="22" r="19" fill="none" strokeWidth="3.5" strokeLinecap="round" strokeDasharray="119.4" strokeDashoffset="119.4"/></svg><b>0</b></span></div></li>
          <li className="fr" data-s="78"><div className="fr-in"><span className="lg" style={{ background: "#0B1026" }}>N</span><span className="fr-txt"><span className="fr-name">BI Analyst<small>@Northwind</small></span><span className="chips"><span className="ch" data-ok="1">SQL</span><span className="ch" data-ok="1">Excel</span><span className="ch" data-ok="0">Tableau</span></span></span><span className="sc" aria-hidden="true"><svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" stroke="#EEF0F5" strokeWidth="3.5" fill="none"/><circle className="rg" cx="22" cy="22" r="19" fill="none" strokeWidth="3.5" strokeLinecap="round" strokeDasharray="119.4" strokeDashoffset="119.4"/></svg><b>0</b></span></div></li>
          </ul>
          <figcaption className="fc-foot">Illustration · sample data</figcaption>
        </figure>
        <a className="btn btn-ghost fbtn" href="/signup">Find my matches</a>
      </li>
    </ol>
  </section>

  {/* TESTIMONIALS */}
  <section className="wrap s band" aria-labelledby="t-h">
    <h2 className="h2" id="t-h">From early&#8209;access users</h2>
    <div className="mq" tabIndex={0} aria-label="Quotes from early-access users. Hover or focus to pause.">
      <ul className="mq-track">
          <li className="mq-card"><figure><blockquote>“Honestly didn&#39;t expect much but found an early-stage startup role here that wasn&#39;t on Naukri at all. Resume score feature is quite strict though!”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-1.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>RS</i></span><span><b>Rohan S.</b><small>Bengaluru</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“The AI editor caught so many formatting flaws in my CV. Got two interview callbacks within 10 days of fixing my score.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-1.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>PV</i></span><span><b>Pooja Verma</b><small>Pune</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“Job market is brutal right now, applying on LinkedIn felt useless. Found my current role through this scraper in the first week itself.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-2.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>AK</i></span><span><b>Aditya K.</b><small>Gurgaon</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“Resume scanner is super helpful, pointed out missing action verbs immediately. Site took a few seconds to load the jobs list once, but good tool overall.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-2.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>SM</i></span><span><b>Sneha M.</b><small>Hyderabad</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“Loved that it cuts through the usual sponsored listings garbage. Re-wrote my project points using the suggestions and my profile looks way sharper.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-3.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>TD</i></span><span><b>Tanmay Das</b><small>Kolkata</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“Such a clean concept. Most platforms just repost the same 50 corporate openings, but here I actually saw genuine hidden vacancies.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-3.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>KR</i></span><span><b>Kavita R.</b><small>Mumbai</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“Tired of competing with 800 applicants on every single posting. The scraper pulled a niche seed-round role that fit my background cleanly.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-4.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>BH</i></span><span><b>Brett H.</b><small>Austin, TX</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“UI has a few rough edges, but the scraped job feed is legit. Easily saved me 10+ hours of doomscrolling this week.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-4.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>EC</i></span><span><b>Elena C.</b><small>Seattle, WA</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“Resume review pointed out my bullets were way too wordy and gave me concrete fixes. Landed an interview 4 days later.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-5.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>MT</i></span><span><b>Marcus T.</b><small>Chicago, IL</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“Applying for remote global roles from China is usually painful. This helped me find open global positions that never show up locally.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-5.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>LW</i></span><span><b>Lin Wei</b><small>Shanghai</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“English resume scoring gave very practical suggestions for Western ATS systems. Fixed my grammar issues and boosted my score to 88.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-6.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>CH</i></span><span><b>Chen Hao</b><small>Beijing</small></span></figcaption></figure></li>
          <li className="mq-card"><figure><blockquote>“Very useful for discovering stealth and cross-border startups. Good tool, already recommended it to two college friends.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-6.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>YZ</i></span><span><b>Yifei Z.</b><small>Shenzhen</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Honestly didn&#39;t expect much but found an early-stage startup role here that wasn&#39;t on Naukri at all. Resume score feature is quite strict though!”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-1.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>RS</i></span><span><b>Rohan S.</b><small>Bengaluru</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“The AI editor caught so many formatting flaws in my CV. Got two interview callbacks within 10 days of fixing my score.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-1.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>PV</i></span><span><b>Pooja Verma</b><small>Pune</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Job market is brutal right now, applying on LinkedIn felt useless. Found my current role through this scraper in the first week itself.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-2.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>AK</i></span><span><b>Aditya K.</b><small>Gurgaon</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Resume scanner is super helpful, pointed out missing action verbs immediately. Site took a few seconds to load the jobs list once, but good tool overall.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-2.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>SM</i></span><span><b>Sneha M.</b><small>Hyderabad</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Loved that it cuts through the usual sponsored listings garbage. Re-wrote my project points using the suggestions and my profile looks way sharper.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-3.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>TD</i></span><span><b>Tanmay Das</b><small>Kolkata</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Such a clean concept. Most platforms just repost the same 50 corporate openings, but here I actually saw genuine hidden vacancies.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-3.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>KR</i></span><span><b>Kavita R.</b><small>Mumbai</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Tired of competing with 800 applicants on every single posting. The scraper pulled a niche seed-round role that fit my background cleanly.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-4.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>BH</i></span><span><b>Brett H.</b><small>Austin, TX</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“UI has a few rough edges, but the scraped job feed is legit. Easily saved me 10+ hours of doomscrolling this week.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-4.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>EC</i></span><span><b>Elena C.</b><small>Seattle, WA</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Resume review pointed out my bullets were way too wordy and gave me concrete fixes. Landed an interview 4 days later.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-5.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>MT</i></span><span><b>Marcus T.</b><small>Chicago, IL</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Applying for remote global roles from China is usually painful. This helped me find open global positions that never show up locally.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-5.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>LW</i></span><span><b>Lin Wei</b><small>Shanghai</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“English resume scoring gave very practical suggestions for Western ATS systems. Fixed my grammar issues and boosted my score to 88.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/male-6.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>CH</i></span><span><b>Chen Hao</b><small>Beijing</small></span></figcaption></figure></li>
          <li className="mq-card" aria-hidden="true"><figure><blockquote>“Very useful for discovering stealth and cross-border startups. Good tool, already recommended it to two college friends.”</blockquote><figcaption><span className="mq-av"><img src="/images/avatars/female-6.webp" alt="" width="36" height="36" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>YZ</i></span><span><b>Yifei Z.</b><small>Shenzhen</small></span></figcaption></figure></li>
      </ul>
    </div>
  </section>

  {/* COMPARE */}
  <section className="wrap s" aria-labelledby="cmp-h">
    <h2 className="h2" id="cmp-h">The Usual Grind vs The CareerMonke Way</h2>
    <table className="vs" id="vs">
      <caption className="sr">The usual grind compared with the CareerMonke way</caption>
      <thead><tr><th scope="col">The Usual Grind</th><th scope="col"><img src="/mascot.png" alt="" width="22" height="22" />The CareerMonke Way</th></tr></thead>
      <tbody>
        <tr><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><g className="a-bob"><circle cx="8" cy="12" r="2.6"/><path d="M4 21a4 4 0 0 1 8 0"/></g><g className="a-bob d2"><circle cx="16" cy="10" r="2.8"/><path d="M11.5 19.5a4.5 4.5 0 0 1 9 0"/></g><g className="a-bob d3"><circle cx="24" cy="12" r="2.6"/><path d="M20 21a4 4 0 0 1 8 0"/></g><path d="M5 27h22" opacity=".5"/></svg><i className="vb no" aria-hidden="true">✕</i></span><span className="vx">800+ applicants per listing</span></td><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="8" width="11" height="19" rx="1.5"/><path d="M6.5 12h1M10 12h1M6.5 16h1M10 16h1M6.5 20h1M10 20h1"/><path className="a-dash" d="M15 17.5h8"/><path d="M21 14.5l3 3-3 3"/><circle cx="28" cy="12" r="2.2"/><path d="M25 20a3 3 0 0 1 6 0"/></svg><i className="vb ok" aria-hidden="true">✓</i></span><span className="vx">Under 20 applicants, direct</span></td></tr>
        <tr><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="6" y="5" width="15" height="21" rx="2"/><path d="M9.5 10h8M9.5 14h8M9.5 18h5"/><g className="a-write"><path d="M21 23l6-9 2.5 1.6-6 9-3 1z"/></g></svg><i className="vb no" aria-hidden="true">✕</i></span><span className="vx">Hours tailoring every bullet</span></td><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="6" width="15" height="21" rx="2"/><path d="M8.5 11h8M8.5 15h8M8.5 19h5"/><path className="a-twinkle" d="M25 4.5l1.3 3.2 3.2 1.3-3.2 1.3L25 13.5l-1.3-3.2L20.5 9l3.2-1.3z" fill="currentColor" stroke="none"/></svg><i className="vb ok" aria-hidden="true">✓</i></span><span className="vx">1-tap ATS-matched resume</span></td></tr>
        <tr><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><g className="a-spin"><circle cx="16" cy="16" r="11" strokeDasharray="3 3"/></g><circle cx="16" cy="16" r="6"/><circle cx="16" cy="16" r="2.2" fill="currentColor"/></svg><i className="vb no" aria-hidden="true">✕</i></span><span className="vx">Resumes lost in black holes</span></td><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 22a11 11 0 0 1 22 0"/><path d="M8.5 14.5l1.4 1.2M16 11v2M23.5 14.5l-1.4 1.2" opacity=".6"/><g className="a-needle"><path d="M16 22l0-8.5"/></g><circle cx="16" cy="22" r="2" fill="currentColor"/></svg><i className="vb ok" aria-hidden="true">✓</i></span><span className="vx">Instant keyword match score</span></td></tr>
        <tr><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><g className="a-bob"><path d="M9 27V14a7 7 0 0 1 14 0v13l-2.4-2-2.3 2-2.3-2-2.3 2-2.3-2z"/><circle cx="13.5" cy="15" r="1" fill="currentColor"/><circle cx="18.5" cy="15" r="1" fill="currentColor"/></g></svg><i className="vb no" aria-hidden="true">✕</i></span><span className="vx">Ghost and expired reposts</span></td><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 27V17h7v10M22.5 20.5h2M22.5 23.5h2" opacity=".55"/><g className="a-seek"><circle cx="12" cy="12" r="6.5"/><path d="M16.8 16.8L21 21"/></g></svg><i className="vb ok" aria-hidden="true">✓</i></span><span className="vx">Live from verified career sites</span></td></tr>
        <tr><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="8" width="20" height="15" rx="2"/><path d="M4.5 9l9.5 7 9.5-7"/><g className="a-bob"><circle cx="25" cy="22" r="5" fill="#fff"/><path d="M23 20l4 4M27 20l-4 4"/></g></svg><i className="vb no" aria-hidden="true">✕</i></span><span className="vx">Auto-rejected in 10 minutes</span></td><td><span className="vt"><svg className="vi" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><g className="a-blink"><path d="M3 16s4.5-8 13-8 13 8 13 8-4.5 8-13 8S3 16 3 16z"/><circle cx="16" cy="16" r="3.6"/></g></svg><i className="vb ok" aria-hidden="true">✓</i></span><span className="vx">Seen by recruiters early</span></td></tr>
      </tbody>
    </table>
  </section>

  {/* FINAL CTA */}
  <section className="free-preview-band" aria-labelledby="cta-h">
    <div className="wrap free-preview">
      <h2 className="fp-title" id="cta-h">Free preview</h2>
      <p className="fp-sub">No commitment. Just window shopping for your dream job. Job maxxing starts here.</p>
      <div className="fp-row">
        <a className="fp-btn fp-btn-white" href="/jobs">View Jobs <span aria-hidden="true">→</span></a>
        <a className="fp-btn fp-btn-outline" href="/signup">See my Ideal Match <span aria-hidden="true">→</span></a>
      </div>
    </div>
  </section>

  {/* FOUNDER */}
  <section className="wrap s founder-section" aria-labelledby="f-h">
    <div className="founder">
      <img src="/owner.jpg" alt="Orissa Lee Patnaik, founder of CareerMonke" width="112" height="112" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
      <div className="founder-body">
        <h2 id="f-h">Orissa here!</h2>
        <p className="role">Creator of CareerMonke</p>
        <p className="bio">Growing up in the US and living in India showed me the friction of job hunting is universal. Broken software discards qualified people, and legacy sites make every role a cattle call.</p>
        <p className="bio">I built CareerMonke to cut through the noise, give candidates leverage back, and land your story directly with real people without the unnecessary hollow hustle rhetoric.</p>
        <div className="socials">
          <a href="https://www.instagram.com/orissa.patnaik" target="_blank" rel="noopener noreferrer" aria-label="Instagram">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
              <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
              <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
            </svg>
          </a>
          <a href="https://www.linkedin.com/in/orissa-patnaik-85071a1aa/" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
              <rect x="2" y="9" width="4" height="12" />
              <circle cx="4" cy="4" r="2" />
            </svg>
          </a>
          <a href="mailto:support@careermonke.com" aria-label="Email">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  </section>

  {/* FEEDBACK WALL */}
  <section className="wrap s" aria-labelledby="w-h">
    <h2 className="h2" id="w-h">What job seekers are saying</h2>
    <div className="wl" tabIndex={0} aria-label="Wall of quotes from early-access users. Hover or focus to pause.">
        <ul className="wl-col wl-down">
            <li className="wl-card"><blockquote>“Honestly didn't expect much but found an early-stage startup role here that wasn't on Naukri at all. Resume score feature is quite strict though!”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-1.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>RS</i></span><span><b>Rohan S.</b><small>Bengaluru</small></span></p></li>
            <li className="wl-card"><blockquote>“Resume scanner is super helpful, pointed out missing action verbs immediately. Site took a few seconds to load the jobs list once, but good tool overall.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-2.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>SM</i></span><span><b>Sneha M.</b><small>Hyderabad</small></span></p></li>
            <li className="wl-card"><blockquote>“Tired of competing with 800 applicants on every single posting. The scraper pulled a niche seed-round role that fit my background cleanly.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-4.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>BH</i></span><span><b>Brett H.</b><small>Austin, TX</small></span></p></li>
            <li className="wl-card"><blockquote>“Applying for remote global roles from China is usually painful. This helped me find open global positions that never show up locally.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-5.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>LW</i></span><span><b>Lin Wei</b><small>Shanghai</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Honestly didn't expect much but found an early-stage startup role here that wasn't on Naukri at all. Resume score feature is quite strict though!”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-1.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>RS</i></span><span><b>Rohan S.</b><small>Bengaluru</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Resume scanner is super helpful, pointed out missing action verbs immediately. Site took a few seconds to load the jobs list once, but good tool overall.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-2.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>SM</i></span><span><b>Sneha M.</b><small>Hyderabad</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Tired of competing with 800 applicants on every single posting. The scraper pulled a niche seed-round role that fit my background cleanly.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-4.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>BH</i></span><span><b>Brett H.</b><small>Austin, TX</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Applying for remote global roles from China is usually painful. This helped me find open global positions that never show up locally.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-5.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>LW</i></span><span><b>Lin Wei</b><small>Shanghai</small></span></p></li>
        </ul>
        <ul className="wl-col wl-up">
            <li className="wl-card"><blockquote>“The AI editor caught so many formatting flaws in my CV. Got two interview callbacks within 10 days of fixing my score.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-1.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>PV</i></span><span><b>Pooja Verma</b><small>Pune</small></span></p></li>
            <li className="wl-card"><blockquote>“Loved that it cuts through the usual sponsored listings garbage. Re-wrote my project points using the suggestions and my profile looks way sharper.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-3.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>TD</i></span><span><b>Tanmay Das</b><small>Kolkata</small></span></p></li>
            <li className="wl-card"><blockquote>“UI has a few rough edges, but the scraped job feed is legit. Easily saved me 10+ hours of doomscrolling this week.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-4.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>EC</i></span><span><b>Elena C.</b><small>Seattle, WA</small></span></p></li>
            <li className="wl-card"><blockquote>“English resume scoring gave very practical suggestions for Western ATS systems. Fixed my grammar issues and boosted my score to 88.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-6.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>CH</i></span><span><b>Chen Hao</b><small>Beijing</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“The AI editor caught so many formatting flaws in my CV. Got two interview callbacks within 10 days of fixing my score.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-1.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>PV</i></span><span><b>Pooja Verma</b><small>Pune</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Loved that it cuts through the usual sponsored listings garbage. Re-wrote my project points using the suggestions and my profile looks way sharper.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-3.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>TD</i></span><span><b>Tanmay Das</b><small>Kolkata</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“UI has a few rough edges, but the scraped job feed is legit. Easily saved me 10+ hours of doomscrolling this week.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-4.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>EC</i></span><span><b>Elena C.</b><small>Seattle, WA</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“English resume scoring gave very practical suggestions for Western ATS systems. Fixed my grammar issues and boosted my score to 88.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-6.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>CH</i></span><span><b>Chen Hao</b><small>Beijing</small></span></p></li>
        </ul>
        <ul className="wl-col wl-down">
            <li className="wl-card"><blockquote>“Job market is brutal right now, applying on LinkedIn felt useless. Found my current role through this scraper in the first week itself.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-2.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>AK</i></span><span><b>Aditya K.</b><small>Gurgaon</small></span></p></li>
            <li className="wl-card"><blockquote>“Such a clean concept. Most platforms just repost the same 50 corporate openings, but here I actually saw genuine hidden vacancies.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-3.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>KR</i></span><span><b>Kavita R.</b><small>Mumbai</small></span></p></li>
            <li className="wl-card"><blockquote>“Resume review pointed out my bullets were way too wordy and gave me concrete fixes. Landed an interview 4 days later.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-5.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>MT</i></span><span><b>Marcus T.</b><small>Chicago, IL</small></span></p></li>
            <li className="wl-card"><blockquote>“Very useful for discovering stealth and cross-border startups. Good tool, already recommended it to two college friends.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-6.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>YZ</i></span><span><b>Yifei Z.</b><small>Shenzhen</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Job market is brutal right now, applying on LinkedIn felt useless. Found my current role through this scraper in the first week itself.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-2.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>AK</i></span><span><b>Aditya K.</b><small>Gurgaon</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Such a clean concept. Most platforms just repost the same 50 corporate openings, but here I actually saw genuine hidden vacancies.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-3.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>KR</i></span><span><b>Kavita R.</b><small>Mumbai</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Resume review pointed out my bullets were way too wordy and gave me concrete fixes. Landed an interview 4 days later.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/male-5.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>MT</i></span><span><b>Marcus T.</b><small>Chicago, IL</small></span></p></li>
            <li className="wl-card" aria-hidden="true"><blockquote>“Very useful for discovering stealth and cross-border startups. Good tool, already recommended it to two college friends.”</blockquote><p className="wl-by"><span className="mq-av"><img src="/images/avatars/female-6.webp" alt="" width="28" height="28" loading="lazy" onError={(e) => { e.currentTarget.remove(); }} /><i>YZ</i></span><span><b>Yifei Z.</b><small>Shenzhen</small></span></p></li>
        </ul>
    </div>
  </section>

  {/* FAQ */}
  <section className="wrap s band" aria-labelledby="q-h">
    <h2 className="h2" id="q-h">Frequently asked questions</h2>
    <div className="faq">
      <details><summary>How is CareerMonke different from LinkedIn or Indeed?</summary><p>Conventional job boards require employers to manually publish and pay for sponsored placements, creating massive applicant backlogs and ghost listings. CareerMonke automatically scrapes verified company career portals and ATS feeds directly every 15 minutes, uncovering open roles before they are publicized on aggregators.</p></details>
      <details><summary>Do you take a percentage of my compensation if I get hired?</summary><p>Never. We are not a staffing agency, headhunter, or contingency recruiter. 100% of your compensation, equity offer, and signing bonus stays with you. We simply give you direct, unmediated access to open employer requisitions.</p></details>
      <details><summary>How often are the job feeds and ATS links updated?</summary><p>Our automated ingestion pipeline continuously synchronizes directly with top ATS platforms (Greenhouse, Ashby, Lever, Workday) 24/7. When an employer creates or removes a requisition, our radar updates in real time so you never waste time applying to expired positions.</p></details>
      <details><summary>Can I filter jobs by remote status, country, and tech stack?</summary><p>Yes! You can filter requisitions by global worldwide eligibility, timezone requirements, specific tech stacks (e.g., React, Node, Python, AI/ML), and seniority levels to find matches that fit your exact background.</p></details>
      <details><summary>Do I apply directly on the company website?</summary><p>Yes, 100% of the time. Every job on CareerMonke links directly to the official company careers page or official ATS application form. There are no middleman forms, third-party redirects, or spam filters between you and the hiring team.</p></details>
    </div>
  </section>

  {/* CONTACT */}
  <section className="wrap s" aria-labelledby="c-h">
    <div className="contact">
      <h2 className="h2" id="c-h">Contact us</h2>
      <p>We'll try to respond the same day.</p>
      <a className="btn btn-ghost fbtn" href="mailto:support@careermonke.com">support@careermonke.com</a>
    </div>
  </section>
</main>

<footer>
  <div className="wrap">
    <div className="f-top">
      <a href="/" aria-label="CareerMonke home"><img src="/careermonke-logo.png" alt="CareerMonke" width="66" height="80" loading="lazy" /></a>
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
        <a href="https://github.com">GitHub</a>
      </div>
    </nav>
    <p className="copy">© 2026 Olive Ridley Media Private Limited. All rights reserved.</p>
  </div>
</footer>



    </div>
  );
}
