import React, { useState } from "react";
import { Plus, X, Sparkles, Check } from "lucide-react";
import type { MissingSkillSuggestion } from "@/data/skillWhatIfFixture";

interface SkillInputSectionProps {
  missingSkills: MissingSkillSuggestion[];
  selectedSkills: string[];
  onToggleSkill: (skillName: string) => void;
  onAddCustomSkill: (skillName: string) => void;
  onRemoveSkill: (skillName: string) => void;
  onClearSkills: () => void;
}

export default function SkillInputSection({
  missingSkills,
  selectedSkills,
  onToggleSkill,
  onAddCustomSkill,
  onRemoveSkill,
  onClearSkills,
}: SkillInputSectionProps) {
  const [customInput, setCustomInput] = useState("");

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customInput.trim();
    if (!trimmed) return;
    onAddCustomSkill(trimmed);
    setCustomInput("");
  };

  return (
    <div className="bg-white rounded-2xl ring-1 ring-[#E2E8F0] shadow-xs p-6 sm:p-8 space-y-6">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-[#2563EB]" />
          <h2 className="text-xl font-bold text-[#0F172A]">
            Add a skill to simulate
          </h2>
        </div>
        <p className="text-[15px] font-semibold text-[#2563EB]">
          Your resume is not changed
        </p>
        <p className="text-[15px] text-[#64748B] leading-relaxed">
          Select missing skills identified from the job description to test their impact on your match score and market coverage.
        </p>
      </div>

      {/* Suggested Missing Skills Chips */}
      <div className="space-y-3">
        <label className="text-[15px] font-bold text-[#334155] block">
          Suggested Missing Skills for this Job:
        </label>
        <div className="flex flex-wrap gap-2.5">
          {missingSkills.map((skill) => {
            const isSelected = selectedSkills.includes(skill.name);
            return (
              <button
                key={skill.id}
                type="button"
                onClick={() => onToggleSkill(skill.name)}
                aria-pressed={isSelected}
                aria-label={`Toggle simulation for ${skill.name} with estimated +${skill.matchGain}% match`}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-[15px] font-bold transition-all cursor-pointer min-h-[44px] ${
                  isSelected
                    ? "bg-[#2563EB] text-white shadow-xs hover:bg-[#1D4ED8]"
                    : "bg-white border border-[#CBD5E1] text-[#334155] hover:border-[#2563EB] hover:bg-blue-50/40"
                }`}
              >
                {isSelected ? (
                  <Check className="w-4 h-4 text-white shrink-0" />
                ) : (
                  <Plus className="w-4 h-4 text-[#2563EB] shrink-0" />
                )}
                <span>{skill.name}</span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded font-extrabold ${
                    isSelected
                      ? "bg-blue-800 text-blue-100"
                      : "bg-blue-50 text-[#1D4ED8] border border-blue-200"
                  }`}
                >
                  +{skill.matchGain}%
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom Skill Input */}
      <div className="space-y-3 pt-2 border-t border-[#F1F5F9]">
        <label
          htmlFor="custom-skill-input"
          className="text-[15px] font-bold text-[#334155] block"
        >
          Or type a specific skill to test:
        </label>
        <form onSubmit={handleCustomSubmit} className="flex gap-2">
          <input
            id="custom-skill-input"
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            placeholder="e.g. Apache Kafka, Rust, Distributed Caching..."
            aria-label="Enter a custom skill to simulate"
            className="flex-1 rounded-xl border border-[#CBD5E1] px-4 py-2.5 text-[15px] text-[#0F172A] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent min-h-[44px]"
          />
          <button
            type="submit"
            disabled={!customInput.trim()}
            aria-label="Add custom skill to simulation"
            className="px-5 py-2.5 rounded-xl bg-[#2563EB] hover:bg-[#1D4ED8] disabled:bg-slate-200 disabled:text-slate-400 text-white text-[15px] font-bold transition cursor-pointer min-h-[44px] flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Add</span>
          </button>
        </form>
      </div>

      {/* Currently Simulated Skills Active Tray */}
      {selectedSkills.length > 0 && (
        <div className="pt-3 border-t border-[#F1F5F9] space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-bold text-[#1E40AF]">
              Currently Simulating ({selectedSkills.length}{" "}
              {selectedSkills.length === 1 ? "skill" : "skills"}):
            </span>
            <button
              type="button"
              onClick={onClearSkills}
              aria-label="Clear all simulated skills"
              className="text-[15px] font-medium text-[#64748B] hover:text-[#0F172A] underline cursor-pointer"
            >
              Reset simulation
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedSkills.map((skillName) => (
              <span
                key={skillName}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#EFF6FF] border border-[#BFDBFE] text-[15px] font-bold text-[#1D4ED8]"
              >
                <span>{skillName}</span>
                <button
                  type="button"
                  onClick={() => onRemoveSkill(skillName)}
                  aria-label={`Remove ${skillName} from simulation`}
                  className="p-0.5 rounded hover:bg-blue-200 text-[#1D4ED8] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
