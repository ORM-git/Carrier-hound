"use client";
import React from "react";

interface Props {
  summary: string;
  onEdit: () => void;
  /** Where it is shown, for the test id only. */
  where: "bar" | "drawer";
}

/**
 * Persistent (not hover-only) statement of what saved onboarding choices do: they rank Recommended and every
 * other relevant job stays. It is context, not a filter: nothing here is applied, counted or copied into a draft.
 */
export default function SavedPrioritiesNote({ summary, onEdit, where }: Props) {
  return (
    <div data-testid={`saved-priorities-note-${where}`} className="flex items-start justify-between gap-3 rounded-lg border border-dashed border-[#BFDBFE] bg-[#EFF6FF] px-3 py-2 text-[13px] text-[#1E40AF]">
      <p className="min-w-0">
        <span className="font-semibold">Saved priorities rank your feed first: {summary}.</span>{" "}
        Other relevant jobs still show. Dashed filters are display only; clearing one does not change your saved priorities.
      </p>
      <button type="button" onClick={onEdit} className="shrink-0 font-bold text-[#2563EB] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#2563EB]">
        Edit saved priorities
      </button>
    </div>
  );
}
