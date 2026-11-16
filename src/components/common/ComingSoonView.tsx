import React from "react";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export interface ComingSoonViewProps {
  title: string;
  description?: string;
  badgeLabel?: string;
}

export function ComingSoonView({
  title,
  description = "This feature is currently under active development and will be available in a future release.",
  badgeLabel = "Coming soon",
}: ComingSoonViewProps) {
  return (
    <div className="max-w-3xl w-full mx-auto px-4 py-12 sm:py-16 text-center">
      <Card
        variant="surface"
        className="p-8 sm:p-12 space-y-4 rounded-[16px] border border-[#E2E8F0] shadow-sm bg-white"
      >
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[#EFF6FF] text-[#2563EB] mx-auto mb-2">
          <Clock className="w-6 h-6" aria-hidden="true" />
        </div>
        <div>
          <Badge
            tone="neutral"
            className="text-xs uppercase tracking-wider font-semibold px-2.5 py-0.5 bg-[#F1F5F9] text-[#475569] border border-[#E2E8F0]"
          >
            {badgeLabel}
          </Badge>
        </div>
        <h1 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
          {title}
        </h1>
        <p className="text-sm sm:text-base text-[#64748B] max-w-lg mx-auto">
          {description}
        </p>
      </Card>
    </div>
  );
}

export default ComingSoonView;
