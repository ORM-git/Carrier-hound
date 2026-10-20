"use client";

import React, { useState, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import BrandIcon from "@/components/BrandIcon";
import { createClient } from "@/lib/supabase/client";
import {
  validatePasswordReset,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth/password";
import {
  ArrowLeft,
  Loader2,
  AlertCircle,
  Eye,
  EyeOff,
  Lock,
} from "lucide-react";

function ResetPasswordInner() {
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [checking, setChecking] = useState(true);
  const [isRecoveryValid, setIsRecoveryValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let isMounted = true;

    // Immediately check if URL contains recovery tokens/code and scrub the visible address bar
    const hasHashRecovery =
      typeof window !== "undefined" &&
      (window.location.hash.includes("type=recovery") ||
        window.location.hash.includes("access_token"));
    const code =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("code")
        : null;

    let supabase: ReturnType<typeof createClient>;
    try {
      supabase = createClient();
    } catch {
      if (isMounted) {
        setChecking(false);
        setError("Supabase configuration is missing or invalid.");
      }
      return;
    }

    // Subscribe to auth state change for PASSWORD_RECOVERY event
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      async (event: AuthChangeEvent, session: Session | null) => {
        if (!isMounted) return;
        if (event === "PASSWORD_RECOVERY" || (session && hasHashRecovery)) {
          setIsRecoveryValid(true);
          setChecking(false);
          // Scrub sensitive recovery token from address bar immediately
          if (
            typeof window !== "undefined" &&
            (window.location.hash || window.location.search)
          ) {
            window.history.replaceState(null, "", window.location.pathname);
          }
        }
      }
    );

    // Handle PKCE code exchange or active recovery session
    const initSession = async () => {
      try {
        if (code) {
          const { error: exchangeError } =
            await supabase.auth.exchangeCodeForSession(code);
          if (!exchangeError && isMounted) {
            setIsRecoveryValid(true);
            setChecking(false);
            if (
              typeof window !== "undefined" &&
              (window.location.hash || window.location.search)
            ) {
              window.history.replaceState(null, "", window.location.pathname);
            }
            return;
          }
        }

        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (isMounted) {
          if (session && (hasHashRecovery || isRecoveryValid)) {
            setIsRecoveryValid(true);
            if (
              typeof window !== "undefined" &&
              (window.location.hash || window.location.search)
            ) {
              window.history.replaceState(null, "", window.location.pathname);
            }
          }
          setChecking(false);
        }
      } catch {
        if (isMounted) {
          setChecking(false);
        }
      }
    };

    initSession();

    // Fallback timer: if after 2.5 seconds no recovery session was established, finish checking
    const timer = setTimeout(() => {
      if (isMounted) {
        setChecking(false);
      }
    }, 2500);

    return () => {
      isMounted = false;
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [isRecoveryValid]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const validation = validatePasswordReset(password, confirmPassword);
    if (!validation.valid) {
      setError(validation.error || "Please provide a valid password.");
      return;
    }

    setSubmitting(true);

    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });

      if (updateError) {
        setError(
          updateError.message || "Failed to update password. Please try again."
        );
        setSubmitting(false);
        return;
      }

      // Sign out recovery session so user signs in cleanly with new credentials
      await supabase.auth.signOut();

      // Redirect to /login with success message
      router.push("/login?message=password-updated");
    } catch (err: unknown) {
      const anyErr = err as { message?: string };
      setError(
        anyErr?.message || "Failed to update password. Please try again."
      );
      setSubmitting(false);
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

      {/* Main Card */}
      <div className="w-full max-w-[520px] bg-white border border-[#E4E4E7] rounded-2xl shadow-sm overflow-hidden">
        {/* Top announcement bar */}
        <div className="bg-[#F8FAFF] border-b border-gray-100 py-3 px-6 text-center">
          <p className="text-xs sm:text-sm font-medium text-gray-700 flex items-center justify-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-blue-600" />
            <span>Secure Password Reset</span>
          </p>
        </div>

        <div className="p-6 sm:p-10 space-y-6">
          {checking ? (
            <div className="py-12 flex flex-col items-center justify-center gap-3 text-center">
              <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              <p className="text-sm text-gray-600">
                Verifying reset authorization…
              </p>
            </div>
          ) : !isRecoveryValid ? (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center space-y-4 animate-fadeIn">
              <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mx-auto">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h2 className="font-bold text-base text-slate-900">
                  Invalid or Expired Reset Link
                </h2>
                <p className="text-xs text-slate-600 max-w-sm mx-auto">
                  This password reset link is invalid or has expired. Please request a new password reset link to continue.
                </p>
              </div>

              <div className="pt-2 flex flex-col items-center gap-2">
                <Link
                  href="/forgot-password"
                  className="inline-flex items-center justify-center px-4 py-2.5 bg-[#2563EB] hover:bg-[#1D4ED8] text-white font-bold text-xs rounded-xl transition shadow-xs"
                >
                  Request New Reset Link →
                </Link>
                <Link
                  href="/login"
                  className="text-xs text-slate-500 hover:text-slate-700"
                >
                  Return to Sign In
                </Link>
              </div>
            </div>
          ) : (
            <>
              <div className="text-center space-y-1.5">
                <h1 className="text-2xl font-bold text-[#09090B] tracking-tight">
                  Set New Password
                </h1>
                <p className="text-sm text-[#4B5563]">
                  Enter your new password below. It must be at least {MIN_PASSWORD_LENGTH} characters.
                </p>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-3.5 flex items-start gap-2.5 text-sm text-red-700 animate-fadeIn">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="new-password"
                    className="block text-xs font-bold text-[#09090B] uppercase tracking-wider mb-1.5"
                  >
                    New Password
                  </label>
                  <div className="relative">
                    <input
                      id="new-password"
                      type={showPassword ? "text" : "password"}
                      required
                      autoFocus
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      className="w-full h-11 px-3.5 pr-10 bg-white border border-[#E4E4E7] rounded-xl text-sm text-[#09090B] focus:outline-blue-600 shadow-2xs"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="confirm-password"
                    className="block text-xs font-bold text-[#09090B] uppercase tracking-wider mb-1.5"
                  >
                    Confirm New Password
                  </label>
                  <div className="relative">
                    <input
                      id="confirm-password"
                      type={showConfirmPassword ? "text" : "password"}
                      required
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter your new password"
                      className="w-full h-11 px-3.5 pr-10 bg-white border border-[#E4E4E7] rounded-xl text-sm text-[#09090B] focus:outline-blue-600 shadow-2xs"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setShowConfirmPassword(!showConfirmPassword)
                      }
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      aria-label={
                        showConfirmPassword
                          ? "Hide confirm password"
                          : "Show confirm password"
                      }
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full h-12 bg-[#2563EB] hover:bg-[#1D4ED8] active:scale-[0.99] text-white font-bold text-sm rounded-xl transition shadow-xs cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Updating password…</span>
                    </>
                  ) : (
                    <span>Update Password →</span>
                  )}
                </button>
              </form>
            </>
          )}

          <div className="pt-4 border-t border-gray-100 text-center text-xs text-slate-600">
            <Link
              href="/login"
              className="font-bold text-blue-600 hover:text-blue-800 hover:underline"
            >
              Back to Sign In
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordInner />
    </Suspense>
  );
}
