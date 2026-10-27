import React from "react";
import InterviewPackClient from "./InterviewPackClient";

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

export default function InterviewPackPage({ params }: PageProps) {
  return <InterviewPackClient jobId={params.id} />;
}
