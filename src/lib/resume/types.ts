// Type definitions for Resume Parsing, Extracted Facts, and Candidate Profile

export interface WorkExperienceItem {
  id: string;
  company: string;
  role: string;
  startDate: string;
  endDate: string;
  location?: string;
  bullets: string[];
  needsReview?: boolean;
  confidenceScore?: number;
}

export interface EducationItem {
  id: string;
  degree: string;
  institution: string;
  year: string;
  fieldOfStudy?: string;
  needsReview?: boolean;
}

export interface CandidateProfile {
  name: string;
  email: string;
  phone: string;
  location?: string;
  headline: string;
  summary: string;
  skills: string[];
  experience: WorkExperienceItem[];
  education: EducationItem[];
  certifications: string[];
  rawText?: string;
  confirmedAt?: string;
  updatedAt: string;
  ownerUserId?: string | null;
  userId?: string | null;
}

export interface ExtractedFact {
  id: string;
  category: "contact" | "skill" | "experience" | "education" | "certification";
  label: string;
  value: string;
  confidence: "high" | "needs_review";
  evidenceText?: string;
  details?: any;
}

export interface ParsedResumeResult {
  profile: CandidateProfile;
  facts: ExtractedFact[];
  parseStatus: "success" | "needs_review" | "error";
  unclearItemsCount: number;
}
