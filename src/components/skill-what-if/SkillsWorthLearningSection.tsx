import React from "react";
import { TrendingUp, Clock, Plus, Check } from "lucide-react";
import type { SkillWorthLearning } from "@/data/skillWhatIfFixture";

interface SkillsWorthLearningSectionProps {
  skills: SkillWorthLearning[];
  selectedSkills: string[];
  onToggleSkill: (skillName: string) => void;
}

export default function SkillsWorthLearningSection({
  skills,
  selectedSkills,
  onToggleSkill,
}: SkillsWorthLearningSectionProps) {
  // Ordered by gain descending
  const sortedSkills = [...skills].sort(
    (a, b) => b.gainNumeric - a.gainNumeric
  );

  return (
    <div className="bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-xs p-6 sm:p-8 space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-[#2563EB]" />
          <h2 className="text-xl font-bold text-[#0F172A]">
            Skills worth learning next
          </h2>
        </div>
        <p className="text-[15px] text-[#64748B]">
          Ranked by market leverage and cumulative job match potential across industry openings.
        </p>
      </div>

      <div className="divide-y divide-[#F1F5F9] border-y border-[#F1F5F9]">
        {sortedSkills.map((item, index) => {
          const isSelected = selectedSkills.includes(item.name);
          return (
            <div
              key={item.id}
              className="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/50 px-2 rounded-xl transition"
            >
              <div className="flex items-center gap-3.5">
                <span className="w-8 h-8 rounded-full bg-slate-100 text-[#475569] font-extrabold text-[15px] flex items-center justify-center shrink-0">
                  #{index + 1}
                </span>
                <div>
                  <h3 className="text-base font-bold text-[#0F172A]">
                    {item.name}
                  </h3>
                  <div className="flex items-center gap-2 text-[15px] text-[#64748B] flex-wrap mt-0.5">
                    <span className="font-semibold text-[#1D4ED8]">
                      {item.gainEstimate}
                    </span>

                    {/* Time to learn: ONLY rendered if real data exists, else omitted */}
                    {item.timeToLearn && item.timeToLearn.trim().length > 0 && (
                      <>
                        <span className="text-slate-300">•</span>
                        <span className="inline-flex items-center gap-1 text-[#64748B]">
                          <Clock className="w-3.5 h-3.5 text-[#94A3B8]" />
                          <span>Est. {item.timeToLearn}</span>
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Action: Simulate this skill */}
              <button
                type="button"
                onClick={() => onToggleSkill(item.name)}
                aria-pressed={isSelected}
                aria-label={
                  isSelected
                    ? `Remove ${item.name} from simulation`
                    : `Simulate ${item.name}`
                }
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[15px] font-bold transition cursor-pointer min-h-[44px] self-start sm:self-auto shrink-0 ${
                  isSelected
                    ? "bg-[#EFF6FF] border border-[#BFDBFE] text-[#1D4ED8] hover:bg-[#DBEAFE]"
                    : "bg-white border border-[#CBD5E1] text-[#334155] hover:border-[#2563EB] hover:text-[#2563EB]"
                }`}
              >
                {isSelected ? (
                  <>
                    <Check className="w-4 h-4 text-[#2563EB]" />
                    <span>In Simulation</span>
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4 text-[#2563EB]" />
                    <span>Simulate</span>
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
