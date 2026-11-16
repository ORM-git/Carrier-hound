"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ComingSoonView from "@/components/common/ComingSoonView";
import { getAuthUser } from "@/lib/auth/session";
import type { User } from "@supabase/supabase-js";

interface InterviewPackClientProps {
  jobId: string;
}

export default function InterviewPackClient({ jobId }: InterviewPackClientProps) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    getAuthUser().then((authUser) => {
      if (!authUser) {
        router.replace(`/login?returnTo=/jobs/${jobId}/interview-pack`);
        return;
      }
      setUser(authUser);
    });
  }, [jobId, router]);

  return (
    <LoggedInAppShell pageLabel="INTERVIEW PACK" user={user} isPro={false}>
      <div className="max-w-5xl w-full mx-auto px-4 py-8">
        <ComingSoonView
          title="AI Interview Pack"
          description="Role-specific interview dossiers, question predictions, and tailored talking points are coming soon."
        />
      </div>
    </LoggedInAppShell>
  );
}
