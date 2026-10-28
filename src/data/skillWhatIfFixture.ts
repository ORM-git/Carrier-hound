export interface SimulatedJob {
  id: string;
  title: string;
  company: string;
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
  timeToLearn?: string; // Omitted when not available
}

export interface SkillWhatIfData {
  jobId: string;
  jobTitle: string;
  companyName: string;
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
  companyName: "Nexus Architecture Labs",
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
      company: "Apex HyperScale Networks",
      baseMatch: 66,
      newMatch: 82,
      requiredSkills: ["Kubernetes", "Terraform"],
      country: "United States",
      workModel: "remote",
      salaryRange: "$165,000 - $195,000 / yr",
    },
    {
      id: "sim-job-2",
      title: "Backend Platform Engineer",
      company: "DataVanguard Systems",
      baseMatch: 69,
      newMatch: 85,
      requiredSkills: ["Go (Golang)", "Kubernetes"],
      country: "United Kingdom",
      workModel: "remote",
      salaryRange: "£90,000 - £110,000 / yr",
    },
    {
      id: "sim-job-3",
      title: "Principal Site Reliability Engineer",
      company: "Cortex Cloud Computing",
      baseMatch: 71,
      newMatch: 89,
      requiredSkills: ["Kubernetes", "OpenTelemetry"],
      country: "Germany",
      workModel: "remote",
      // Notice: salaryRange is intentionally omitted to verify clean UI omission!
    },
    {
      id: "sim-job-4",
      title: "Distributed Systems Core Engineer",
      company: "Helios Data Grid",
      baseMatch: 64,
      newMatch: 78,
      requiredSkills: ["Go (Golang)", "GraphQL"],
      country: "Worldwide",
      workModel: "remote",
      salaryRange: "$150,000 - $180,000 / yr",
    },
    {
      id: "sim-job-5",
      title: "Enterprise Solutions Architect",
      company: "Zenith Software Foundation",
      baseMatch: 63,
      newMatch: 77,
      requiredSkills: ["TypeScript", "Terraform"],
      country: "United States",
      workModel: "hybrid",
      // Notice: salaryRange is intentionally omitted
    },
  ],
  skillsWorthLearning: [
    {
      id: "learn-1",
      name: "Kubernetes Orchestration",
      gainEstimate: "+18% market leverage",
      gainNumeric: 18,
      timeToLearn: "3-4 weeks",
    },
    {
      id: "learn-2",
      name: "Distributed Systems Architecture",
      gainEstimate: "+15% market leverage",
      gainNumeric: 15,
      timeToLearn: "4-6 weeks",
    },
    {
      id: "learn-3",
      name: "Terraform Infrastructure as Code",
      gainEstimate: "+12% market leverage",
      gainNumeric: 12,
      // timeToLearn is intentionally omitted to verify omission in UI!
    },
    {
      id: "learn-4",
      name: "Go (Golang) Microservices",
      gainEstimate: "+11% market leverage",
      gainNumeric: 11,
      timeToLearn: "2-3 weeks",
    },
    {
      id: "learn-5",
      name: "OpenTelemetry Observability",
      gainEstimate: "+9% market leverage",
      gainNumeric: 9,
      // timeToLearn is intentionally omitted
    },
  ],
};
