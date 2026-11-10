"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getAuthUser } from "@/lib/auth/session";
import { ADMIN_EMAIL, isVerifiedAdminUser } from "@/lib/admin/constants";
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
      // Cryptographic Verification via Supabase Auth (admin list + verified email)
      try {
        const user = await getAuthUser();
        if (!user || !isVerifiedAdminUser(user)) {
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

      {/* Main Admin Content Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>

      {/* Admin Footer */}
      <footer className="border-t border-slate-200 bg-white py-4 text-center text-xs text-slate-500 space-y-1">
        <div>CareerMonke Internal Admin Console • Restricted to {ADMIN_EMAIL}</div>
        <div className="text-[11px] text-slate-400">© 2026 Olive Ridley Media Private Limited. All rights reserved.</div>
      </footer>
    </div>
  );
}
