"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BrandIcon from "@/components/BrandIcon";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { createClient } from "@/lib/supabase/client";
import { getValidReturnUrl, getAuthUser } from "@/lib/auth/session";
import { getSiteUrl } from "@/lib/siteUrl";
import { Mail, Loader2, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="shrink-0">
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

export default function SignupPage() {
  const router = useRouter();

  const [next, setNext] = useState("/onboarding");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);

  // Read search params via window.location (safe for static export)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const rawNext = params.get("next");
      setNext(getValidReturnUrl(rawNext, "/onboarding"));
    }
  }, []);

  // If already authenticated, redirect to dashboard or next directly
  useEffect(() => {
    getAuthUser().then((user) => {
      if (user) {
        router.replace(next.includes("onboarding") ? "/dashboard" : next);
      }
    });
  }, [next, router]);

  useEffect(() => {
    if (resendTimer > 0) {
      const interval = setInterval(() => setResendTimer((t) => t - 1), 1000);
      return () => clearInterval(interval);
    }
  }, [resendTimer]);

  const handleSignup = async (e: React.FormEvent) => {
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
      const origin = typeof window !== "undefined" && window.location.origin ? window.location.origin : getSiteUrl();
      const redirectUrl = `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { error: signUpError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          emailRedirectTo: redirectUrl,
        },
      });

      if (signUpError) {
        setError(signUpError.message || "Failed to initialize signup. Please try again.");
        setLoading(false);
        return;
      }

      setEmailSent(true);
      setResendTimer(30);
    } catch (err: any) {
      setError(err?.message || "Failed to initialize signup. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogle = async () => {
    setGoogleLoading(true);
    setError("");

    try {
      const supabase = createClient();
      const origin = typeof window !== "undefined" && window.location.origin ? window.location.origin : getSiteUrl();
      const redirectUrl = `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirectUrl,
        },
      });

      if (oauthError) {
        setError(oauthError.message);
        setGoogleLoading(false);
      }
    } catch (err: any) {
      setError(err?.message || "Could not initialize Google Sign Up.");
      setGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-blue-50 flex flex-col justify-between overflow-x-hidden">
      <GuideHeader />
      <main
        id="main-content"
        className="flex-1 flex flex-col items-center justify-center px-4 py-8 sm:py-12 text-[#0F172A] font-sans"
      >
        {/* Main Centred Auth Card (Jobright style: 440-470px max-width, 24px radius, 32-40px padding) */}
        <div
          data-testid="signup-auth-card"
          className="w-full max-w-[460px] bg-white rounded-[24px] border border-[#E2E8F0] shadow-sm p-8 sm:p-10 space-y-6"
        >
          {/* Centred Brand Logo & Heading */}
          <div className="text-center space-y-3">
            <div className="flex justify-center">
              <div className="w-12 h-12 rounded-2xl bg-[#EFF6FF] border border-[#BFDBFE] flex items-center justify-center p-2 shadow-xs">
                <BrandIcon className="w-8 h-8" />
              </div>
            </div>
            <div className="space-y-1">
              <h1 className="text-[22px] sm:text-[24px] font-bold text-[#0F172A] tracking-tight">
                Create your CareerMonke account
              </h1>
              <p className="text-[14px] text-[#64748B]">
                Discover direct, unindexed career page jobs.
              </p>
            </div>
          </div>

          {/* Readable red-tinted error notification banner */}
          {error && (
            <div
              data-testid="auth-error-banner"
              role="alert"
              className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl p-3.5 flex items-start gap-2.5 text-[14px] text-[#B91C1C] animate-fadeIn"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[#DC2626]" />
              <span className="leading-snug">{error}</span>
            </div>
          )}

          {emailSent ? (
            <div
              data-testid="auth-email-sent"
              className="bg-[#F0FDF4] border border-[#BBF7D0] rounded-2xl p-6 text-center space-y-4 animate-fadeIn"
            >
              <div className="w-12 h-12 rounded-full bg-[#DCFCE7] text-[#16A34A] flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-[16px] text-[#0F172A]">Check your email</h3>
                <p className="text-[13px] text-[#475569] max-w-sm mx-auto">
                  We sent an account activation link to <strong className="text-[#0F172A]">{email}</strong>. Click the link to complete setup.
                </p>
              </div>

              <div className="pt-2 flex flex-col items-center gap-2">
                <button
                  type="button"
                  disabled={resendTimer > 0 || loading}
                  onClick={handleSignup}
                  className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-[#2563EB] hover:text-[#1D4ED8] disabled:opacity-50 cursor-pointer rounded-lg px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>
                    {resendTimer > 0 ? `Resend link in ${resendTimer}s` : "Resend confirmation email"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setEmailSent(false)}
                  className="min-h-[44px] text-xs text-[#64748B] hover:text-[#0F172A] px-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] cursor-pointer"
                >
                  Change email address
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Working Continue with Google Button */}
              <button
                type="button"
                onClick={handleGoogle}
                disabled={googleLoading || loading}
                className="min-h-[44px] h-12 w-full inline-flex items-center justify-center gap-3 rounded-full border border-[#CBD5E1] bg-white hover:bg-[#F8FAFC] active:bg-[#F1F5F9] text-[#0F172A] text-[14px] font-semibold transition-colors duration-150 disabled:opacity-60 cursor-pointer shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-1"
              >
                {googleLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-[#64748B]" />
                    <span>Connecting to Google…</span>
                  </>
                ) : (
                  <>
                    <GoogleIcon />
                    <span>Continue with Google</span>
                  </>
                )}
              </button>

              {/* OR Divider with neutral text and thin lines */}
              <div className="relative flex items-center justify-center py-1">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-[#E2E8F0]" />
                </div>
                <span className="relative bg-white px-3 text-xs uppercase tracking-wider font-semibold text-[#64748B]">
                  OR
                </span>
              </div>

              {/* Email Magic Link Form */}
              <form onSubmit={handleSignup} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="signup-email" className="block text-xs font-semibold text-[#0F172A] uppercase tracking-wider">
                    Work or personal email
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-[#94A3B8] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      id="signup-email"
                      type="email"
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        if (error) setError("");
                      }}
                      placeholder="name@company.com"
                      autoComplete="email"
                      required
                      className="min-h-[44px] h-12 w-full rounded-[12px] border border-[#CBD5E1] bg-[#F8FAFC] pl-10 pr-4 text-[14px] text-[#0F172A] placeholder-[#94A3B8] transition-all focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD] focus:outline-none"
                    />
                  </div>
                </div>

                {/* Full-width blue primary pill */}
                <button
                  type="submit"
                  disabled={loading || googleLoading}
                  className="min-h-[44px] h-12 w-full rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-[14px] font-semibold transition-colors duration-150 inline-flex items-center justify-center gap-2 cursor-pointer shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-1 disabled:opacity-60"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-white" />
                      <span>Sending link…</span>
                    </>
                  ) : (
                    <span>Email me a sign-in link</span>
                  )}
                </button>
              </form>
            </div>
          )}

          {/* Bottom login/signup switch links separated by subtle divider */}
          <div className="pt-4 border-t border-[#E2E8F0] text-center space-y-2">
            <p className="text-[14px] text-[#64748B]">
              Already have an account?{" "}
              <Link
                href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
                className="font-bold text-[#2563EB] hover:text-[#1D4ED8] underline min-h-[44px] inline-flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] rounded"
              >
                Sign in
              </Link>
            </p>
            <p className="text-xs text-[#94A3B8]">
              By continuing, you agree to our{" "}
              <Link href="/terms-and-conditions" className="underline hover:text-[#64748B]">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy-policy" className="underline hover:text-[#64748B]">
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
