"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import BrandIcon from "@/components/BrandIcon";
import { createClient } from "@/lib/supabase/client";
import { getValidReturnUrl, getAuthUser } from "@/lib/auth/session";
import { ArrowLeft, Mail, Loader2, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
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

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get("next");
  const next = getValidReturnUrl(rawNext, "/dashboard");
  const queryError = searchParams.get("error");

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState(queryError || "");
  const [emailSent, setEmailSent] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);

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

    try {
      const supabase = createClient();
      const redirectUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
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
      const redirectUrl = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
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
    <main className="min-h-[100dvh] bg-[#F3F4F6] flex flex-col items-center justify-center p-4 sm:p-6 text-[#09090B] py-6 sm:py-12">
      {/* Back button */}
      <div className="w-full max-w-[520px] mb-4 sm:mb-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-black transition-colors min-h-[44px] py-2 px-1 -ml-1"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Home</span>
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
            Sign in to access verified direct company openings & your tracker.
          </p>
        </div>

        <div className="p-6 sm:p-10 space-y-6">
          <div className="text-center space-y-1.5">
            <h1 className="text-2xl font-bold text-[#09090B] tracking-tight">Sign In to CareerMonke</h1>
            <p className="text-sm text-[#4B5563]">
              Welcome back! Access your tailored applications & live feeds.
            </p>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 flex items-start gap-2.5 text-sm text-red-700 animate-fadeIn">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
              <span>{error}</span>
            </div>
          )}

          {emailSent ? (
            <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center space-y-4 animate-fadeIn">
              <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-base text-slate-900">Check your inbox</h3>
                <p className="text-xs text-slate-600 max-w-sm mx-auto">
                  We sent a verified magic sign-in link to <strong className="text-slate-900">{email}</strong>. Click the link to complete sign in.
                </p>
              </div>

              <div className="pt-2 flex flex-col items-center gap-2">
                <button
                  type="button"
                  disabled={resendTimer > 0 || loading}
                  onClick={handleEmailSubmit}
                  className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-600 hover:text-blue-800 disabled:opacity-50 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>
                    {resendTimer > 0 ? `Resend link in ${resendTimer}s` : "Resend magic link"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setEmailSent(false)}
                  className="text-xs text-slate-400 hover:text-slate-600"
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
                className="w-full h-12 flex items-center justify-center gap-3 border border-[#E4E4E7] rounded-xl text-sm font-semibold text-[#09090B] hover:bg-gray-50 active:scale-[0.99] transition shadow-2xs disabled:opacity-60 cursor-pointer"
              >
                {googleLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GoogleIcon />}
                <span>Continue with Google</span>
              </button>

              {/* Or separator */}
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-xs text-gray-400 font-medium">or continue with email</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>

              {/* Email Form */}
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-xs font-bold text-[#09090B] uppercase tracking-wider mb-1.5">
                    Email address
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full h-11 px-3.5 bg-white border border-[#E4E4E7] rounded-xl text-sm text-[#09090B] focus:outline-blue-600 shadow-2xs"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading || googleLoading}
                  className="w-full h-12 bg-[#2563EB] hover:bg-[#1D4ED8] active:scale-[0.99] text-white font-bold text-sm rounded-xl transition shadow-xs cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Sending verification link…</span>
                    </>
                  ) : (
                    <span>Sign In with Magic Link →</span>
                  )}
                </button>
              </form>
            </div>
          )}

          {/* Switch to Signup */}
          <div className="pt-4 border-t border-gray-100 text-center text-xs text-slate-600">
            <span>Don&apos;t have an account yet? </span>
            <Link
              href={`/signup?next=${encodeURIComponent(next)}`}
              className="font-bold text-blue-600 hover:text-blue-800 hover:underline"
            >
              Create Account
            </Link>
          </div>

          <div className="text-center text-[11px] text-gray-400">
            By signing in, you agree to our{" "}
            <Link href="/terms-and-conditions" className="hover:underline text-gray-600">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy-policy" className="hover:underline text-gray-600">
              Privacy Policy
            </Link>
            .
          </div>
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  );
}
