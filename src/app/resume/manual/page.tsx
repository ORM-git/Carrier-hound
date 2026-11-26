"use client";
import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LoggedInAppShell from "@/components/shell/LoggedInAppShell";
import ResumeUploadAndConfirm from "@/components/resume/ResumeUploadAndConfirm";
import { getAuthUser } from "@/lib/auth/session";
import { getProAccessStatus } from "@/lib/billing/subscription";
import type { User } from "@supabase/supabase-js";
export default function ManualResumePage() {
 const router=useRouter(); const [user,setUser]=useState<User|null>(null); const [access,setAccess]=useState<{isPro:boolean,isDefinitive:boolean}|null>(null); const [error,setError]=useState(false);
 useEffect(()=>{let stopped=false;void getAuthUser().then(async current=>{if(!current){router.replace("/login?returnTo=/resume/manual");return;}const result=await getProAccessStatus(current.id);if(!stopped){setUser(current);setAccess({isPro:result.isPro,isDefinitive:Boolean(result.isDefinitive)});}}).catch(()=>{if(!stopped)setError(true);});return()=>{stopped=true;};},[router]);
 return <LoggedInAppShell pageLabel="RESUME" user={user} isPro={Boolean(access?.isPro)}><main className="w-full max-w-4xl mx-auto px-4 py-5 space-y-4"><Link href="/resume" className="inline-flex min-h-[44px] items-center text-sm text-blue-700">Back to resume</Link><h1 className="text-xl font-bold">Resume details</h1>{error?<p role="alert">Could not check access. Reload to try again.</p>:!access?<p role="status">Checking access...</p>:<ResumeUploadAndConfirm manualEntry isPro={access.isPro} onProfileConfirmed={()=>router.push("/resume")}/>}</main></LoggedInAppShell>;
}
