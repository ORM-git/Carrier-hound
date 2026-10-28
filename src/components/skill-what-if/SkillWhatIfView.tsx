"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, AlertTriangle, RefreshCw, Cpu } from "lucide-react";
import type { SkillWhatIfData } from "@/data/skillWhatIfFixture";
import TopMatchComparison from "./TopMatchComparison";
import SkillInputSection from "./SkillInputSection";
import SimulatedJobsSection from "./SimulatedJobsSection";
import SkillsWorthLearningSection from "./SkillsWorthLearningSection";
import SkillWhatIfFooter from "./SkillWhatIfFooter";

interface SkillWhatIfViewProps {
  simulation: SkillWhatIfData | null;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  jobId?: string;
}

export default function SkillWhatIfView({
  simulation,
  loading,
  error,
  onRetry,
  jobId,
}: SkillWhatIfViewProps) {
  const router = useRouter();

  // Active simulated skills
  const [selectedSkills, setSelectedSkills] = useState<string[]>(() => {
    // Default to the first missing skill if available for immediate interactive feedback
    if (simulation?.missingSkills && simulation.missingSkills.length > 0) {
      return [simulation.missingSkills[0].name];
    }
    return ["Kubernetes"];
  });

  // Selected country filter
  const [selectedCountry, setSelectedCountry] = useState<string>("all");

  // Toggle skill in simulation
  const handleToggleSkill = (skillName: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillName)
        ? prev.filter((s) => s !== skillName)
        : [...prev, skillName]
    );
  };

  // Add custom skill to simulation
  const handleAddCustomSkill = (skillName: string) => {
    setSelectedSkills((prev) =>
      prev.includes(skillName) ? prev : [...prev, skillName]
    );
  };

  // Remove skill
  const handleRemoveSkill = (skillName: string) => {
    setSelectedSkills((prev) => prev.filter((s) => s !== skillName));
  };

  // Clear all skills
  const handleClearSkills = () => {
    setSelectedSkills([]);
  };

  // Dynamic calculations
  const { newMatch, crossingCount, updatedJobs, availableCountries } = useMemo(() => {
    if (!simulation) {
      return {
        newMatch: 68,
        crossingCount: 0,
        updatedJobs: [],
        availableCountries: [],
      };
    }

    // Calculate match gain on current target job
    let totalGain = 0;
    selectedSkills.forEach((skillName) => {
      const match = simulation.missingSkills.find(
        (ms) => ms.name.toLowerCase() === skillName.toLowerCase()
      );
      if (match) {
        totalGain += match.matchGain;
      } else {
        // Custom or external skill default gain
        totalGain += 8;
      }
    });

    // Diminishing returns cap on max match score (max 98%)
    const calculatedNewMatch = Math.min(
      98,
      simulation.baseMatch + Math.round(totalGain * 0.85)
    );

    // Calculate additional jobs crossing match threshold
    const updated = simulation.additionalJobs.map((job) => {
      // Calculate how many of the job's required skills are in selectedSkills
      let jobGain = 0;
      if (job.requiredSkills && job.requiredSkills.length > 0) {
        job.requiredSkills.forEach((reqSkill) => {
          if (
            selectedSkills.some(
              (s) => s.toLowerCase() === reqSkill.toLowerCase()
            )
          ) {
            jobGain += 8;
          }
        });
      }
      const jobNewMatch = Math.min(96, job.baseMatch + jobGain);
      return {
        ...job,
        newMatch: jobNewMatch,
      };
    });

    // A job crosses the threshold if its newMatch >= threshold
    const crossing = updated.filter(
      (job) => job.newMatch >= simulation.threshold
    );

    // Extract unique countries
    const countries = Array.from(
      new Set(simulation.additionalJobs.map((j) => j.country))
    );

    return {
      newMatch: calculatedNewMatch,
      crossingCount: crossing.length,
      updatedJobs: updated,
      availableCountries: countries,
    };
  }, [simulation, selectedSkills]);

  // Loading State
  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 space-y-4">
        <div className="w-10 h-10 border-4 border-[#2563EB] border-t-transparent rounded-full animate-spin" />
        <p className="text-[15px] font-semibold text-[#64748B]">
          Calibrating skill what-if projections...
        </p>
      </div>
    );
  }

  // Error State
  if (error || !simulation) {
    return (
      <div className="max-w-2xl mx-auto my-12 p-8 bg-white rounded-2xl ring-1 ring-red-200 shadow-sm text-center space-y-4">
        <div className="w-12 h-12 rounded-full bg-red-50 text-red-600 flex items-center justify-center mx-auto">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <h2 className="text-xl font-bold text-[#0F172A]">
          Failed to load skill simulation
        </h2>
        <p className="text-[15px] text-[#64748B]">
          {error || "An unexpected error occurred while preparing your simulation."}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-[15px] font-bold transition cursor-pointer min-h-[44px]"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Try Again</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-5xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6 animate-in fade-in duration-300">
      {/* Top Header */}
      <div className="bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-2xs p-6 sm:p-8 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => router.push(jobId ? `/jobs?selectedJobId=${jobId}` : "/jobs")}
            className="p-2.5 rounded-xl border border-[#CBD5E1] text-[#475569] hover:text-[#0F172A] hover:bg-slate-100 transition cursor-pointer min-h-[44px] min-w-[44px] flex items-center justify-center"
            aria-label="Back to jobs"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[15px] font-bold text-[#2563EB] uppercase tracking-wider">
                <Cpu className="w-3.5 h-3.5 text-[#2563EB]" />
                Skill What-If Simulator
              </span>
              <span className="text-slate-300">•</span>
              <span className="text-[15px] font-semibold text-[#64748B]">
                Interactive Match Projection
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold text-[#0F172A] leading-tight mt-0.5">
              {simulation.jobTitle}{simulation.companyName ? ` @ ${simulation.companyName}` : ""}
            </h1>
          </div>
        </div>
      </div>

      {/* Persistent Sample Preview Banner */}
      <div
        role="alert"
        className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 flex items-start gap-3 shadow-2xs"
      >
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div className="text-[15px] leading-relaxed">
          <p className="font-bold text-amber-950">
            Sample preview, not data for this job
          </p>
          <p className="text-amber-800 text-[15px] mt-0.5">
            This simulation is an interactive preview demonstrating skill what-if modeling. Live profile data is unchanged.
          </p>
        </div>
      </div>

      {/* 1. Top: Match Comparison (Large Numbers + Calm Delta) */}
      <TopMatchComparison
        baseMatch={simulation.baseMatch}
        newMatch={newMatch}
      />

      {/* 2. Skill Input: Suggestions Chips + Custom Input */}
      <SkillInputSection
        missingSkills={simulation.missingSkills}
        selectedSkills={selectedSkills}
        onToggleSkill={handleToggleSkill}
        onAddCustomSkill={handleAddCustomSkill}
        onRemoveSkill={handleRemoveSkill}
        onClearSkills={handleClearSkills}
      />

      {/* 3. Result Cards: 'N additional jobs cross the match threshold' */}
      <SimulatedJobsSection
        jobs={updatedJobs}
        crossingCount={crossingCount}
        selectedCountry={selectedCountry}
        onSelectCountry={setSelectedCountry}
        availableCountries={availableCountries}
      />

      {/* 4. Ranked List: 'Skills worth learning next' */}
      <SkillsWorthLearningSection
        skills={simulation.skillsWorthLearning}
        selectedSkills={selectedSkills}
        onToggleSkill={handleToggleSkill}
      />

      {/* 5. Footer & Mandatory Disclaimer */}
      <SkillWhatIfFooter />
    </div>
  );
}
