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
import { ArrowLeft, Mail, Loader2, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";

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

export default function LoginPage() {
  const router = useRouter();

  const [next, setNext] = useState("/dashboard");
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
      setNext(getValidReturnUrl(rawNext, "/dashboard"));
      const queryError = params.get("error");
      if (queryError) {
        setError(queryError);
      }
    }
  }, []);

  // Auto-redirect if already logged in
  useEffect(() => {
    getAuthUser().then((user) => {
      if (user) {
        router.replace(next);
      }
    });
  }, [next, router]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendTimer > 0) {
      const interval = setInterval(() => setResendTimer((t) => t - 1), 1000);
      return () => clearInterval(interval);
    }
  }, [resendTimer]);

  // Real Supabase Email Login (Magic Link / OTP)
  const handleEmailSubmit = async (e: React.FormEvent) => {
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
      const { error: signInError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          emailRedirectTo: redirectUrl,
        },
      });

      if (signInError) {
        setError(signInError.message || "Failed to send magic link. Please try again.");
        setLoading(false);
        return;
      }

      setEmailSent(true);
      setResendTimer(30);
    } catch (err: any) {
      setError(err?.message || "Failed to send magic link. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Real Supabase Google OAuth
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
      setError(err?.message || "Could not initialize Google Sign In.");
      setGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-between">
      <GuideHeader />
      <main
        id="main-content"
        className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 text-[#0F172A] py-8 sm:py-12 font-sans"
      >

      {/* Main Single-Column Auth Card (Jobright style) */}
      <Card
        variant="surface"
        data-testid="login-auth-card"
        className="w-full max-w-[480px] overflow-hidden p-6 sm:p-8 space-y-6"
      >
        {/* Brand Logo & Header */}
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-tk-xl bg-surface-muted border border-line flex items-center justify-center mx-auto p-2">
            <BrandIcon className="w-10 h-10" />
          </div>
          <div className="space-y-1">
            <h1 className="text-tk-h2 font-black text-ink tracking-tight">Sign In to CareerMonke</h1>
            <p className="text-tk-body-sm text-ink-muted">
              Welcome back! Access your tailored applications & live feeds.
            </p>
          </div>
        </div>

        {/* Error notification banner */}
        {error && (
          <div
            data-testid="auth-error-banner"
            role="alert"
            className="bg-danger-50 border border-danger-200 rounded-tk-lg p-3.5 flex items-start gap-2.5 text-tk-body-sm text-danger-700 animate-fadeIn"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-danger-600" />
            <span>{error}</span>
          </div>
        )}

        {emailSent ? (
          <div
            data-testid="auth-email-sent"
            className="bg-success-50 border border-success-200 rounded-tk-xl p-6 text-center space-y-4 animate-fadeIn"
          >
            <div className="w-12 h-12 rounded-tk-full bg-success-100 text-success-700 flex items-center justify-center mx-auto">
              <CheckCircle2 className="w-6 h-6" />
            </div>
            <div className="space-y-1">
              <h3 className="font-bold text-tk-body text-ink">Check your inbox</h3>
              <p className="text-tk-caption text-ink-muted max-w-sm mx-auto">
                We sent a verified magic sign-in link to <strong className="text-ink">{email}</strong>. Click the link to complete sign in.
              </p>
            </div>

            <div className="pt-2 flex flex-col items-center gap-2">
              <button
                type="button"
                disabled={resendTimer > 0 || loading}
                onClick={handleEmailSubmit}
                className="min-h-[44px] inline-flex items-center gap-1.5 text-tk-caption font-bold text-brand-700 hover:text-brand-800 disabled:opacity-50 cursor-pointer rounded-tk-md px-3 focus-visible:outline-none focus-visible:shadow-tk-focus"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>
                  {resendTimer > 0 ? `Resend link in ${resendTimer}s` : "Resend magic link"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setEmailSent(false)}
                className="min-h-[44px] text-tk-caption text-ink-subtle hover:text-ink-muted px-3 rounded-tk-md focus-visible:outline-none focus-visible:shadow-tk-focus"
              >
                Use a different email
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Google OAuth Button */}
            <button
              type="button"
              onClick={handleGoogle}
              disabled={googleLoading || loading}
              className="min-h-[44px] h-12 w-full inline-flex items-center justify-center gap-2.5 rounded-tk-lg border border-line bg-surface hover:bg-surface-muted text-ink text-tk-body-sm font-semibold transition-colors duration-tk-fast disabled:opacity-60 cursor-pointer focus-visible:outline-none focus-visible:shadow-tk-focus"
            >
              {googleLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />
                  <span>Connecting to Google…</span>
                </>
              ) : (
                <>
                  <GoogleIcon />
                  <span>Continue with Google</span>
                </>
              )}
            </button>

            {/* Divider */}
            <div className="relative flex items-center justify-center py-1">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-line" />
              </div>
              <span className="relative bg-surface px-3 text-tk-caption text-ink-subtle uppercase tracking-wider font-semibold">
                Or with email
              </span>
            </div>

            {/* Email Magic Link Form */}
            <form onSubmit={handleEmailSubmit} className="space-y-3.5">
              <div className="space-y-1">
                <label htmlFor="login-email" className="block text-tk-caption font-semibold text-ink">
                  Work or Personal Email
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-ink-subtle absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (error) setError("");
                    }}
                    placeholder="name@company.com"
                    autoComplete="email"
                    required
                    className="min-h-[44px] h-12 w-full rounded-tk-lg border border-line bg-surface pl-10 pr-4 text-tk-body text-ink placeholder:text-ink-subtle transition-colors focus-visible:outline-none focus-visible:shadow-tk-focus"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || googleLoading}
                className={buttonClasses({
                  variant: "primary",
                  size: "lg",
                  fullWidth: true,
                  className: "min-h-[44px] h-12 cursor-pointer font-bold",
                })}
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-ink-inverse" />
                    <span>Sending magic link…</span>
                  </>
                ) : (
                  <span>Send Magic Link</span>
                )}
              </button>
            </form>
          </div>
        )}

        {/* Footer info & switcher */}
        <div className="pt-2 border-t border-line text-center space-y-2">
          <p className="text-tk-body-sm text-ink-muted">
            Don&apos;t have an account?{" "}
            <Link
              href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
              className="font-bold text-brand-700 hover:text-brand-800 hover:underline min-h-[44px] inline-flex items-center focus-visible:outline-none focus-visible:shadow-tk-focus rounded-tk-sm"
            >
              Sign up free
            </Link>
          </p>
          <p className="text-tk-caption text-ink-subtle">
            By continuing, you agree to our{" "}
            <Link href="/terms-and-conditions" className="underline hover:text-ink-muted">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy-policy" className="underline hover:text-ink-muted">
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </Card>
      </main>
      <Footer />
    </div>
  );
}
