"use client";

import React, { useState } from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";
import { ArrowRight, CheckCircle2, AlertCircle, Loader2, Sparkles, ShieldCheck } from "lucide-react";

const CLIENT_EMAIL_REGEX =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export default function EarlyAccessPage() {
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState(""); // Honeypot field
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

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
    <main className="min-h-screen bg-[#F8FAFC] dark:bg-[#09090B] text-[#0F172A] dark:text-[#F8FAFC] flex flex-col justify-between selection:bg-blue-100 selection:text-blue-900">
      {/* Top minimal brand bar */}
      <header className="w-full border-b border-[#E2E8F0] dark:border-zinc-800 bg-white/90 dark:bg-zinc-950/90 backdrop-blur-xs">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link
            href="/early-access"
            aria-label="CareerMonke Early Access"
            className="inline-flex items-center gap-2.5 min-h-[44px] rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]"
          >
            <span className="w-9 h-9 rounded-full bg-white dark:bg-zinc-900 border border-[#E2E8F0] dark:border-zinc-800 flex items-center justify-center p-1 shadow-2xs">
              <BrandIcon className="w-7 h-7" />
            </span>
            <span className="text-lg font-extrabold tracking-tight text-[#0F172A] dark:text-white">
              Career<span className="text-[#2563EB]">Monke</span>
            </span>
          </Link>

          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-blue-50 dark:bg-blue-950/60 text-[#2563EB] dark:text-blue-400 border border-blue-200/80 dark:border-blue-800/60">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2563EB] animate-pulse" />
            <span>Early Access</span>
          </span>
        </div>
      </header>

      {/* Main split section */}
      <section className="flex-1 flex items-center py-8 sm:py-14 lg:py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
          {/* Left column: Headline, one-line pitch, email form, states */}
          <div className="lg:col-span-7 space-y-6 text-left">
            {/* Mobile compact monkey illustration badge (390px responsive above headline) */}
            <div className="flex lg:hidden items-center gap-3.5 p-3 rounded-2xl bg-gradient-to-r from-[#2563EB] to-[#1D4ED8] text-white shadow-md">
              <div className="w-14 h-14 rounded-xl bg-white p-1.5 flex items-center justify-center shrink-0 shadow-xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/careermonke.svg"
                  alt="CareerMonke illustration"
                  className="w-11 h-11 object-contain"
                />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-wider text-blue-100">
                  Invite-Only Rollout
                </div>
                <div className="text-sm font-bold leading-snug text-white">
                  Direct company career-page jobs before they hit job boards.
                </div>
              </div>
            </div>

            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-blue-50 dark:bg-blue-950/60 text-[#2563EB] dark:text-blue-400 border border-blue-100 dark:border-blue-900">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Unindexed ATS Radar</span>
            </div>

            <div className="space-y-3">
              <h1 className="text-3xl sm:text-4xl lg:text-[44px] font-extrabold tracking-tight text-[#0F172A] dark:text-white leading-[1.15]">
                Find jobs not on LinkedIn or Indeed — before the crowd.
              </h1>
              <p className="text-base sm:text-lg text-[#475569] dark:text-zinc-400 max-w-xl leading-relaxed">
                We scan verified company career pages in real time and tune your resume for direct applications.
              </p>
            </div>

            {status === "success" ? (
              <div
                role="status"
                aria-live="polite"
                data-testid="early-access-success"
                className="p-5 sm:p-6 rounded-2xl bg-[#F0FDF4] dark:bg-emerald-950/40 border border-[#BBF7D0] dark:border-emerald-800/60 flex items-start gap-3.5 max-w-xl"
              >
                <div className="w-10 h-10 rounded-full bg-[#DCFCE7] dark:bg-emerald-900/60 text-[#16A34A] dark:text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h2 className="text-lg font-bold text-[#14532D] dark:text-emerald-300">
                    You&apos;re on the list
                  </h2>
                  <p className="text-sm text-[#166534] dark:text-emerald-200/90 leading-relaxed">
                    We&apos;ve reserved your spot for <span className="font-semibold">{email.trim().toLowerCase()}</span>. We&apos;ll email your invite as soon as the next wave opens.
                  </p>
                </div>
              </div>
            ) : (
              <form
                onSubmit={handleSubmit}
                noValidate
                className="space-y-3 max-w-xl"
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

                <div className="flex flex-col sm:flex-row gap-3">
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
                      placeholder="Enter your work or personal email"
                      aria-invalid={status === "error"}
                      aria-describedby={status === "error" ? "early-access-error-msg" : undefined}
                      className="w-full h-12 min-h-[48px] px-4 rounded-xl bg-white dark:bg-zinc-900 border border-[#CBD5E1] dark:border-zinc-700 text-[#0F172A] dark:text-white placeholder-[#94A3B8] text-sm sm:text-base transition-all focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD]"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={status === "submitting"}
                    className="h-12 min-h-[48px] px-6 sm:px-7 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white font-bold text-sm sm:text-base inline-flex items-center justify-center gap-2 transition-colors shadow-sm cursor-pointer disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-2 shrink-0"
                  >
                    {status === "submitting" ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Joining…</span>
                      </>
                    ) : (
                      <>
                        <span>Get early access</span>
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
                    className="p-3 rounded-xl bg-[#FEF2F2] dark:bg-red-950/50 border border-[#FECACA] dark:border-red-800/70 flex items-center gap-2.5 text-sm text-[#B91C1C] dark:text-red-300"
                  >
                    <AlertCircle className="w-4 h-4 text-[#DC2626] dark:text-red-400 shrink-0" />
                    <span>{errorMessage}</span>
                  </div>
                )}

                <div className="pt-1 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-[#64748B] dark:text-zinc-400">
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-[#2563EB]" />
                    <span>No spam. Direct invite when your slot opens.</span>
                  </span>
                  <span>•</span>
                  <span>22,000+ verified employer roles indexed</span>
                </div>
              </form>
            )}
          </div>

          {/* Right column: CareerMonke illustration card (desktop & tablet) */}
          <div className="hidden lg:flex lg:col-span-5 justify-center">
            <div className="relative w-full max-w-[420px] rounded-3xl bg-[#2563EB] p-8 text-white shadow-xl overflow-hidden border border-blue-400/30">
              {/* Subtle radial dot pattern */}
              <div
                className="absolute inset-0 pointer-events-none opacity-15 bg-[radial-gradient(#fff_1.5px,transparent_1.5px)] [background-size:20px_20px]"
                aria-hidden="true"
              />

              <div className="relative z-10 flex flex-col items-center text-center space-y-6">
                {/* Circular halo holding the CareerMonke SVG mascot */}
                <div className="w-52 h-52 rounded-full bg-white shadow-2xl border-4 border-blue-300/50 flex items-center justify-center p-5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/careermonke.svg"
                    alt="CareerMonke mascot illustration"
                    className="w-40 h-40 object-contain"
                  />
                </div>

                <div className="space-y-2">
                  <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/15 text-white text-xs font-semibold backdrop-blur-xs">
                    <span>Direct Employer ATS Feeds</span>
                  </div>
                  <h2 className="text-xl font-bold tracking-tight text-white">
                    The Monke hunts the hidden job market for you.
                  </h2>
                  <p className="text-sm text-blue-100 leading-relaxed">
                    Greenhouse, Lever, Ashby &amp; Workday career pages — matched to your resume before roles hit public boards.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Minimal footer */}
      <footer className="w-full border-t border-[#E2E8F0] dark:border-zinc-800 bg-white dark:bg-zinc-950 py-5 px-4 sm:px-6 lg:px-8">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-[#64748B] dark:text-zinc-400">
          <span>© {new Date().getFullYear()} CareerMonke Inc. All rights reserved.</span>
          <span>Early-access preview</span>
        </div>
      </footer>
    </main>
  );
}
