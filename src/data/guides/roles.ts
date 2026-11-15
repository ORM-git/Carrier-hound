// TODO: REPLACE WITH REAL CONTENT
export interface RoleLadderRung {
  level: string;
  titles: string[];
  yoe: string;
  salaryBand: string;
  scope: string;
}

export interface TitleBand {
  title: string;
  commonEquivalents: string[];
  medianComp: string;
  remoteAvailability: string;
}

export interface CertRoute {
  certName: string;
  issuer: string;
  relevance: string;
  estimatedStudyTime: string;
  impactScore: number; // out of 100
}

export interface FitMeter {
  label: string;
  percentage: number;
  description: string;
}

export interface RoleGuideData {
  roleSlug: string;
  roleName: string;
  hero: {
    eyebrow: string;
    title: string;
    lede: string;
  };
  overview: {
    h2: string;
    text: string;
  };
  ladder: RoleLadderRung[];
  titleBands: TitleBand[];
  certRoutes: CertRoute[];
  fitMeters: FitMeter[];
  eligibilityCompass: {
    title: string;
    quadrants: {
      title: string;
      description: string;
      requirements: string[];
    }[];
  };
  sampleJobCategory: string;
  faqs: {
    question: string;
    answer: string;
  }[];
}

export const ROLE_GUIDES: Record<string, RoleGuideData> = {
  "devops-engineer": {
    roleSlug: "devops-engineer",
    roleName: "DevOps & Cloud Platform Engineer",
    hero: {
      eyebrow: "CAREER ARCHITECTURE GUIDE",
      title: "DevOps & Platform Engineering Title Ladders & Global Compensation Bands",
      lede: "A complete structural breakdown of engineering titles, seniority benchmarks, Kubernetes tooling requirements, and verified salary ranges for remote infrastructure professionals in 2026.",
    },
    overview: {
      h2: "The Evolution from SysAdmin to Cloud Platform Architect",
      text: "The infrastructure engineering landscape has fractured into specialized disciplines: Site Reliability Engineering (SRE), Platform Engineering, Infrastructure as Code (IaC) specialists, and Cloud Security engineers. Navigating which title commands the highest autonomy and compensation requires understanding how tech employers evaluate system scale.",
    },
    ladder: [
      {
        level: "L3 / Junior",
        titles: ["Associate DevOps Engineer", "Cloud Support Engineer", "Junior SRE"],
        yoe: "0 - 2 years",
        salaryBand: "$90,000 - $125,000",
        scope: "Ticket-driven cloud configuration, CI/CD pipeline maintenance, baseline monitoring alerts.",
      },
      {
        level: "L4 / Mid-Level",
        titles: ["DevOps Engineer", "Cloud Infrastructure Engineer", "SRE"],
        yoe: "2 - 5 years",
        salaryBand: "$130,000 - $165,000",
        scope: "Autonomous Terraform modules, Docker/Kubernetes container orchestration, incident triage.",
      },
      {
        level: "L5 / Senior",
        titles: ["Senior DevOps Engineer", "Senior SRE", "Cloud Architect"],
        yoe: "5 - 8 years",
        salaryBand: "$165,000 - $210,000",
        scope: "Architecting multi-region failover, cost optimization, automated developer platform tooling.",
      },
      {
        level: "L6 / Staff",
        titles: ["Staff Platform Engineer", "Principal Infrastructure Architect"],
        yoe: "8+ years",
        salaryBand: "$210,000 - $275,000+",
        scope: "Cross-organizational architecture, zero-trust cloud security posture, long-term tech roadmap.",
      },
    ],
    titleBands: [
      {
        title: "Site Reliability Engineer (SRE)",
        commonEquivalents: ["Production Systems Engineer", "Service Reliability Specialist"],
        medianComp: "$175,000",
        remoteAvailability: "Very High (88% Remote)",
      },
      {
        title: "Platform Engineer",
        commonEquivalents: ["Internal Developer Platform (IDP) Engineer", "Core Infra Engineer"],
        medianComp: "$182,000",
        remoteAvailability: "High (82% Remote)",
      },
      {
        title: "DevOps Engineer (Generalist)",
        commonEquivalents: ["Build & Release Engineer", "Cloud Operations Specialist"],
        medianComp: "$158,000",
        remoteAvailability: "Very High (91% Remote)",
      },
      {
        title: "Cloud Security Architect",
        commonEquivalents: ["DevSecOps Engineer", "Infra Security Lead"],
        medianComp: "$195,000",
        remoteAvailability: "High (79% Remote)",
      },
    ],
    certRoutes: [
      {
        certName: "Certified Kubernetes Administrator (CKA)",
        issuer: "Cloud Native Computing Foundation (CNCF)",
        relevance: "Industry standard benchmark for production cluster operations.",
        estimatedStudyTime: "8 - 12 weeks",
        impactScore: 94,
      },
      {
        certName: "AWS Certified Solutions Architect - Professional",
        issuer: "Amazon Web Services",
        relevance: "High-signal credential for large enterprise cloud transitions.",
        estimatedStudyTime: "12 - 16 weeks",
        impactScore: 91,
      },
      {
        certName: "HashiCorp Certified: Terraform Associate",
        issuer: "HashiCorp",
        relevance: "Essential validation for Infrastructure as Code competency.",
        estimatedStudyTime: "3 - 5 weeks",
        impactScore: 82,
      },
    ],
    fitMeters: [
      {
        label: "Linux Systems & Networking Internals",
        percentage: 92,
        description: "Deep proficiency in TCP/IP, DNS, kernel tuning, and systemd.",
      },
      {
        label: "Infrastructure as Code & Automation",
        percentage: 88,
        description: "Declarative configuration via Terraform, Pulumi, and Ansible.",
      },
      {
        label: "Incident Triage & Observability",
        percentage: 84,
        description: "Telemetry parsing with Prometheus, Grafana, OpenTelemetry, and Datadog.",
      },
      {
        label: "Software Engineering & Scripting",
        percentage: 78,
        description: "Proficiency in Go, Python, or Bash for building custom internal tooling.",
      },
    ],
    eligibilityCompass: {
      title: "Infrastructure Hiring Eligibility Compass",
      quadrants: [
        {
          title: "Tier 1: Global High-Autonomy",
          description: "Distributed startups offering US-benchmarked pay with zero geographical restrictions.",
          requirements: ["Staff-level track record", "Asynchronous RFC authoring", "Proven Kubernetes at scale"],
        },
        {
          title: "Tier 2: Regional Hubs (US / EU)",
          description: "Companies with dedicated legal entities in specified tax corridors.",
          requirements: ["Local work authorization", "Overlapping timezone (>= 4 hours)", "Mid-level to Senior mastery"],
        },
        {
          title: "Tier 3: Regulated Enterprise",
          description: "Financial, healthcare, or government contractors requiring on-soil clearance.",
          requirements: ["Citizenship / security clearance", "SOC2 / HIPAA familiarity", "Vendor certification prerequisites"],
        },
        {
          title: "Tier 4: Early Venture / Seed",
          description: "Pre-PMF startups requiring scrappy end-to-end full stack infrastructure coverage.",
          requirements: ["Breadth over specialization", "Fast deployment cycles", "Equity upside focus"],
        },
      ],
    },
    sampleJobCategory: "devops",
    faqs: [
      {
        question: "Is DevOps still a standalone job title or a cultural philosophy?",
        answer: "While DevOps began as an engineering philosophy, it remains one of the most widely searched requisition titles in modern employer portals. However, organizations with mature systems increasingly recruit under 'Platform Engineer' or 'SRE' titles.",
      },
      {
        question: "How important are certifications for experienced DevOps engineers?",
        answer: "For Senior and Staff positions, production architecture case studies and open-source contributions carry substantially more weight than certifications. However, credentials like CKA provide high signal when filtering through initial automated recruiter screens.",
      },
      {
        question: "What is the typical salary difference between general DevOps and specialized SRE?",
        answer: "SRE roles typically command a 5% to 15% salary premium because they require strong software engineering fundamentals (algorithmic coding in Go/Python) alongside systems operations skills.",
      },
    ],
  },
  "product-designer": {
    roleSlug: "product-designer",
    roleName: "Product & UI/UX Designer",
    hero: {
      eyebrow: "DESIGN PRACTICE GUIDE",
      title: "Product Design Title Ladders, Design Systems & Remote Compensation",
      lede: "How technology companies classify Product Designers, UI/UX Specialists, and Design Systems Engineers from junior contributor to Design Director in remote setups.",
    },
    overview: {
      h2: "Deconstructing Modern Digital Product Design",
      text: "The transition from visual interface design to product design demands strong product strategy, user research, data literacy, and system architecture comprehension. Today's top remote designers function as cross-functional product leaders.",
    },
    ladder: [
      {
        level: "L3 / Associate",
        titles: ["Junior Product Designer", "Associate UX Designer"],
        yoe: "0 - 2 years",
        salaryBand: "$80,000 - $110,000",
        scope: "Executing wireframes, maintaining component libraries, prototyping user journeys.",
      },
      {
        level: "L4 / Mid-Level",
        titles: ["Product Designer", "UI/UX Designer"],
        yoe: "2 - 5 years",
        salaryBand: "$115,000 - $150,000",
        scope: "End-to-end feature design, usability testing sessions, partnering closely with engineers.",
      },
      {
        level: "L5 / Senior",
        titles: ["Senior Product Designer", "Lead UX Architect"],
        yoe: "5 - 8 years",
        salaryBand: "$150,000 - $190,000",
        scope: "Owning major product domain areas, design system governance, mentorship of junior staff.",
      },
      {
        level: "L6 / Staff & Principal",
        titles: ["Staff Product Designer", "Principal Designer", "Director of Design"],
        yoe: "8+ years",
        salaryBand: "$190,000 - $250,000+",
        scope: "Company-wide design vision, design ops strategy, aligning design initiatives with revenue goals.",
      },
    ],
    titleBands: [
      {
        title: "Product Designer (Core)",
        commonEquivalents: ["Digital Product Designer", "UX/UI Specialist"],
        medianComp: "$145,000",
        remoteAvailability: "Very High (89% Remote)",
      },
      {
        title: "Design Systems Designer",
        commonEquivalents: ["Design Technologist", "Figma Systems Specialist"],
        medianComp: "$160,000",
        remoteAvailability: "High (84% Remote)",
      },
      {
        title: "Product Design Lead / Manager",
        commonEquivalents: ["Design Team Lead", "UX Manager"],
        medianComp: "$180,000",
        remoteAvailability: "High (78% Remote)",
      },
    ],
    certRoutes: [
      {
        certName: "Nielsen Norman Group UX Master Certified (UXMC)",
        issuer: "Nielsen Norman Group",
        relevance: "Gold standard for rigorous qualitative research methodology.",
        estimatedStudyTime: "12 - 16 weeks",
        impactScore: 89,
      },
      {
        certName: "Interaction Design Foundation Master Class",
        issuer: "IxDF",
        relevance: "Comprehensive fundamentals in interaction patterns and accessibility.",
        estimatedStudyTime: "6 - 10 weeks",
        impactScore: 78,
      },
    ],
    fitMeters: [
      {
        label: "Systems Thinking & Design Systems",
        percentage: 95,
        description: "Component tokens, multi-platform scalability, and auto-layout mastery.",
      },
      {
        label: "User Research & Discovery Synthesis",
        percentage: 85,
        description: "Conducting customer interviews, usability benchmarks, and journey mapping.",
      },
      {
        label: "Technical & Frontend Feasibility",
        percentage: 80,
        description: "Understanding HTML/CSS flexbox, component trees, and engineering trade-offs.",
      },
      {
        label: "Business & Growth Strategy",
        percentage: 75,
        description: "Connecting design decisions to activation, retention, and conversion metrics.",
      },
    ],
    eligibilityCompass: {
      title: "Product Design Hiring Eligibility Compass",
      quadrants: [
        {
          title: "Product-Led Growth (PLG) SaaS",
          description: "High velocity teams focused on friction-free onboarding and viral adoption loops.",
          requirements: ["Self-serve UX expertise", "Rapid multivariate testing", "Figma speed"],
        },
        {
          title: "Complex B2B Enterprise",
          description: "Deep domain tooling with high cognitive load and dense information architecture.",
          requirements: ["Information architecture mastery", "Technical workflow design", "Design systems governance"],
        },
        {
          title: "Consumer Mobile & Fintech",
          description: "Polished micro-interactions, brand aesthetics, and regulatory compliance flows.",
          requirements: ["Micro-motion prototyping", "High visual polish", "Strict privacy UX"],
        },
        {
          title: "AI Interface & Generative Tools",
          description: "Designing dynamic prompt workflows, non-deterministic states, and streaming responses.",
          requirements: ["Dynamic state handling", "Conversational UX", "Mental model innovation"],
        },
      ],
    },
    sampleJobCategory: "design",
    faqs: [
      {
        question: "How has AI impacted remote product design hiring?",
        answer: "Companies prioritize designers who can architect high-complexity workflows and design system architectures over pure visual asset creators. Designers who understand frontend code have a significant hiring advantage.",
      },
      {
        question: "Do I need a formal design degree to land a senior product design role?",
        answer: "No. Hiring teams evaluate interactive case studies, design rationale, and business outcomes far above formal credentials.",
      },
    ],
  },
};
