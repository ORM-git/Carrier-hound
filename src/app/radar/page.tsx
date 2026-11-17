"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ComingSoonView from "@/components/common/ComingSoonView";
import { getAuthUser } from "@/lib/auth/session";
import type { User } from "@supabase/supabase-js";

export default function RadarPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    getAuthUser().then((authUser) => {
      if (!authUser) {
        router.replace("/login?returnTo=/radar");
        return;
      }
      setUser(authUser);
    });
  }, [router]);

  return (
    <LoggedInAppShell
      pageLabel="RADAR"
      user={user}
      isPro={false}
      mainClassName="flex-1 w-full relative bg-[#040610] overflow-hidden flex flex-col"
    >
      <main id="main-content" className="w-full flex-1 flex items-center justify-center p-6">
        <ComingSoonView
          title="3D Job Radar"
          description="The 3D interactive job radar and geographic market visualizer is coming soon."
        />
      </main>
    </LoggedInAppShell>
  );
}
