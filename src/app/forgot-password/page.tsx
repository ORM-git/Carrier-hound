"use client";

import React, { useState, Suspense } from "react";
import Link from "next/link";
import BrandIcon from "@/components/BrandIcon";
import { createClient } from "@/lib/supabase/client";
import { getSiteUrl } from "@/lib/siteUrl";
import {
  isAuthRateLimitError,
  NEUTRAL_RESET_EMAIL_MESSAGE,
  RATE_LIMIT_RESET_MESSAGE,
} from "@/lib/auth/password";
import { ArrowLeft, Loader2, CheckCircle2, AlertCircle } from "lucide-react";

function ForgotPasswordInner() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const supabase = createClient();
      const origin =
        typeof window !== "undefined" && window.location.origin
          ? window.location.origin
          : getSiteUrl();
      const redirectTo = `${origin}/reset-password`;

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        cleanEmail,
        { redirectTo }
      );

      if (resetError) {
        // Show friendly line on rate-limit errors
        if (isAuthRateLimitError(resetError)) {
          setError(RATE_LIMIT_RESET_MESSAGE);
          setLoading(false);
          return;
        }

        // For all other errors (e.g. user not found), treat identically to prevent email enumeration
      }

      setSubmitted(true);
    } catch (err: unknown) {
      if (isAuthRateLimitError(err)) {
        setError(RATE_LIMIT_RESET_MESSAGE);
      } else {
        // Anti-enumeration: neutral response even on unexpected non-rate-limit error
        setSubmitted(true);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-[100dvh] bg-[#F3F4F6] flex flex-col items-center justify-center p-4 sm:p-6 text-[#09090B] py-6 sm:py-12">
      {/* Back button */}
      <div className="w-full max-w-[520px] mb-4 sm:mb-6">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-black transition-colors min-h-[44px] py-2 px-1 -ml-1"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Sign In</span>
        </Link>
      </div>

      {/* CareerMonke Brand Logo */}
      <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-white shadow-md border border-gray-100 flex items-center justify-center p-2 mb-4 sm:mb-6">
        <BrandIcon className="w-12 h-12 sm:w-16 sm:h-16" />
      </div>

      {/* Main Auth Card */}
      <div className="w-full max-w-[520px] bg-white border border-[#E4E4E7] rounded-2xl shadow-sm overflow-hidden">
        {/* Top announcement bar */}
        <div className="bg-[#F8FAFF] border-b border-gray-100 py-3 px-6 text-center">
          <p className="text-xs sm:text-sm font-medium text-gray-700">
            Account Recovery
          </p>
        </div>

        <div className="p-6 sm:p-10 space-y-6">
          <div className="text-center space-y-1.5">
            <h1 className="text-2xl font-bold text-[#09090B] tracking-tight">
              Reset Your Password
            </h1>
            <p className="text-sm text-[#4B5563]">
              Enter your email address and we&apos;ll send you a link to reset your password.
            </p>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 flex items-start gap-2.5 text-sm text-red-700 animate-fadeIn">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
              <span>{error}</span>
            </div>
          )}

          {submitted ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center space-y-4 animate-fadeIn">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-base text-slate-900">Check your inbox</h3>
                <p className="text-xs text-slate-600 max-w-sm mx-auto">
                  {NEUTRAL_RESET_EMAIL_MESSAGE}
                </p>
              </div>

              <div className="pt-2 flex flex-col items-center gap-2">
                <Link
                  href="/login"
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-800"
                >
                  ← Return to Sign In
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="forgot-email"
                  className="block text-xs font-bold text-[#09090B] uppercase tracking-wider mb-1.5"
                >
                  Email address
                </label>
                <input
                  id="forgot-email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="w-full h-11 px-3.5 bg-white border border-[#E4E4E7] rounded-xl text-sm text-[#09090B] focus:outline-blue-600 shadow-2xs"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-12 bg-[#2563EB] hover:bg-[#1D4ED8] active:scale-[0.99] text-white font-bold text-sm rounded-xl transition shadow-xs cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Sending reset link…</span>
                  </>
                ) : (
                  <span>Send Reset Link →</span>
                )}
              </button>
            </form>
          )}

          {/* Switch back to Login */}
          <div className="pt-4 border-t border-gray-100 text-center text-xs text-slate-600">
            <span>Remember your password? </span>
            <Link
              href="/login"
              className="font-bold text-blue-600 hover:text-blue-800 hover:underline"
            >
              Sign In
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPasswordInner />
    </Suspense>
  );
}
