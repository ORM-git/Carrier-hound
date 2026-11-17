"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ComingSoonView from "@/components/common/ComingSoonView";
import { getAuthUser } from "@/lib/auth/session";
import type { User } from "@supabase/supabase-js";

export default function TrackerPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    getAuthUser().then((u) => {
      if (!u) {
        router.replace("/login?returnTo=/tracker");
        return;
      }
      setUser(u);
    });
  }, [router]);

  return (
    <LoggedInAppShell
      pageLabel="TRACKER"
      user={user}
      isPro={false}
      mainClassName="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-5 sm:py-4 space-y-5 sm:space-y-3.5 pb-24 lg:pb-12"
    >
      <ComingSoonView
        title="Application Tracker"
        description="The application tracking board is currently in development and will be available soon."
      />
    </LoggedInAppShell>
  );
}
