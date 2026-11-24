"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { validateNewPassword, friendlyAuthError } from "@/lib/auth/passwordAuth";
import PasswordInput from "@/components/auth/PasswordInput";
import { Loader2, AlertCircle } from "lucide-react";

/**
 * Landing page for the Supabase password-recovery email. /auth/callback exchanges the
 * recovery code for a session and routes here; without that session the link is treated as expired.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    createClient()
      .auth.getSession()
      .then(({ data }: any) => {
        if (!cancelled) setHasSession(Boolean(data?.session));
      })
      .catch(() => !cancelled && setHasSession(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validateNewPassword(password);
    if (validationError) {
      setError(validationError);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const { error: updateError } = await createClient().auth.updateUser({ password });
      if (updateError) {
        setError(friendlyAuthError(updateError, "update"));
        setLoading(false);
        return;
      }
      router.replace("/auth/callback?returnTo=%2Fjobs");
    } catch {
      setError(friendlyAuthError(null, "update"));
      setLoading(false);
    }
  };

  return (
    <main
      id="main-content"
      className="min-h-[100dvh] bg-[#F8FAFC] flex items-center justify-center px-4 py-8 text-[#0F172A] font-sans"
    >
      <div className="w-full max-w-[424px] bg-white rounded-[20px] border border-[#E5E7EB] p-6 space-y-5">
        <h1 className="text-[24px] leading-tight font-light tracking-tight text-center">Set a new password</h1>

        {error && (
          <div
            id="reset-error-msg"
            role="alert"
            className="bg-[#FEF2F2] border border-[#FECACA] rounded-[8px] p-3 flex items-start gap-2.5 text-[14px] text-[#B91C1C]"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[#DC2626]" />
            <span className="leading-snug">{error}</span>
          </div>
        )}

        {hasSession === null ? (
          <div className="flex justify-center py-4" aria-live="polite">
            <Loader2 className="w-5 h-5 animate-spin text-[#64748B]" aria-label="Checking your reset link" />
          </div>
        ) : hasSession ? (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <PasswordInput
              id="reset-password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                if (error) setError("");
              }}
              autoComplete="new-password"
              placeholder="New password (8+ characters)"
              invalid={Boolean(error)}
              describedBy={error ? "reset-error-msg" : undefined}
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full h-[48px] min-h-[48px] rounded-[8px] bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-[14px] font-semibold flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-1 disabled:opacity-60"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin text-white" />}
              <span>{loading ? "Saving…" : "Save password"}</span>
            </button>
          </form>
        ) : (
          <div className="space-y-4 text-center">
            <p className="text-[14px] text-[#4B5563]">
              This reset link is invalid or has expired. Request a new one from the sign-in page.
            </p>
            <Link
              href="/login"
              className="inline-flex min-h-[44px] items-center px-4 font-semibold text-[#2563EB] hover:underline rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD]"
            >
              Back to sign in
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}
