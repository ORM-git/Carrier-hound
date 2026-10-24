"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAuthUser } from "@/lib/auth/session";
import { ADMIN_EMAIL } from "@/lib/admin/constants";
import AdminNav from "./AdminNav";
import type { User } from "@supabase/supabase-js";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [adminUser, setAdminUser] = useState<User | null>(null);
  const [isAuthorized, setIsAuthorized] = useState<boolean>(false);
  const [checking, setChecking] = useState<boolean>(true);

  useEffect(() => {
    let isMounted = true;

    async function checkAuth() {
      // 1. Instant Synchronous Pre-flight Check:
      // If user email in local storage is not the admin email, redirect immediately in 0ms
      if (typeof window !== "undefined") {
        const cachedEmail = localStorage.getItem("careermonke_user_email");
        if (!cachedEmail || cachedEmail.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
          window.location.replace("/");
          return;
        }
      }

      // 2. Full Cryptographic Verification via Supabase Auth
      try {
        const user = await getAuthUser();
        if (!user || user.email?.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
          if (typeof window !== "undefined") {
            window.location.replace("/");
          } else {
            router.replace("/");
          }
          return;
        }

        if (isMounted) {
          setAdminUser(user);
          setIsAuthorized(true);
          setChecking(false);
        }
      } catch (_) {
        if (typeof window !== "undefined") {
          window.location.replace("/");
        } else {
          router.replace("/");
        }
      }
    }

    checkAuth();

    return () => {
      isMounted = false;
    };
  }, [router]);

  // While checking or if unauthorized, render minimal clean blank state
  if (checking || !isAuthorized) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-slate-300 border-t-slate-800 rounded-full animate-spin" />
          <span className="text-xs text-slate-500 font-mono">Verifying authorization...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-[#0F172A] flex flex-col font-sans">
      {/* Admin Top Navigation Header */}
      <AdminNav adminEmail={adminUser?.email || ADMIN_EMAIL} />

      {/* Main Admin Content Container: Accommodates bottom-fixed cookie notice with bottom padding */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-3 sm:px-6 lg:px-8 py-6 sm:py-8 pb-36 sm:pb-24">
        {children}
      </main>

      {/* Admin Footer: Offset above fixed cookie notice */}
      <footer className="border-t border-slate-200 bg-white py-4 mb-24 sm:mb-16 text-center text-xs text-slate-500">
        CareerMonke Internal Admin Console • Restricted to {ADMIN_EMAIL}
      </footer>
    </div>
  );
}
