// TODO: REPLACE WITH REAL CONTENT
export interface CategoryLandingData {
  slug: string;
  name: string;
  eyebrow: string;
  title: string;
  lede: string;
  proofStrip: {
    heading: string;
    subheading: string;
    metrics: {
      label: string;
      value: string;
    }[];
  };
  openingsCount: string;
  openingsDescription: string;
  titleAliases: string[];
  faqs: {
    question: string;
    answer: string;
  }[];
  relatedGuides: {
    title: string;
    description: string;
    href: string;
  }[];
}

export const CATEGORY_LANDINGS: Record<string, CategoryLandingData> = {
  devops: {
    slug: "devops",
    name: "DevOps & Cloud Infrastructure",
    eyebrow: "FRESH INFRASTRUCTURE ROLES",
    title: "Unindexed DevOps & Cloud Platform Engineering Positions",
    lede: "Discover direct ATS engineering requisitions before they are syndicated to public job aggregators. Filter verified remote infrastructure roles by salary band and tech stack.",
    proofStrip: {
      heading: "Verified Employer Feeds Only",
      subheading: "Crawled directly from employer ATS endpoints every 15 minutes.",
      metrics: [
        { label: "Active Postings", value: "Verified Active" },
        { label: "Median Compensation", value: "$168,000" },
        { label: "Direct ATS Ingestion", value: "100%" },
        { label: "Ghost Rate", value: "< 0.4%" },
      ],
    },
    openingsCount: "Verified Active Infrastructure Roles",
    openingsDescription: "The listings below are monitored live. Positions are automatically retired the moment an employer closes their internal requisition.",
    titleAliases: [
      "Site Reliability Engineer (SRE)",
      "Platform Engineer",
      "Cloud Infrastructure Architect",
      "DevSecOps Engineer",
      "Kubernetes Systems Specialist",
      "GitOps Release Engineer",
      "AWS Cloud Engineer",
      "GCP Platform Specialist",
      "Observability Engineer",
      "Terraform Automation Lead",
      "Core Systems Architect",
    ],
    faqs: [
      {
        question: "How do I apply directly to the employer?",
        answer: "Clicking 'Sign in to view' unlocks the raw employer ATS link (Greenhouse, Lever, Ashby, or Workday). You submit your application directly on the employer's official subdomain, bypassing intermediary aggregators.",
      },
      {
        question: "Are these infrastructure roles open to international applicants?",
        answer: "Each listing explicitly indicates residency requirements. Use the country filter in the full job search to isolate worldwide, EU-only, or US-only positions.",
      },
      {
        question: "How quickly are filled roles removed from the feed?",
        answer: "Our automated health check verifies ATS status codes continuously throughout the day. When a job is closed on the host system, it is removed from our live feed within minutes.",
      },
    ],
    relatedGuides: [
      {
        title: "DevOps Title Ladder & Seniority Benchmark",
        description: "Explore compensation bands from Junior to Staff Platform Architect.",
        href: "/remote/devops-engineer/titles",
      },
      {
        title: "The Zero-Ghost Protocol for Technical Roles",
        description: "How to confirm active budget on technical engineering openings.",
        href: "/remote/remote-job-search-secrets",
      },
    ],
  },
  design: {
    slug: "design",
    name: "Product & UI/UX Design",
    eyebrow: "CURATED DESIGN REQUISITIONS",
    title: "Remote Product Design & Design Systems Opportunities",
    lede: "Skip crowded portfolio queues on public boards. Access unindexed Product Designer, Design Technologist, and UX Research openings directly from hiring teams.",
    proofStrip: {
      heading: "Direct Design Studio Ingestion",
      subheading: "Vetted digital product studios and high-growth venture design teams.",
      metrics: [
        { label: "Active Postings", value: "Verified Active" },
        { label: "Median Compensation", value: "$145,000" },
        { label: "Direct Studio Source", value: "100%" },
        { label: "Response Rate Advantage", value: "3.8x" },
      ],
    },
    openingsCount: "Verified Live Product Design Roles",
    openingsDescription: "Direct feeds from design-led companies seeking senior individual contributors and systems architects.",
    titleAliases: [
      "Senior Product Designer",
      "Staff UI/UX Designer",
      "Design Systems Lead",
      "UX Research Specialist",
      "Design Technologist",
      "Interaction Designer",
      "Visual Brand Designer",
      "Head of Product Design",
      "Mobile Product Designer",
    ],
    faqs: [
      {
        question: "Do these design openings include portfolio requirements?",
        answer: "Yes, all design postings navigate to the official application form where you can link your portfolio, case study repository, or Figma prototypes.",
      },
      {
        question: "Can I filter by specific design tools like Figma or Design Systems?",
        answer: "Yes, our exact title and keyword search engine supports querying for design systems, Figma tokens, mobile iOS/Android, and web applications.",
      },
    ],
    relatedGuides: [
      {
        title: "Product Design Title Ladders & Compensation",
        description: "Seniority benchmarks, equity expectations, and remote design salaries.",
        href: "/remote/product-designer/titles",
      },
      {
        title: "How to Build Portfolios That Skip HR Recruiter Screens",
        description: "Presenting systems architecture and measurable product outcomes.",
        href: "/remote/hidden-job-market-guide",
      },
    ],
  },
  marketing: {
    slug: "marketing",
    name: "Growth & Product Marketing",
    eyebrow: "REVENUE & GROWTH POSTINGS",
    title: "High-Leverage Growth & Product Marketing Requisitions",
    lede: "Connect directly with SaaS founders and CMOs hiring for Growth Engineering, Product Marketing, Lifecycle Management, and Demand Generation without agency friction.",
    proofStrip: {
      heading: "Validated Growth Opportunities",
      subheading: "Strictly filtered for venture-backed and profitable software businesses.",
      metrics: [
        { label: "Active Postings", value: "Verified Active" },
        { label: "Median Compensation", value: "$138,000" },
        { label: "B2B SaaS Concentration", value: "82%" },
        { label: "Verified Budgets", value: "100%" },
      ],
    },
    openingsCount: "Verified Active Marketing Roles",
    openingsDescription: "Direct requisitions from companies actively scaling their acquisition, retention, and content engines.",
    titleAliases: [
      "Product Marketing Manager (PMM)",
      "Head of Growth",
      "Director of Demand Generation",
      "Lifecycle Marketing Lead",
      "Content & Brand Strategist",
      "Growth Marketing Specialist",
      "Technical SEO Director",
      "VP of Marketing",
    ],
    faqs: [
      {
        question: "Are these marketing roles performance/commission-only or salaried?",
        answer: "We strictly filter out commission-only and multi-level marketing roles. 100% of listings on CareerMonke are legitimate W2/EOR salaried or fixed-rate contract positions.",
      },
    ],
    relatedGuides: [
      {
        title: "The Unadvertised Pipeline for Growth Roles",
        description: "How early stage companies hire growth leaders before announcing public rounds.",
        href: "/remote/hidden-job-market-guide",
      },
    ],
  },
  data: {
    slug: "data",
    name: "Data Platform & Analytics",
    eyebrow: "DATA & ANALYTICS PIPELINES",
    title: "Unindexed Data Engineering & Analytics Roles",
    lede: "Direct company requisitions for Snowflake, dbt, Databricks, Apache Spark, and modern analytics platform architects at premier distributed organizations.",
    proofStrip: {
      heading: "Clean Data Pipeline Sources",
      subheading: "Continuous ATS tracking across data-intensive tech enterprises.",
      metrics: [
        { label: "Active Postings", value: "Verified Active" },
        { label: "Median Compensation", value: "$162,000" },
        { label: "Modern Data Stack", value: "94%" },
        { label: "Direct Ingestion", value: "100%" },
      ],
    },
    openingsCount: "Verified Live Data Openings",
    openingsDescription: "Targeted data architecture, machine learning engineering, and business intelligence opportunities.",
    titleAliases: [
      "Senior Data Engineer",
      "Analytics Engineer (dbt)",
      "Staff Data Architect",
      "BI Solutions Engineer",
      "Machine Learning Data Specialist",
      "Data Platform Lead",
      "Data Governance Engineer",
    ],
    faqs: [
      {
        question: "Do these roles focus on modern data stack tooling?",
        answer: "Yes, our indexing taxonomy highlights roles utilizing modern cloud data warehouses (Snowflake, BigQuery, Databricks) and transformation frameworks (dbt, Dagster, Airflow).",
      },
    ],
    relatedGuides: [
      {
        title: "Engineering Compensation Bands in 2026",
        description: "Salary benchmarks across data, ML, and software engineering disciplines.",
        href: "/remote/devops-engineer/titles",
      },
    ],
  },
  support: {
    slug: "support",
    name: "Customer Support & Success",
    eyebrow: "CUSTOMER ADVOCACY OPENINGS",
    title: "Verified Remote Customer Support & Success Requisitions",
    lede: "Escape low-wage call center postings. Find legitimate Tier 2/3 technical support, Customer Success Management, and client onboarding roles at leading software firms.",
    proofStrip: {
      heading: "Verified Software Support Only",
      subheading: "Filtering out spam agencies and commission-only disguised positions.",
      metrics: [
        { label: "Active Postings", value: "Verified Active" },
        { label: "Median Compensation", value: "$76,000" },
        { label: "Software / Tech Ratio", value: "96%" },
        { label: "Direct Employer URL", value: "100%" },
      ],
    },
    openingsCount: "Verified High-Quality Support Roles",
    openingsDescription: "Empathetic, technical, and high-touch support roles at organizations that value their customer success teams.",
    titleAliases: [
      "Customer Success Manager (CSM)",
      "Technical Support Specialist (Tier 2/3)",
      "Customer Onboarding Manager",
      "Support Operations Specialist",
      "Enterprise Account Manager",
      "Client Solutions Engineer",
    ],
    faqs: [
      {
        question: "Do these support positions require specific timezone coverage?",
        answer: "Most support teams specify required shift hours or regional timezones (e.g., US Eastern, Central European Time). These are clearly labeled on each listing card.",
      },
    ],
    relatedGuides: [
      {
        title: "Asynchronous Work Playbook",
        description: "How to evaluate company culture and communication standards before signing.",
        href: "/remote/remote-job-search-secrets",
      },
    ],
  },
};
