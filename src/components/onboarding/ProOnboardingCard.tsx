"use client";

import React, { useState } from "react";
import { Briefcase, MapPin, DollarSign, Clock, ArrowRight, Check } from "lucide-react";
import { UserPreferences } from "@/lib/auth/types";
import { saveUserPreferences } from "@/lib/auth/session";
import { toast } from "react-toastify";

interface ProOnboardingCardProps {
  userId: string;
  initialPreferences?: UserPreferences | null;
  onComplete: () => void;
  onSkip: () => void;
}

const PRESET_ROLES = [
  "Software Engineer",
  "Frontend Developer",
  "Backend Engineer",
  "Data Engineer",
  "Product Manager",
  "Marketing Manager",
  "UI/UX Designer",
  "DevOps Engineer",
];

const EXPERIENCE_LEVELS: Array<{ id: UserPreferences["experienceLevel"]; label: string; sub: string }> = [
  { id: "entry", label: "Entry / Fresher", sub: "0-2 years" },
  { id: "mid", label: "Mid-Level", sub: "2-5 years" },
  { id: "senior", label: "Senior", sub: "5-8 years" },
  { id: "lead", label: "Lead / Principal", sub: "8+ years" },
];

const REMOTE_OPTIONS: Array<{ id: UserPreferences["remotePreference"]; label: string }> = [
  { id: "remote", label: "Worldwide Remote" },
  { id: "hybrid", label: "Remote or Hybrid" },
  { id: "onsite", label: "Any / Open to Relocation" },
];

const SALARY_RANGES = [
  { val: 0, label: "Any / Market Rate" },
  { val: 60000, label: "$60,000+ / yr" },
  { val: 100000, label: "$100,000+ / yr" },
  { val: 140000, label: "$140,000+ / yr" },
  { val: 180000, label: "$180,000+ / yr" },
];

const JOB_TYPES = [
  { id: "full-time", label: "Full-time" },
  { id: "contract", label: "Contract" },
  { id: "internship", label: "Internship" },
];

export default function ProOnboardingCard({
  userId,
  initialPreferences,
  onComplete,
  onSkip,
}: ProOnboardingCardProps) {
  const [selectedRole, setSelectedRole] = useState<string>(
    initialPreferences?.roles?.[0] || "Software Engineer"
  );
  const [customRole, setCustomRole] = useState("");
  const [experienceLevel, setExperienceLevel] = useState<UserPreferences["experienceLevel"]>(
    initialPreferences?.experienceLevel || "mid"
  );
  const [remotePreference, setRemotePreference] = useState<UserPreferences["remotePreference"]>(
    initialPreferences?.remotePreference || "remote"
  );
  const [minSalary, setMinSalary] = useState<number>(initialPreferences?.minSalary || 0);
  const [jobTypes, setJobTypes] = useState<string[]>(
    initialPreferences?.employmentTypes || ["full-time"]
  );
  const [saving, setSaving] = useState(false);

  const toggleJobType = (t: string) => {
    if (jobTypes.includes(t)) {
      if (jobTypes.length > 1) setJobTypes(jobTypes.filter((x) => x !== t));
    } else {
      setJobTypes([...jobTypes, t]);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const role = customRole.trim() || selectedRole;
      const updatedPrefs: UserPreferences = {
        roles: [role],
        categories: [role.toLowerCase()],
        experienceLevel,
        remotePreference,
        minSalary,
        employmentTypes: jobTypes,
        locations: initialPreferences?.locations || [],
        salaryCurrency: initialPreferences?.salaryCurrency || "USD",
        dailyDigestOptIn: initialPreferences?.dailyDigestOptIn ?? true,
        onboardingCompleted: true,
        updatedAt: new Date().toISOString(),
      };
      await saveUserPreferences(updatedPrefs, userId);
      toast.success("Preferences saved!");
      onComplete();
    } catch {
      toast.error("Could not save preferences.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full max-w-2xl bg-white rounded-3xl border border-slate-200 p-6 sm:p-8 shadow-lg space-y-6 animate-fadeIn mx-auto">
      {/* Step Header */}
      <div className="flex items-center justify-between border-b border-slate-100 pb-4">
        <div>
          <span className="text-xs font-bold text-blue-600 uppercase tracking-wider">
            Step 1 of 2 • Guided Pro Flow
          </span>
          <h2 className="text-xl sm:text-2xl font-extrabold text-slate-900">
            What is your ideal next role?
          </h2>
          <p className="text-xs sm:text-sm text-slate-500">
            Answer 5 quick questions to tailor your Top 10 high-compatibility matches.
          </p>
        </div>
        <button
          type="button"
          onClick={onSkip}
          className="text-xs font-semibold text-slate-400 hover:text-slate-700 cursor-pointer px-3 py-1.5 rounded-lg hover:bg-slate-100 transition"
        >
          Skip
        </button>
      </div>

      <div className="space-y-5">
        {/* Q1: Target Role */}
        <div className="space-y-2">
          <label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <Briefcase className="w-3.5 h-3.5 text-blue-600" />
            <span>1. Target Role</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {PRESET_ROLES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  setSelectedRole(r);
                  setCustomRole("");
                }}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition cursor-pointer ${
                  selectedRole === r && !customRole
                    ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                    : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-white"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <input
            type="text"
            aria-label="Or type a specific title"
            value={customRole}
            onChange={(e) => setCustomRole(e.target.value)}
            placeholder="Or type a specific title (e.g. Lead Growth Marketer)"
            className="w-full text-xs px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white focus:outline-blue-600"
          />
        </div>

        {/* Q2: Experience Level */}
        <div className="space-y-2">
          <label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-blue-600" />
            <span>2. Experience Level</span>
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {EXPERIENCE_LEVELS.map((exp) => (
              <button
                key={exp.id}
                type="button"
                onClick={() => setExperienceLevel(exp.id)}
                className={`p-3 rounded-xl border text-left transition cursor-pointer ${
                  experienceLevel === exp.id
                    ? "bg-blue-50 border-blue-500 text-blue-900 shadow-2xs"
                    : "bg-slate-50 border-slate-200 text-slate-700 hover:bg-white"
                }`}
              >
                <div className="text-xs font-bold">{exp.label}</div>
                <div className="text-[10px] text-slate-400">{exp.sub}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Q3: Preferred Location & Remote */}
        <div className="space-y-2">
          <label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-blue-600" />
            <span>3. Preferred Remote Scope</span>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {REMOTE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRemotePreference(opt.id)}
                className={`p-2.5 rounded-xl border text-xs font-bold text-center transition cursor-pointer ${
                  remotePreference === opt.id
                    ? "bg-blue-50 border-blue-500 text-blue-900 shadow-2xs"
                    : "bg-slate-50 border-slate-200 text-slate-700 hover:bg-white"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Q4 & Q5 in 2 cols */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Q4: Minimum Salary */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-blue-600" />
              <span>4. Salary Expectation</span>
            </label>
            <select
              value={minSalary}
              onChange={(e) => setMinSalary(Number(e.target.value))}
              className="w-full text-xs font-semibold p-2.5 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white cursor-pointer"
            >
              {SALARY_RANGES.map((s) => (
                <option key={s.val} value={s.val}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>

          {/* Q5: Job Types */}
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
              <Briefcase className="w-3.5 h-3.5 text-blue-600" />
              <span>5. Job Type</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {JOB_TYPES.map((jt) => (
                <button
                  key={jt.id}
                  type="button"
                  onClick={() => toggleJobType(jt.id)}
                  className={`px-3 py-2 rounded-xl text-xs font-semibold border transition cursor-pointer flex items-center gap-1 ${
                    jobTypes.includes(jt.id)
                      ? "bg-blue-50 border-blue-500 text-blue-900"
                      : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-white"
                  }`}
                >
                  {jobTypes.includes(jt.id) && <Check className="w-3 h-3 text-blue-600" />}
                  <span>{jt.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Action Footer */}
      <div className="pt-4 border-t border-slate-100 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onSkip}
          className="text-xs font-semibold text-slate-500 hover:text-slate-800 cursor-pointer"
        >
          Skip to Resume
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white text-xs font-bold transition shadow-xs flex items-center gap-2 cursor-pointer disabled:opacity-70"
        >
          <span>{saving ? "Saving..." : "Save & Continue to Resume"}</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
