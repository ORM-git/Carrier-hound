"use client";

import React, { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import BrandIcon from "@/components/BrandIcon";
import {
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Sparkles,
  ShieldCheck,
} from "lucide-react";

const CLIENT_EMAIL_REGEX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export default function EarlyAccessPage() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // Honeypot field
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const scrollToForm = () => {
    const formEl = document.getElementById("early-access-form");
    if (formEl) {
      formEl.scrollIntoView({ behavior: "smooth" });
      const emailInput = document.getElementById("early-access-email");
      if (emailInput) {
        emailInput.focus();
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setStatus("error");
      setErrorMessage("Please enter your email address.");
      return;
    }

    if (
      trimmed.length < 5 ||
      trimmed.length > 254 ||
      trimmed.includes("..") ||
      /\s/.test(trimmed) ||
      !CLIENT_EMAIL_REGEX.test(trimmed)
    ) {
      setStatus("error");
      setErrorMessage("Please enter a valid email address.");
      return;
    }

    setStatus("submitting");
    setErrorMessage("");

    try {
      const res = await fetch("/api/early-access", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: trimmed,
          website,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        setStatus("error");
        setErrorMessage(
          data?.error || "Too many attempts. Please wait a minute and try again."
        );
        return;
      }

      if (!res.ok || data?.ok === false) {
        setStatus("error");
        setErrorMessage(
          data?.error || "Could not join the list right now. Please try again."
        );
        return;
      }

      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMessage("Network error. Please check your connection and try again.");
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#F0F7FF] via-[#F8FAFC] to-white text-[#0F172A] flex flex-col justify-between selection:bg-blue-100 selection:text-blue-900">
      {/* Top bar with CareerMonke logo + "Get early access" button */}
      <header className="w-full border-b border-slate-200/80 bg-white/80 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link
            href="/early-access"
            aria-label="CareerMonke Early Access"
            className="inline-flex items-center min-h-[44px] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            <BrandIcon variant="full" width={140} height={56} className="h-9 w-auto" priority />
          </Link>

          <button
            type="button"
            onClick={scrollToForm}
            className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded-xl text-xs sm:text-sm font-semibold text-white bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] transition-all shadow-xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
          >
            <span>Get early access</span>
            <ArrowRight className="w-3.5 h-3.5 stroke-[2.5]" />
          </button>
        </div>
      </header>

      {/* Hero section */}
      <section className="flex-1 flex items-center py-10 sm:py-16 lg:py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-14 items-center">
          {/* Left: Headline, sub line, Jovamon-style form card, trust line, feature chips */}
          <div className="lg:col-span-7 space-y-6 text-left">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 text-[#2563EB] border border-blue-200/70 shadow-2xs">
              <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" />
              <span>Early access for job seekers</span>
            </div>

            <div className="space-y-3">
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight text-[#0F172A] leading-[1.15]">
                Find jobs straight from company career pages.
              </h1>
              <p className="text-base sm:text-lg text-[#475569] max-w-xl leading-relaxed">
                We crawl official employer career boards directly so you can apply without the aggregator middleman, score your resume for ATS filters, and manage your search in one place.
              </p>
            </div>

            {/* Form card (reference: Jovamon clean card style) */}
            <div
              id="early-access-form"
              className="bg-white rounded-2xl p-5 sm:p-6 border border-blue-100/90 shadow-lg shadow-blue-500/5 max-w-xl transition-all"
            >
              {status === "success" ? (
                <div
                  role="status"
                  aria-live="polite"
                  data-testid="early-access-success"
                  className="p-5 sm:p-6 rounded-xl bg-[#F0FDF4] border border-[#BBF7D0] flex items-start gap-3.5"
                >
                  <div className="w-10 h-10 rounded-full bg-[#DCFCE7] text-[#16A34A] flex items-center justify-center shrink-0 mt-0.5">
                    <CheckCircle2 className="w-5 h-5" />
                  </div>
                  <div className="space-y-1">
                    <h2 className="text-lg font-bold text-[#14532D]">
                      You&apos;re on the list
                    </h2>
                    <p className="text-sm text-[#166534] leading-relaxed">
                      We&apos;ve reserved your spot for <span className="font-semibold">{email.trim().toLowerCase()}</span>. We&apos;ll email your invite once the next batch opens.
                    </p>
                  </div>
                </div>
              ) : (
                <form
                  onSubmit={handleSubmit}
                  noValidate
                  className="space-y-3.5"
                  aria-label="Early access waitlist form"
                >
                  {/* Honeypot field — hidden from real users */}
                  <div
                    className="absolute -left-[9999px] w-px h-px overflow-hidden opacity-0 pointer-events-none"
                    aria-hidden="true"
                  >
                    <label htmlFor="early-access-website">Website</label>
                    <input
                      id="early-access-website"
                      name="website"
                      type="text"
                      tabIndex={-1}
                      autoComplete="off"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row gap-2.5">
                    <div className="flex-1">
                      <label htmlFor="early-access-email" className="sr-only">
                        Email address
                      </label>
                      <input
                        id="early-access-email"
                        name="email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        required
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value);
                          if (status === "error") {
                            setStatus("idle");
                            setErrorMessage("");
                          }
                        }}
                        placeholder="Enter your email address"
                        aria-invalid={status === "error"}
                        aria-describedby={status === "error" ? "early-access-error-msg" : undefined}
                        className="w-full h-12 min-h-[48px] px-4 rounded-xl bg-slate-50/70 border border-slate-200 text-[#0F172A] placeholder-[#94A3B8] text-sm sm:text-base transition-all focus:bg-white focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD]"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={status === "submitting"}
                      className="h-12 min-h-[48px] px-6 sm:px-7 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white font-bold text-sm sm:text-base inline-flex items-center justify-center gap-2 transition-all shadow-sm cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] shrink-0"
                    >
                      {status === "submitting" ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Joining…</span>
                        </>
                      ) : (
                        <>
                          <span>Join early access</span>
                          <ArrowRight className="w-4 h-4 stroke-[2.5]" />
                        </>
                      )}
                    </button>
                  </div>

                  {status === "error" && errorMessage && (
                    <div
                      id="early-access-error-msg"
                      role="alert"
                      data-testid="early-access-error"
                      className="p-3 rounded-xl bg-[#FEF2F2] border border-[#FECACA] flex items-center gap-2.5 text-sm text-[#B91C1C]"
                    >
                      <AlertCircle className="w-4 h-4 text-[#DC2626] shrink-0" />
                      <span>{errorMessage}</span>
                    </div>
                  )}

                  <div className="pt-1 flex items-center gap-2 text-xs text-[#64748B]">
                    <ShieldCheck className="w-3.5 h-3.5 text-[#2563EB] shrink-0" />
                    <span>We&apos;ll use your email only for early-access updates.</span>
                  </div>
                </form>
              )}
            </div>

            {/* 3 short feature chips below */}
            <div className="pt-2 flex flex-wrap items-center gap-2.5">
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 border border-slate-200/80 text-xs font-medium text-slate-700 shadow-2xs">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#2563EB]" />
                <span>Direct career-page links</span>
              </div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 border border-slate-200/80 text-xs font-medium text-slate-700 shadow-2xs">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#2563EB]" />
                <span>AI resume tailoring</span>
              </div>
              <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 border border-slate-200/80 text-xs font-medium text-slate-700 shadow-2xs">
                <CheckCircle2 className="w-3.5 h-3.5 text-[#2563EB]" />
                <span>Application tracker</span>
              </div>
            </div>
          </div>

          {/* Right: The monkey mascot sitting on top of clean product preview card (real features only) */}
          <div className="lg:col-span-5 flex flex-col items-center justify-center pt-6 lg:pt-0">
            {/* The monkey from the logo (transparent bg) sitting on top of the card */}
            <div className="relative z-10 -mb-6 sm:-mb-7 flex justify-center">
              <Image
                src="/mascot.png"
                alt="CareerMonke Mascot"
                width={140}
                height={118}
                priority
                className="w-24 sm:w-32 lg:w-36 h-auto drop-shadow-md select-none transition-transform hover:scale-105"
              />
            </div>

            {/* Clean product preview card */}
            <div className="relative w-full max-w-[400px] bg-white rounded-2xl border border-slate-200/90 p-5 pt-8 sm:p-6 sm:pt-9 shadow-xl shadow-blue-500/5 space-y-3.5">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider text-center">
                Example preview
              </div>

              {/* Feature 1: Jobs (Direct ATS Feeds) */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-between gap-3 shadow-2xs">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-slate-100 border border-slate-200 text-slate-600 flex items-center justify-center font-bold text-[11px] shrink-0 shadow-2xs">
                    EC
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-900 truncate">Senior Frontend Engineer</div>
                    <div className="text-[11px] text-slate-500 truncate">Example Company • Remote (Worldwide)</div>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200/70 shrink-0">
                  Direct ATS
                </span>
              </div>

              {/* Feature 2: Resume Score */}
              <div className="p-3.5 rounded-xl bg-blue-50/60 border border-blue-100/80 flex items-center justify-between gap-3 shadow-2xs">
                <div className="space-y-0.5 min-w-0">
                  <div className="text-xs font-bold text-slate-900 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-[#2563EB]" />
                    <span>Resume match</span>
                  </div>
                  <div className="text-[11px] text-slate-600 truncate">Action verbs &amp; keyword alignment</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <div className="w-14 h-2 rounded-full bg-blue-100 overflow-hidden" aria-hidden="true">
                    <div className="w-4/5 h-full bg-[#2563EB] rounded-full" />
                  </div>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-blue-100/80 text-[#2563EB]">
                    High match
                  </span>
                </div>
              </div>

              {/* Feature 3: Tracker */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-100 space-y-2 shadow-2xs">
                <div className="flex items-center justify-between text-xs font-bold text-slate-900">
                  <span>Application Tracker</span>
                  <span className="text-[11px] font-semibold text-[#2563EB]">Pipeline</span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 text-center text-[10px] font-semibold">
                  <div className="py-1 px-1 rounded-md bg-white border border-slate-200/80 text-slate-600">
                    Saved
                  </div>
                  <div className="py-1 px-1 rounded-md bg-blue-100 text-blue-700 border border-blue-200 font-bold">
                    Applied
                  </div>
                  <div className="py-1 px-1 rounded-md bg-white border border-slate-200/80 text-slate-600">
                    Interview
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Minimal clean footer */}
      <footer className="w-full border-t border-slate-200/80 bg-white/70 py-5 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-[#64748B]">
          <span>© {new Date().getFullYear()} Olive Ridley Media Private Limited. All rights reserved.</span>
          <div className="flex items-center gap-4">
            <Link href="/privacy" className="hover:text-slate-900 transition-colors">Privacy</Link>
            <Link href="/terms-and-conditions" className="hover:text-slate-900 transition-colors">Terms</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}
