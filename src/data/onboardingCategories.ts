/**
 * CareerMonke Onboarding Categories & Role Taxonomy
 * Modeled for comprehensive job matching across tech, business, and operational domains.
 */

export interface OnboardingSubgroup {
  name: string;
  roles: string[];
}

export interface OnboardingCategory {
  id: string;
  name: string;
  subgroups: OnboardingSubgroup[];
}

export const ONBOARDING_CATEGORIES: OnboardingCategory[] = [
  {
    id: "software-internet-ai",
    name: "Software/Internet/AI",
    subgroups: [
      {
        name: "Software Engineering",
        roles: [
          "Frontend Developer",
          "Backend Engineer",
          "Full-Stack Developer",
          "Mobile Developer (iOS/Android)",
          "DevOps / Cloud Engineer",
          "Systems Engineer",
          "QA / Test Engineer",
          "Site Reliability Engineer (SRE)",
          "Game Developer",
        ],
      },
      {
        name: "AI & Data Science",
        roles: [
          "Machine Learning Engineer",
          "AI Prompt Engineer",
          "Data Scientist",
          "Data Engineer",
          "NLP Engineer",
          "Computer Vision Engineer",
          "MLOps Engineer",
        ],
      },
      {
        name: "Architecture & Security",
        roles: [
          "Security Engineer",
          "Solutions Architect",
          "Enterprise Architect",
          "Engineering Manager",
        ],
      },
    ],
  },
  {
    id: "consulting",
    name: "Consulting",
    subgroups: [
      {
        name: "Strategy & Management",
        roles: [
          "Management Consultant",
          "Strategy Analyst",
          "Operations Consultant",
          "Business Process Consultant",
        ],
      },
      {
        name: "Technology Consulting",
        roles: [
          "IT Consultant",
          "Digital Transformation Consultant",
          "ERP Consultant",
          "Technical Advisory Consultant",
        ],
      },
    ],
  },
  {
    id: "marketing",
    name: "Marketing",
    subgroups: [
      {
        name: "Growth & Digital Marketing",
        roles: [
          "Growth Marketer",
          "Performance Marketer",
          "SEO / SEM Specialist",
          "Paid Ads Manager",
          "Social Media Manager",
        ],
      },
      {
        name: "Brand & Content",
        roles: [
          "Content Strategist",
          "Brand Manager",
          "Copywriter",
          "Public Relations Specialist",
        ],
      },
      {
        name: "Product Marketing",
        roles: [
          "Product Marketing Manager",
          "Market Research Analyst",
        ],
      },
    ],
  },
  {
    id: "finance",
    name: "Finance",
    subgroups: [
      {
        name: "Accounting & Audit",
        roles: [
          "Financial Accountant",
          "Auditor",
          "Tax Specialist",
          "Forensic Accountant",
        ],
      },
      {
        name: "Corporate Finance & Analysis",
        roles: [
          "Financial Analyst",
          "FP&A Manager",
          "Investment Banking Analyst",
          "Financial Controller",
          "Treasury Analyst",
        ],
      },
    ],
  },
  {
    id: "product",
    name: "Product",
    subgroups: [
      {
        name: "Product Management",
        roles: [
          "Product Manager",
          "Technical Product Manager",
          "Associate Product Manager",
          "Senior Product Manager",
          "Group Product Manager",
        ],
      },
      {
        name: "Design & UX",
        roles: [
          "UI/UX Designer",
          "Product Designer",
          "Interaction Designer",
          "Visual Designer",
          "UX Researcher",
        ],
      },
    ],
  },
  {
    id: "healthcare",
    name: "Healthcare",
    subgroups: [
      {
        name: "Clinical & Practice Operations",
        roles: [
          "Healthcare Administrator",
          "Clinical Research Associate",
          "Medical Operations Manager",
          "Nurse Practitioner",
        ],
      },
      {
        name: "Health Informatics",
        roles: [
          "Health Data Analyst",
          "Bioinformatician",
          "Health Systems Specialist",
        ],
      },
    ],
  },
  {
    id: "electrical-engineering",
    name: "Electrical Engineering",
    subgroups: [
      {
        name: "Hardware & Embedded Systems",
        roles: [
          "Embedded Systems Engineer",
          "Hardware Design Engineer",
          "PCB Design Engineer",
          "Firmware Engineer",
          "VLSI Design Engineer",
        ],
      },
      {
        name: "Power & Systems",
        roles: [
          "Electrical Systems Engineer",
          "Control Systems Engineer",
          "Power Electronics Engineer",
          "Automation Engineer",
        ],
      },
    ],
  },
  {
    id: "human-resource-administrative-legal",
    name: "Human Resource/Administrative/Legal",
    subgroups: [
      {
        name: "Executive and Administrative",
        roles: [
          "Administrative Assistant",
          "Executive Assistant",
          "Office Manager",
          "Receptionist",
          "Chief of Staff",
          "Data Entry Clerk",
        ],
      },
      {
        name: "Human Resource",
        roles: [
          "Human Resource Specialist",
          "Recruiter/Sourcer",
          "Recruiting Coordinator",
          "HR Business Partner",
          "Human Resource Manager/Director",
          "Payroll Specialist",
          "Talent Acquisition Manager",
        ],
      },
      {
        name: "Legal",
        roles: [
          "Paralegal",
          "Corporate Counsel",
          "Compliance Officer",
          "Legal Counsel",
          "Contract Specialist",
        ],
      },
    ],
  },
  {
    id: "sales",
    name: "Sales",
    subgroups: [
      {
        name: "Inside & Inbound Sales",
        roles: [
          "Sales Development Representative (SDR)",
          "Business Development Representative (BDR)",
          "Inbound Sales Specialist",
        ],
      },
      {
        name: "Enterprise & Direct Sales",
        roles: [
          "Account Executive (AE)",
          "Enterprise Sales Manager",
          "Sales Director",
          "Customer Acquisition Specialist",
        ],
      },
    ],
  },
  {
    id: "production-manufacturing",
    name: "Production/Manufacturing",
    subgroups: [
      {
        name: "Operations & Logistics",
        roles: [
          "Supply Chain Manager",
          "Logistics Coordinator",
          "Plant Operations Manager",
          "Quality Assurance Specialist",
          "Industrial Engineer",
          "Manufacturing Technician",
        ],
      },
    ],
  },
  {
    id: "customer-service",
    name: "Customer Service",
    subgroups: [
      {
        name: "Customer Support",
        roles: [
          "Customer Support Specialist",
          "Technical Support Engineer",
          "Customer Care Representative",
          "Helpdesk Specialist",
        ],
      },
      {
        name: "Client Success",
        roles: [
          "Customer Success Manager (CSM)",
          "Client Services Associate",
          "Implementation Specialist",
        ],
      },
    ],
  },
];

export const ALL_ROLES: string[] = ONBOARDING_CATEGORIES.flatMap((c) =>
  c.subgroups.flatMap((sg) => sg.roles)
);

export const LOCATION_OPTIONS = [
  "Bengaluru, Karnataka",
  "Mumbai, Maharashtra",
  "Delhi NCR (Delhi, Gurugram, Noida)",
  "Hyderabad, Telangana",
  "Pune, Maharashtra",
  "Chennai, Tamil Nadu",
  "Kolkata, West Bengal",
  "Ahmedabad, Gujarat",
  "Worldwide / Remote",
];

export const WORK_AUTH_OPTIONS = [
  { id: "authorized", label: "Authorized to work (No sponsorship required)" },
  { id: "requires_sponsorship", label: "Requires visa sponsorship (e.g. H1B)" },
  { id: "other", label: "Other / Work Permit" },
];

export const JOB_TYPE_OPTIONS = [
  { id: "full-time", label: "Full-time" },
  { id: "contract", label: "Contract" },
  { id: "part-time", label: "Part-time" },
  { id: "internship", label: "Internship" },
];
