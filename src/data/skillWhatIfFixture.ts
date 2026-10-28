export interface SimulatedJob {
  id: string;
  title: string;
  company?: string; // Real company only; omitted when not available
  baseMatch: number;
  newMatch: number;
  requiredSkills: string[];
  country: string;
  workModel?: "remote" | "hybrid" | "onsite";
  salaryRange?: string; // Only present when real data exists; omitted otherwise
}

export interface MissingSkillSuggestion {
  id: string;
  name: string;
  matchGain: number; // e.g. 12 means +12%
  category: "cloud" | "backend" | "devops" | "frontend" | "architecture";
}

export interface SkillWorthLearning {
  id: string;
  name: string;
  gainEstimate: string; // e.g. "+18% market leverage"
  gainNumeric: number;
  timeToLearn?: string; // Only present when real data exists; omitted otherwise
}

export interface SkillWhatIfData {
  jobId: string;
  jobTitle: string;
  companyName?: string; // Real company only; omitted when not available
  baseMatch: number;
  threshold: number; // Threshold to cross (e.g. 75%)
  missingSkills: MissingSkillSuggestion[];
  additionalJobs: SimulatedJob[];
  skillsWorthLearning: SkillWorthLearning[];
  // Canary identifier to verify server-only confinement
  _serverProofSignature?: string;
}

export const SAMPLE_SKILL_WHAT_IF: SkillWhatIfData = {
  jobId: "sample",
  jobTitle: "Senior Distributed Systems Engineer",
  baseMatch: 68,
  threshold: 75,
  _serverProofSignature: "SERVER_ONLY_PROOF_CANARY_NEXUS_WHAT_IF_984",
  missingSkills: [
    {
      id: "skill-k8s",
      name: "Kubernetes",
      matchGain: 12,
      category: "devops",
    },
    {
      id: "skill-ts",
      name: "TypeScript",
      matchGain: 9,
      category: "frontend",
    },
    {
      id: "skill-tf",
      name: "Terraform",
      matchGain: 8,
      category: "cloud",
    },
    {
      id: "skill-gql",
      name: "GraphQL",
      matchGain: 7,
      category: "backend",
    },
    {
      id: "skill-go",
      name: "Go (Golang)",
      matchGain: 10,
      category: "backend",
    },
    {
      id: "skill-otel",
      name: "OpenTelemetry",
      matchGain: 6,
      category: "architecture",
    },
  ],
  additionalJobs: [
    {
      id: "sim-job-1",
      title: "Cloud Infrastructure Architect",
      baseMatch: 66,
      newMatch: 82,
      requiredSkills: ["Kubernetes", "Terraform"],
      country: "United States",
      workModel: "remote",
    },
    {
      id: "sim-job-2",
      title: "Backend Platform Engineer",
      baseMatch: 69,
      newMatch: 85,
      requiredSkills: ["Go (Golang)", "Kubernetes"],
      country: "United Kingdom",
      workModel: "remote",
    },
    {
      id: "sim-job-3",
      title: "Principal Site Reliability Engineer",
      baseMatch: 71,
      newMatch: 89,
      requiredSkills: ["Kubernetes", "OpenTelemetry"],
      country: "Germany",
      workModel: "remote",
    },
    {
      id: "sim-job-4",
      title: "Distributed Systems Core Engineer",
      baseMatch: 64,
      newMatch: 78,
      requiredSkills: ["Go (Golang)", "GraphQL"],
      country: "Worldwide",
      workModel: "remote",
    },
    {
      id: "sim-job-5",
      title: "Enterprise Solutions Architect",
      baseMatch: 63,
      newMatch: 77,
      requiredSkills: ["TypeScript", "Terraform"],
      country: "United States",
      workModel: "hybrid",
    },
  ],
  skillsWorthLearning: [
    {
      id: "learn-1",
      name: "Kubernetes Orchestration",
      gainEstimate: "+18% market leverage",
      gainNumeric: 18,
    },
    {
      id: "learn-2",
      name: "Distributed Systems Architecture",
      gainEstimate: "+15% market leverage",
      gainNumeric: 15,
    },
    {
      id: "learn-3",
      name: "Terraform Infrastructure as Code",
      gainEstimate: "+12% market leverage",
      gainNumeric: 12,
    },
    {
      id: "learn-4",
      name: "Go (Golang) Microservices",
      gainEstimate: "+11% market leverage",
      gainNumeric: 11,
    },
    {
      id: "learn-5",
      name: "OpenTelemetry Observability",
      gainEstimate: "+9% market leverage",
      gainNumeric: 9,
    },
  ],
};
