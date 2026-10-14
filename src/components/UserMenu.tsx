"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getProAccessStatus } from "@/lib/billing/subscription";
import { signOutUser } from "@/lib/auth/session";
import type { User } from "@supabase/supabase-js";
import { LogOut, ChevronDown, LogIn } from "lucide-react";

interface UserMenuProps {
  /** "dark" for blue hero (white text/border); "light" for white headers (blue/gray text) */
  variant?: "dark" | "light";
  className?: string;
}

/**
 * Auth-aware header component.
 *
 * Signed OUT → "Sign In" / "Login" button (links to /login)
 * Signed IN  → User email initial avatar + dropdown (Browse Jobs + Sign Out)
 */
export default function UserMenu({
  variant = "dark",
  className = "",
}: UserMenuProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    const checkUser = () => {
      supabase.auth.getUser().then(({ data, error }: any) => {
        if (data?.user && !error) {
          setUser(data.user);
          getProAccessStatus().then((res) => setIsPro(res.isPro));
        } else {
          setUser(null);
          setIsPro(false);
        }
        setLoading(false);
      });
    };

    checkUser();

    const { data: listener } = supabase.auth.onAuthStateChange((_event: any, session: any) => {
      if (session?.user) {
        setUser(session.user);
      } else {
        const localEmail =
          typeof window !== "undefined"
            ? localStorage.getItem("careermonke_user_email")
            : null;
        if (localEmail) {
          setUser({
            id: "local-user",
            email: localEmail,
            user_metadata: {},
          } as any);
        } else {
          setUser(null);
        }
      }
    });

    const handleAuthEvent = () => checkUser();
    window.addEventListener("careermonke_auth_updated", handleAuthEvent);
    window.addEventListener("careermonke_pro_updated", handleAuthEvent);
    window.addEventListener("storage", handleAuthEvent);

    return () => {
      listener.subscription.unsubscribe();
      window.removeEventListener("careermonke_auth_updated", handleAuthEvent);
      window.removeEventListener("careermonke_pro_updated", handleAuthEvent);
      window.removeEventListener("storage", handleAuthEvent);
    };
  }, []);

  const handleSignOut = async () => {
    await signOutUser();
    setUser(null);
    setOpen(false);
    router.replace("/");
  };

  if (loading) {
    return (
      <div
        className={
          variant === "dark"
            ? "w-[96px] sm:w-[108px] h-[46px] sm:h-[50px] rounded-xl"
            : "w-20 h-8 rounded-md"
        }
      />
    );
  }

  // ── Signed OUT ────────────────────────────────────────────────────────────
  if (!user) {
    if (variant === "light") {
      return (
        <Link
          href="/login"
          className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 min-h-[44px] rounded-md border border-blue-600 text-blue-600 hover:bg-blue-50 text-xs sm:text-sm font-semibold transition-colors ${className}`}
        >
          <LogIn className="w-3.5 h-3.5" />
          <span>Login</span>
        </Link>
      );
    }

    return (
      <Link
        href="/login"
        className={`w-[96px] sm:w-[108px] h-[46px] sm:h-[50px] rounded-xl border-2 border-white/90 hover:border-white text-white font-bold text-sm sm:text-base flex items-center justify-center transition-all hover:bg-white/10 shadow-sm ${className}`}
      >
        Sign In
      </Link>
    );
  }

  // ── Signed IN ─────────────────────────────────────────────────────────────


  const initial = (user.email?.[0] ?? "U").toUpperCase();
  const shortEmail = user.email
    ? user.email.length > 18
      ? user.email.slice(0, 15) + "…"
      : user.email
    : "Account";

  const triggerClass =
    variant === "light"
      ? `flex items-center gap-2 rounded-md px-2.5 py-1.5 min-h-[44px] border border-gray-300 hover:bg-gray-50 transition-all text-gray-800 font-semibold text-xs sm:text-sm shadow-xs ${className}`
      : `flex items-center gap-2 rounded-xl px-3 h-[46px] sm:h-[50px] border-2 border-white/90 hover:border-white hover:bg-white/10 transition-all text-white font-semibold text-sm shadow-sm ${className}`;

  const avatarCircleClass =
    variant === "light"
      ? "w-6 h-6 rounded-full bg-[#2563EB] text-white flex items-center justify-center text-xs font-black flex-shrink-0"
      : "w-7 h-7 rounded-full bg-white text-[#2563EB] flex items-center justify-center text-xs font-black flex-shrink-0";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={triggerClass}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className={avatarCircleClass}>{initial}</span>
        <span className="hidden sm:inline max-w-[100px] truncate">{shortEmail}</span>
        {isPro && (
          <span className="hidden sm:inline bg-amber-400 text-amber-950 font-black text-[9px] px-1.5 py-0.5 rounded uppercase tracking-wider shadow-2xs">
            PRO
          </span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Dropdown Menu */}
      {open && (
        <>
          <div className="fixed inset-0 z-40" role="presentation" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-56 bg-white border border-gray-200 rounded-xl shadow-xl z-50 overflow-hidden text-left">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/50">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                  Signed in as
                </p>
                {isPro ? (
                  <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                    PRO ACTIVE
                  </span>
                ) : (
                  <span className="text-[10px] font-medium bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">
                    FREE PLAN
                  </span>
                )}
              </div>
              <p className="text-sm font-semibold text-gray-900 truncate mt-0.5">
                {user.email}
              </p>
            </div>
            <div className="p-1.5 space-y-0.5">
              <Link
                href="/dashboard"
                prefetch={false}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded-lg transition-colors font-medium"
              >
                <span>Dashboard</span>
              </Link>
              <Link
                href="/jobs"
                prefetch={false}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded-lg transition-colors font-medium"
              >
                <span>Browse All Jobs</span>
              </Link>
              <Link
                href="/applications"
                prefetch={false}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded-lg transition-colors font-medium"
              >
                <span>Application Tracker</span>
              </Link>
              <Link
                href="/resume"
                prefetch={false}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded-lg transition-colors font-medium"
              >
                <span>Resume & Facts (ATS)</span>
              </Link>
              <Link
                href="/radar"
                prefetch={false}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-700 rounded-lg transition-colors font-medium"
              >
                <span>3D Job Radar</span>
              </Link>
              <div className="my-1 border-t border-gray-100" />
              <button
                onClick={handleSignOut}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors font-medium text-left cursor-pointer"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>

          </div>
        </>
      )}
    </div>
  );
}
