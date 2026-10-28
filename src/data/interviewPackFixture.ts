export type ItemSourceLabel =
  | "From job description"
  | "From your resume"
  | "From company source"
  | "AI suggestion";

export type CardLabel =
  | "Reported by candidates"
  | "Likely"
  | "General practice"
  | "Unverified"
  | ItemSourceLabel;

export interface ResumeBulletSource {
  role: string;
  company: string;
  bullet: string;
}

export interface SourceCitation {
  title: string;
  domain: string;
  url: string;
  date: string;
  verificationType: CardLabel;
  label?: ItemSourceLabel;
}

export interface InterviewCard {
  id: string;
  question: string;
  category: "fear" | "must-know" | "behavioral" | "technical" | "leadership" | "culture";
  label: CardLabel;
  whyTheyAsk: string; // One concise psychological line (10-25 words)
  answerDraft: string; // 40-60 words concise draft
  expandedAnswer: string; // Full in-depth framework (STAR or structured)
  resumeBulletSource: ResumeBulletSource;
  source: SourceCitation;
  isMustKnow: boolean;
}

export interface CompanyBriefNews {
  title: string;
  date: string;
  source: string;
  url: string;
  snippet: string;
  label?: ItemSourceLabel;
}

export interface CultureSignal {
  title: string;
  detail: string;
  sentiment: "positive" | "neutral" | "caution";
  label?: ItemSourceLabel;
}

export interface InterviewProcessStage {
  step: number;
  name: string;
  duration: string;
  format: string;
  focus: string;
  proTip: string;
  label?: ItemSourceLabel;
}

export interface GapMatrixItem {
  id: string;
  jdRequirement: string;
  resumeStatus: "matched" | "partial" | "gap";
  resumeEvidence: string;
  bridgeStrategy: string;
  label?: ItemSourceLabel;
}

export interface ReverseQuestion {
  id: string;
  question: string;
  category: "Engineering culture" | "Business direction" | "Role expectations" | "Team dynamics";
  whyAskThis: string;
  whatToListenFor: string;
  label?: ItemSourceLabel;
}

export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  label?: ItemSourceLabel;
}

export interface InterviewPackData {
  jobId: string;
  jobTitle: string;
  companyName: string;
  department: string;
  location: string;
  isThinResearch: boolean;
  fearQuestionOptions: {
    id: string;
    chip: string;
    question: string;
    whyTheyAsk: string;
    answerDraft: string;
    expandedAnswer: string;
    resumeBulletSource: ResumeBulletSource;
    source: SourceCitation;
    label?: CardLabel;
  }[];
  brief: {
    summary: string;
    mission: string;
    marketContext: string;
    recentNews: CompanyBriefNews[];
    cultureSignals: CultureSignal[];
  };
  process: {
    overview: string;
    stages: InterviewProcessStage[];
  };
  cards: InterviewCard[];
  gaps: GapMatrixItem[];
  askThem: ReverseQuestion[];
  quiz: QuizQuestion[];
  sources: SourceCitation[];
}

export const SAMPLE_INTERVIEW_PACK: InterviewPackData = {
  jobId: "sample",
  jobTitle: "Senior Full-Stack Engineer",
  companyName: "Cloud Infrastructure Technologies",
  department: "Core Platform & Infrastructure",
  location: "Remote (US / Worldwide)",
  isThinResearch: false,
  fearQuestionOptions: [
    {
      id: "fear-tell-me-about-yourself",
      chip: "Tell me about yourself",
      question: "Walk me through your background and why are you interested in this role?",
      whyTheyAsk: "They want to evaluate narrative structure, executive clarity, and whether your career trajectory naturally aligns with their mission.",
      answerDraft:
        "I am a full-stack engineer with 6 years leading cloud platforms. In my prior role, I scaled high-concurrency ingestion pipelines handling 50k events per second. I specialize in resilient distributed systems and TypeScript architectures, and I am drawn to this role because your team is solving developer infrastructure at global scale.",
      expandedAnswer:
        "Structure: Present-Past-Future framework. 1. Present: Lead Senior Full-Stack Engineer focusing on real-time event streaming. 2. Past: Scaled distributed microservices and reduced p99 latency by 35% with Redis and Kafka. 3. Future: Excited to bring zero-downtime deployment patterns to the platform's multi-region architecture.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Architected real-time event ingestion engine processing 50k events/sec with 99.99% availability.",
      },
      source: {
        title: "Cloud Platform Engineering Interview Guide",
        domain: "Public Interview Archive",
        url: "#",
        date: "Oct 2025",
        verificationType: "Reported by candidates",
      },
    },
    {
      id: "fear-salary",
      chip: "Salary",
      question: "What are your target compensation expectations for this role?",
      whyTheyAsk: "They are testing if you fit within their approved band before committing 5 interview hours to your candidacy.",
      answerDraft:
        "Based on my 6 years leading distributed systems and market data for remote senior roles, I am targeting between $165k and $190k base, plus equity. However, fit and engineering culture come first, and I am open to a competitive total package.",
      expandedAnswer:
        "Strategy: Anchor high within the public band, cite market standards, and maintain collaborative tone. Avoid giving a rigid single number. Emphasize total compensation including stock options and flexible benefits.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Led 5-person technical squad delivering core billing integrations driving $12M annual GMV.",
      },
      source: {
        title: "Levels.fyi Benchmark Data: Cloud Platform Senior Engineer",
        domain: "Public Compensation Benchmarks",
        url: "#",
        date: "Nov 2025",
        verificationType: "Reported by candidates",
      },
    },
    {
      id: "fear-why-leave",
      chip: "Why leave",
      question: "Why are you looking to move on from your current position?",
      whyTheyAsk: "They want to verify you are moving toward high-impact growth rather than running away from conflict or performance hurdles.",
      answerDraft:
        "I have spent three rewarding years scaling our streaming pipeline and mentoring junior teammates. Having achieved those milestones, our product has entered maintenance mode. I am eager to join a high-velocity team tackling complex edge infrastructure like Cloud Platform.",
      expandedAnswer:
        "Strategy: Frame the departure purely around technical ambition and readiness for new architectural scale. Praise past teammates and managers, state the milestone achieved, and connect directly to the platform's active scaling roadmap.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Promoted after scaling core streaming service from 5,000 to 50,000 requests/sec with zero downtime.",
      },
      source: {
        title: "Candidate Debrief: Cloud Platform Recruiter Screen",
        domain: "Candidate Community Archive",
        url: "#",
        date: "Dec 2025",
        verificationType: "Reported by candidates",
      },
    },
    {
      id: "fear-technical",
      chip: "Technical",
      question: "Tell me about a time you made a significant technical mistake or outage.",
      whyTheyAsk: "They want to evaluate psychological safety, honest accountability, root-cause depth, and blameless post-mortem follow-through.",
      answerDraft:
        "During a database migration at Datadog, an unindexed query locked the user table for 4 minutes. I immediately rolled back, notified the on-call incident team, and took ownership. Afterward, I authored the blameless post-mortem and automated index pre-checks in our CI pipeline to prevent recurrences.",
      expandedAnswer:
        "Framework: STAR format with emphasis on incident mitigation. 1. Situation: High-traffic schema alteration. 2. Action: Executed rollback playbook and led stakeholder status page communication. 3. Learning: Added automated EXPLAIN ANALYZE linters to CI gates.",
      resumeBulletSource: {
        role: "Staff Infrastructure Engineer",
        company: "Datadog",
        bullet: "Authored 14 blameless incident reviews; implemented CI automated query validation reducing production incidents by 40%.",
      },
      source: {
        title: "Cloud Platform Technical Bar Raiser Checklist",
        domain: "github.com",
        url: "#",
        date: "Sep 2025",
        verificationType: "Reported by candidates",
      },
    },
  ],
  brief: {
    summary:
      "Cloud Infrastructure Technologies builds developer-first cloud primitives and serverless execution environments powering over 40,000 global tech companies. Headquartered remotely across 18 countries.",
    mission:
      "Eliminating the friction between writing high-performance code and running it globally with single-digit millisecond latency.",
    marketContext:
      "Recently raised Series C ($75M) led by Sequoia; rapidly scaling infrastructure to compete directly with Cloudflare Workers and AWS Lambda at edge nodes.",
    recentNews: [
      {
        title: "Cloud Platform launches Multi-Region Distributed Key-Value Store",
        date: "Oct 14, 2025",
        source: "TechCrunch",
        url: "#",
        snippet: "Cloud Platform unveiled global sub-10ms data storage accessible directly from edge functions worldwide.",
      },
      {
        title: "Cloud Platform passes SOC2 Type II and ISO 27001 Security Audits",
        date: "Sep 28, 2025",
        source: "Engineering Blog",
        url: "https://blog.engineering.internal/security-milestone",
        snippet: "Enterprise-grade compliance achieved ahead of major Fortune 500 deployment contracts.",
      },
    ],
    cultureSignals: [
      {
        title: "Async-First & Documentation-Driven",
        detail: "Decisions are drafted as RFCs before code is committed. Few recurring meetings; high autonomy expected.",
        sentiment: "positive",
      },
      {
        title: "High Production Ownership",
        detail: "Engineers own their code from local prototype to on-call rotation. Strong blameless culture around outages.",
        sentiment: "positive",
      },
      {
        title: "Fast-Paced Ship Cycles",
        detail: "Releases happen multiple times daily. Requires comfort with trunk-based development and feature flags.",
        sentiment: "neutral",
      },
    ],
  },
  process: {
    overview:
      "Cloud Platform uses a 4-stage transparent interview pipeline designed to mirror day-to-day engineering collaboration rather than whiteboard trivia.",
    stages: [
      {
        step: 1,
        name: "Recruiter Screen",
        duration: "30 mins",
        format: "Zoom video call",
        focus: "Background alignment, work model expectations, salary band check, and culture fit.",
        proTip: "Have concise 90-second answers for your recent projects and keep compensation expectations clear.",
      },
      {
        step: 2,
        name: "Technical Deep Dive & Code Review",
        duration: "60 mins",
        format: "Paired coding session (CoderPad)",
        focus: "Practical async JavaScript/TypeScript problem, concurrency handling, and error boundaries.",
        proTip: "Talk out loud constantly. They value communication and how you test edge cases over speed of code completion.",
      },
      {
        step: 3,
        name: "Distributed Systems Architecture",
        duration: "60 mins",
        format: "Virtual whiteboard (Excalidraw)",
        focus: "Designing an edge-rate limiter or real-time event cache. Scalability, trade-offs, and failure modes.",
        proTip: "Ask clarifying questions on read/write ratios and latency constraints before drawing boxes.",
      },
      {
        step: 4,
        name: "Values & Cross-Functional Collaboration",
        duration: "45 mins",
        format: "Discussion with VP of Engineering & Product Lead",
        focus: "How you handle technical debt, mentor junior engineers, and manage product trade-offs.",
        proTip: "Cite real examples from past projects where you compromised technical perfection for user delivery.",
      },
    ],
  },
  cards: [
    {
      id: "card-1",
      question: "How do you handle race conditions in distributed edge environments?",
      category: "must-know",
      label: "Reported by candidates",
      whyTheyAsk: "Cloud Platform runs code across 250+ edge nodes; concurrency and eventual consistency are core daily problems.",
      answerDraft:
        "I utilize optimistic locking with version vectors for low-contention routes, and Redis-backed distributed locks with token renewals for critical financial mutations. In my previous role, this eliminated duplicate transaction processing across concurrent webhooks.",
      expandedAnswer:
        "When designing for edge concurrency: 1. Evaluate whether strong consistency is mandatory or if idempotent deduplication keys suffice. 2. Use atomic Compare-And-Swap (CAS) primitives. 3. Implement exponential backoff jitter on lock acquisition failures to avoid thundering herd.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Designed distributed idempotency middleware preventing duplicate payments across 2M daily webhook deliveries.",
      },
      source: {
        title: "Cloud Platform Systems Interview Feedback",
        domain: "Public Interview Archive",
        url: "#",
        date: "Oct 2025",
        verificationType: "Reported by candidates",
      },
      isMustKnow: true,
    },
    {
      id: "card-2",
      question: "Describe your experience optimizing Next.js and React server component performance.",
      category: "must-know",
      label: "Reported by candidates",
      whyTheyAsk: "They want to know if you understand modern React architecture without causing client-side bundle bloat.",
      answerDraft:
        "I profile using Chrome DevTools Performance tab and Next.js bundle analyzers. By streaming non-critical server components with Suspense and co-locating client state, I reduced LCP from 2.8s to 0.9s on our primary customer portal.",
      expandedAnswer:
        "Key tactics: 1. Keep heavy third-party libraries on the server side to shrink client JavaScript payload. 2. Use parallel data fetching with Promise.all over sequential waterfalls. 3. Leverage memoization and virtualized lists for large data tables.",
      resumeBulletSource: {
        role: "Full-Stack Engineer",
        company: "Vercel Partner Agency",
        bullet: "Optimized Next.js enterprise dashboard Core Web Vitals, achieving 99+ Lighthouse performance scores.",
      },
      source: {
        title: "Frontend Engineering Round Insights",
        domain: "Candidate Community Archive",
        url: "#",
        date: "Nov 2025",
        verificationType: "Reported by candidates",
      },
      isMustKnow: true,
    },
    {
      id: "card-3",
      question: "How do you approach testing distributed asynchronous systems?",
      category: "must-know",
      label: "Reported by candidates",
      whyTheyAsk: "They care deeply about automated regression safety without relying on slow, brittle end-to-end suites.",
      answerDraft:
        "I apply testing pyramids: lightweight unit tests with strict contract mocks for business logic, testcontainers for ephemeral database integration, and negative chaos injection to verify timeouts, circuit breakers, and retry backoffs.",
      expandedAnswer:
        "Rather than mocking network calls completely, I prefer consumer-driven contract tests using Pact and spinning up transient Postgres/Redis containers in CI. This catches schema divergence before deployment.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Built comprehensive contract test suite in GitHub Actions, slashing staging regressions by 65%.",
      },
      source: {
        title: "Core Engineering Principles Documentation",
        domain: "engineering.internal",
        url: "https://engineering.internal/docs/engineering-testing",
        date: "Aug 2025",
        verificationType: "Reported by candidates",
      },
      isMustKnow: true,
    },
    {
      id: "card-4",
      question: "Tell me about a disagreement you had with a product manager over technical debt.",
      category: "behavioral",
      label: "Likely",
      whyTheyAsk: "They test business empathy, communication without arrogance, and pragmatic balance between velocity and hygiene.",
      answerDraft:
        "When our PM wanted to rush a customer dashboard feature while database connection pools were maxing out, I quantified the risk in revenue terms. We compromised: 3 days of connection pooling refactor followed immediately by the feature launch.",
      expandedAnswer:
        "Key principle: Never speak in abstract 'clean code' terms to product stakeholders. Translate technical debt into risk to uptime, delivery velocity, and operational costs. Propose tiered phased deliveries.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Partnered with product leadership to balance feature roadmaps with 20% dedicated architectural maintenance sprints.",
      },
      source: {
        title: "Behavioral Standard Questions at Growth Startups",
        domain: "interviewing.io",
        url: "https://interviewing.io/guides/behavioral-interviews",
        date: "Sep 2025",
        verificationType: "Likely",
      },
      isMustKnow: true,
    },
    {
      id: "card-5",
      question: "How do you design an API that needs to scale to tens of millions of daily requests?",
      category: "must-know",
      label: "Reported by candidates",
      whyTheyAsk: "Core capability test for platform teams handling developer-facing webhooks and REST/GraphQL APIs.",
      answerDraft:
        "I start with clear schema versioning, pagination via opaque cursors, and tiered rate-limiting at edge gateways. For read-heavy endpoints, I employ stale-while-revalidate caching and read replicas, keeping database writes buffered via message queues.",
      expandedAnswer:
        "Architectural layers: 1. Edge Layer: Cloudflare/Fastly caching & token-bucket rate limiting. 2. Gateway Layer: Schema validation and auth token decoding. 3. Service Layer: Stateless microservices. 4. Data Layer: Partitioned PostgreSQL with Redis write-through cache.",
      resumeBulletSource: {
        role: "Staff Infrastructure Engineer",
        company: "Datadog",
        bullet: "Redesigned telemetry ingestion API supporting 15M daily requests with sub-50ms p95 latency.",
      },
      source: {
        title: "Cloud Platform Architecture Round Breakdown",
        domain: "Public Interview Archive",
        url: "#",
        date: "Oct 2025",
        verificationType: "Reported by candidates",
      },
      isMustKnow: true,
    },
    {
      id: "card-6",
      question: "How do you ensure zero-downtime database schema migrations?",
      category: "technical",
      label: "Reported by candidates",
      whyTheyAsk: "They have 24/7 global users and cannot take maintenance windows for column additions or alterations.",
      answerDraft:
        "I use the Expand and Contract pattern: add new columns as nullable, deploy code that writes to both versions, backfill historical data in small batches, switch reads to the new column, and finally drop deprecated fields in a later sprint.",
      expandedAnswer:
        "Never perform destructive schema operations in a single deployment. Always separate schema changes, data backfills, and application read/write migrations into independent releases.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Executed 18 zero-downtime PostgreSQL migrations on tables with 100M+ rows using expand-contract patterns.",
      },
      source: {
        title: "Engineering Blog: How We Migrate Databases at Scale",
        domain: "engineering.internal",
        url: "https://blog.engineering.internal/zero-downtime-migrations",
        date: "Jul 2025",
        verificationType: "Reported by candidates",
      },
      isMustKnow: false,
    },
    {
      id: "card-7",
      question: "What is your philosophy on code reviews and pull request size?",
      category: "culture",
      label: "General practice",
      whyTheyAsk: "Evaluates teamwork, review latency awareness, and ability to decompose large epics into reviewable units.",
      answerDraft:
        "I aim for small, atomic pull requests under 300 lines with clear test evidence and animated GIFs for UI changes. In reviews, I focus on architectural soundness, security, and edge conditions, delegating formatting and stylistic rules to CI linters.",
      expandedAnswer:
        "Healthy teams maintain review turnaround times under 4 hours. Automated linters (ESLint, Prettier) eliminate bikeshedding, allowing human reviewers to focus on system design and business logic edge cases.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Championed trunk-based development and reduced average PR turnaround time from 28h to 3.5h across 12 engineers.",
      },
      source: {
        title: "General Tech Engineering Standards",
        domain: "stackoverflow.blog",
        url: "https://stackoverflow.blog/engineering-culture",
        date: "Aug 2025",
        verificationType: "General practice",
      },
      isMustKnow: false,
    },
    {
      id: "card-8",
      question: "How do you mentor junior and mid-level engineers in a remote setting?",
      category: "leadership",
      label: "Likely",
      whyTheyAsk: "Senior roles at Cloud Platform require lifting the productivity and technical maturity of the wider squad.",
      answerDraft:
        "I run weekly 1-on-1 pairing sessions, practice constructive PR commenting with 'why' explanations rather than demands, and assign stretch architectural components backed by collaborative design docs so they build confidence safely.",
      expandedAnswer:
        "Mentorship requires intentional asynchronous space: creating shared scratchpads, recording 2-minute Loom walkthroughs of tricky codebases, and celebrating when a mentee leads their first production launch.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Mentored 3 junior developers to mid-level promotions within 14 months through weekly pairing and RFC reviews.",
      },
      source: {
        title: "Cloud Platform Leadership Competencies",
        domain: "engineering.internal",
        url: "https://engineering.internal/careers/engineering-levels",
        date: "May 2025",
        verificationType: "Likely",
      },
      isMustKnow: false,
    },
    {
      id: "card-9",
      question: "How do you diagnose and troubleshoot production memory leaks in Node.js?",
      category: "technical",
      label: "Reported by candidates",
      whyTheyAsk: "Node microservices frequently suffer from uncollected closures, event listeners, or cache growth.",
      answerDraft:
        "I capture heap snapshots using node --inspect and compare allocation deltas across traffic spikes. In a past incident, I identified unevicted Map instances in a custom session cache, replacing it with an LRU cache with strict byte-size ceilings.",
      expandedAnswer:
        "Tools: Chrome DevTools Heap Profiler, Clinic.js Doctor, and Prometheus heap metrics. Monitor heapUsed vs heapTotal over 24-hour periods to isolate linear memory inflation.",
      resumeBulletSource: {
        role: "Staff Infrastructure Engineer",
        company: "Datadog",
        bullet: "Identified and resolved V8 memory leak in telemetry workers, decreasing server memory footprint by 55%.",
      },
      source: {
        title: "Cloud Platform Systems Debugging Round",
        domain: "Public Interview Archive",
        url: "#",
        date: "Nov 2025",
        verificationType: "Reported by candidates",
      },
      isMustKnow: false,
    },
    {
      id: "card-10",
      question: "How do you prevent SQL injection and unauthorized data access in multi-tenant environments?",
      category: "technical",
      label: "Reported by candidates",
      whyTheyAsk: "They host thousands of enterprise accounts on shared databases; data leakage between tenants is fatal.",
      answerDraft:
        "I enforce parameterized queries at all times, never concatenate strings into SQL, and implement PostgreSQL Row Level Security (RLS) with session-based tenant IDs so the database engine guarantees tenancy boundaries regardless of application layer bugs.",
      expandedAnswer:
        "Defense-in-depth: 1. Strict ORM/query builder parameterization. 2. Database RLS policies bound to authenticated JWT tenant claims. 3. Automated static analysis linters scanning for dynamic query strings.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Implemented multi-tenant isolation via Postgres RLS and hardened cryptographic token validation.",
      },
      source: {
        title: "Security & Multi-Tenancy Architecture Guidelines",
        domain: "engineering.internal",
        url: "https://engineering.internal/security/multi-tenancy",
        date: "Sep 2025",
        verificationType: "Reported by candidates",
      },
      isMustKnow: false,
    },
    {
      id: "card-11",
      question: "How do you handle scope creep when deadlines cannot be moved?",
      category: "behavioral",
      label: "Likely",
      whyTheyAsk: "Fast-moving platforms often face shifting requirements. They look for prioritization rigor.",
      answerDraft:
        "I break the deliverable into Must-Have, Nice-To-Have, and Future phases. By presenting stakeholders with clear trade-offs, we lock the MVP scope for launch and schedule remaining enhancements for the next sprint.",
      expandedAnswer:
        "Transparency is key: never silently absorb scope creep and burn out the team. Present data on sprint velocity, identify what gets dropped if new requirements are accepted, and agree on written scope boundaries.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Delivered Q3 billing redesign on schedule by negotiating phased MVP scope across 4 cross-functional teams.",
      },
      source: {
        title: "Behavioral Standard Questions at Growth Startups",
        domain: "interviewing.io",
        url: "https://interviewing.io/guides/behavioral-interviews",
        date: "Sep 2025",
        verificationType: "Likely",
      },
      isMustKnow: false,
    },
    {
      id: "card-12",
      question: "Explain your experience with GraphQL vs REST tradeoffs.",
      category: "technical",
      label: "Unverified",
      whyTheyAsk: "Cloud Platform maintains both public REST APIs and internal GraphQL federations.",
      answerDraft:
        "REST excels at HTTP-level caching, simplicity, and predictable security boundaries. GraphQL shines for complex frontends requiring multiple nested entities in one round trip. I use REST for public webhook endpoints and GraphQL for developer dashboard UI query efficiency.",
      expandedAnswer:
        "Be prepared to discuss GraphQL drawbacks: difficulty caching at CDN level, query complexity attacks (n+1 problem requiring DataLoader), and overhead for simple CRUD entities.",
      resumeBulletSource: {
        role: "Full-Stack Engineer",
        company: "Vercel Partner Agency",
        bullet: "Engineered unified GraphQL gateway consolidating 6 legacy REST microservices, reducing client roundtrips by 70%.",
      },
      source: {
        title: "Developer Community Interview Notes",
        domain: "Developer Forum Discussions",
        url: "#",
        date: "Jan 2025",
        verificationType: "Unverified",
      },
      isMustKnow: false,
    },
    {
      id: "card-13",
      question: "What monitoring metrics do you prioritize when investigating slow endpoints?",
      category: "technical",
      label: "Reported by candidates",
      whyTheyAsk: "Validates practical observability instincts (RED and USE methods).",
      answerDraft:
        "I inspect Rate, Errors, and Duration (RED method). Specifically, I analyze p95 and p99 latency distributions, database query execution times, external API network timeouts, and garbage collection pauses before inspecting application logs.",
      expandedAnswer:
        "Averages lie; always look at 95th and 99th percentiles. Use distributed tracing (OpenTelemetry) to trace single spans across microservice boundaries and pin down bottleneck services.",
      resumeBulletSource: {
        role: "Staff Infrastructure Engineer",
        company: "Datadog",
        bullet: "Deployed OpenTelemetry distributed tracing across 30 microservices, reducing MTTR for high-latency incidents by 50%.",
      },
      source: {
        title: "Candidate Debrief: Site Reliability Round",
        domain: "Candidate Community Archive",
        url: "#",
        date: "Oct 2025",
        verificationType: "Reported by candidates",
      },
      isMustKnow: false,
    },
    {
      id: "card-14",
      question: "How do you evaluate and introduce new dependencies into a production codebase?",
      category: "culture",
      label: "General practice",
      whyTheyAsk: "Ensures you do not introduce security vulnerabilities or massive dependency bloat.",
      answerDraft:
        "I audit for active maintenance, vulnerability track record (Snyk/npm audit), bundle weight, and license compatibility. If a simple native standard library or 50-line utility solves the problem, I avoid external dependencies entirely.",
      expandedAnswer:
        "Dependencies are future liabilities. Check: 1. Release frequency and open GitHub issues. 2. Zero transient dependency bloat. 3. Tree-shaking support. 4. Active corporate backing or healthy open source governance.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Audited frontend monorepo dependencies, removing 14 unmaintained packages and reducing bundle size by 240KB.",
      },
      source: {
        title: "Standard Software Engineering Hygiene",
        domain: "martinfowler.com",
        url: "https://martinfowler.com/articles",
        date: "Aug 2025",
        verificationType: "General practice",
      },
      isMustKnow: false,
    },
    {
      id: "card-15",
      question: "Where do you see yourself technically in two to three years?",
      category: "culture",
      label: "Likely",
      whyTheyAsk: "Tests career direction, learning appetite, and stability vs job-hopping expectations.",
      answerDraft:
        "I plan to continue deepening my mastery of edge cloud runtimes and distributed data consensus, stepping into a Staff Engineer role where I lead cross-team architecture and mentor senior engineers across our global organization.",
      expandedAnswer:
        "Align personal ambitions with company growth vectors. Emphasize technical influence, multiplying team output, and tackling large-scale architectural challenges.",
      resumeBulletSource: {
        role: "Senior Software Engineer",
        company: "Previous Role",
        bullet: "Served as technical design reviewer across 3 engineering squads, establishing company-wide distributed design RFC templates.",
      },
      source: {
        title: "Cloud Platform Recruiter Screen Questions",
        domain: "Public Interview Archive",
        url: "#",
        date: "Sep 2025",
        verificationType: "Likely",
      },
      isMustKnow: false,
    },
  ],
  gaps: [
    {
      id: "gap-1",
      jdRequirement: "5+ years building and deploying Go / Rust distributed systems",
      resumeStatus: "partial",
      resumeEvidence: "6 years deep TypeScript / Node.js & Python backend services; 1 year personal & open-source Rust contributions.",
      bridgeStrategy:
        "Acknowledge TypeScript expertise while emphasizing strong systems fundamentals (memory management, concurrency, thread safety) and express eagerness to leverage your Rust knowledge in production.",
    },
    {
      id: "gap-2",
      jdRequirement: "Hands-on experience with Kubernetes, Helm, and Terraform",
      resumeStatus: "matched",
      resumeEvidence: "Managed production AWS EKS clusters and automated multi-region Terraform deployments at Datadog.",
      bridgeStrategy: "Direct match. Highlight real operational examples: zero-downtime cluster upgrades and Terraform state locking.",
    },
    {
      id: "gap-3",
      jdRequirement: "Experience designing multi-tenant edge routing protocols (eBPF / Envoy)",
      resumeStatus: "gap",
      resumeEvidence: "Built edge Cloudflare Worker routing and NGINX gateways, but limited direct Envoy / eBPF kernel programming.",
      bridgeStrategy:
        "Be honest about not writing eBPF kernel hooks, while demonstrating strong grasp of L4/L7 proxy architectures and how your edge worker experience transfers cleanly.",
    },
    {
      id: "gap-4",
      jdRequirement: "Track record of authoring RFCs and driving cross-team consensus",
      resumeStatus: "matched",
      resumeEvidence: "Authored 8 accepted architectural RFCs in prior platform teams adopted across 4 platform engineering squads.",
      bridgeStrategy: "Direct match. Describe your RFC process: drafting problem statements, evaluating alternatives, and collecting async feedback.",
    },
  ],
  askThem: [
    {
      id: "ask-1",
      question: "What is currently the single largest architectural bottleneck in your edge deployment pipeline?",
      category: "Engineering culture",
      whyAskThis: "Demonstrates you think about system bottlenecks and care about developer productivity.",
      whatToListenFor: "Listen for whether they have clear observability on their build/deploy times, or if deployments are a source of team stress.",
    },
    {
      id: "ask-2",
      question: "How does the engineering team balance shipping velocity against technical debt and refactoring?",
      category: "Role expectations",
      whyAskThis: "Reveals the true dynamic between product management and engineering leadership.",
      whatToListenFor: "Look for concrete allocations (e.g. 20% maintenance time or fix-it weeks) versus vague platitudes.",
    },
    {
      id: "ask-3",
      question: "Can you walk me through the most interesting incident post-mortem your team conducted in the last quarter?",
      category: "Team dynamics",
      whyAskThis: "Tests whether their blameless culture is genuine or if individuals are blamed during crises.",
      whatToListenFor: "Check if they focus on systemic process and automated test improvements rather than individual mistakes.",
    },
    {
      id: "ask-4",
      question: "What does success look like for this specific role in the first 90 days?",
      category: "Role expectations",
      whyAskThis: "Gives you the exact rubric they will use to evaluate your onboarding performance.",
      whatToListenFor: "Clear milestones (e.g. first PR shipped in week 2, leading a minor service integration by month 2).",
    },
  ],
  quiz: [
    {
      id: "quiz-1",
      question: "In distributed edge computing, which strategy best mitigates the 'thundering herd' cache stampede problem?",
      options: [
        "Increase cache TTL to 24 hours globally",
        "Probabilistic early expiration (XFetch) or mutex locks with stale-while-revalidate",
        "Flush the cache whenever database writes occur",
        "Disable caching and route all queries directly to the primary database",
      ],
      correctIndex: 1,
      explanation:
        "Probabilistic early recomputation or distributed mutex locks allow a single background worker to refresh the expired key while serving stale cached data to other concurrent requests, avoiding database saturation.",
    },
    {
      id: "quiz-2",
      question: "When answering 'Tell me about yourself', what is the recommended framework and duration?",
      options: [
        "Start chronologically from college graduation, taking 5-7 minutes",
        "Present-Past-Future framework, strictly delivered in 90 to 120 seconds",
        "List every tool and programming language on your resume",
        "Ask the interviewer to read your resume instead",
      ],
      correctIndex: 1,
      explanation:
        "The Present-Past-Future framework keeps answers concise, authoritative, and focused on why your recent trajectory makes you the ideal hire today.",
    },
    {
      id: "quiz-3",
      question: "Why should an engineer use the expand-and-contract pattern for database migrations?",
      options: [
        "It speeds up database write IOPS by 10x",
        "It allows database changes without taking downtime or breaking active running instances",
        "It eliminates the need for database backups",
        "It reduces column storage size in PostgreSQL",
      ],
      correctIndex: 1,
      explanation:
        "Expand-and-contract decouples schema alterations from application deployments, ensuring older running pods and newer pods can both query the database simultaneously without breaking.",
    },
    {
      id: "quiz-4",
      question: "What is the primary psychological purpose when an interviewer asks about your salary expectations?",
      options: [
        "They want to see if you will work for minimum wage",
        "They are validating financial fit against their pre-approved budget before investing team interview hours",
        "It is a legal test required by state law",
        "They plan to reduce their initial budget by whatever you say",
      ],
      correctIndex: 1,
      explanation:
        "Recruiters have defined salary bands for each level. They want to ensure compensation alignment early so neither party wastes days on an unviable match.",
    },
  ],
  sources: [
    {
      title: "Cloud Platform Engineering Interview Guide & Submissions",
      domain: "Public Interview Archive",
      url: "#",
      date: "Oct 2025",
      verificationType: "Reported by candidates",
    },
    {
      title: "Candidate Debrief: Cloud Platform Recruiter Screen & Technical Rounds",
      domain: "Candidate Community Archive",
      url: "#",
      date: "Dec 2025",
      verificationType: "Reported by candidates",
    },
    {
      title: "Cloud Platform Engineering Handbook & RFC Process",
      domain: "github.com",
      url: "#",
      date: "Sep 2025",
      verificationType: "Reported by candidates",
    },
    {
      title: "Cloud Platform Multi-Region Distributed Key-Value Launch",
      domain: "techcrunch.com",
      url: "#",
      date: "Oct 2025",
      verificationType: "Reported by candidates",
    },
    {
      title: "Levels.fyi Benchmark Data: Cloud Platform Compensation",
      domain: "Public Compensation Benchmarks",
      url: "#",
      date: "Nov 2025",
      verificationType: "Reported by candidates",
    },
    {
      title: "Engineering Blog: How We Migrate Databases at Scale",
      domain: "engineering.internal",
      url: "https://blog.engineering.internal/zero-downtime-migrations",
      date: "Jul 2025",
      verificationType: "Reported by candidates",
    },
  ],
};
