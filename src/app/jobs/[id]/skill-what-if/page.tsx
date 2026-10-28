import React from "react";
import SkillWhatIfClient from "./SkillWhatIfClient";

interface PageProps {
  params: {
    id: string;
  };
}

export function generateStaticParams() {
  return [
    { id: "sample" },
    { id: "1" },
    { id: "preview" },
    { id: "default" },
  ];
}

export const dynamicParams = true;

export default function SkillWhatIfPage({ params }: PageProps) {
  return <SkillWhatIfClient jobId={params.id} />;
}
