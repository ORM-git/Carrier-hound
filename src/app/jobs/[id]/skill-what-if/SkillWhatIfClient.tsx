"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ComingSoonView from "@/components/common/ComingSoonView";
import { getAuthUser } from "@/lib/auth/session";
import type { User } from "@supabase/supabase-js";

interface SkillWhatIfClientProps {
  jobId: string;
}

export default function SkillWhatIfClient({ jobId }: SkillWhatIfClientProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    getAuthUser().then((authUser) => {
      if (!authUser) {
        router.replace(`/login?returnTo=/jobs/${jobId}/skill-what-if`);
        return;
      }
      setUser(authUser);
    });
  }, [jobId, router]);

  return (
    <LoggedInAppShell pageLabel="SKILL WHAT-IF" user={user} isPro={false}>
      <div className="max-w-5xl w-full mx-auto px-4 py-8">
        <ComingSoonView
          title="Skill What-If Simulator"
          description="Interactive skill gap simulation and match score projection are coming soon."
        />
      </div>
    </LoggedInAppShell>
  );
}
