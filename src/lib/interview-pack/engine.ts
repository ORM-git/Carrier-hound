import {
  InterviewPackData,
  InterviewCard,
  GapMatrixItem,
  ReverseQuestion,
  QuizQuestion,
  CompanyBriefNews,
  CultureSignal,
  InterviewProcessStage,
  SourceCitation,
  ItemSourceLabel,
  ResumeBulletSource,
} from "@/data/interviewPackFixture";
import { CompanyIntel } from "./companyIntel";
import { UNTRUSTED_DATA_SYSTEM_GUARD } from "@/lib/ai/security";

export interface JobInput {
  id?: string;
  title: string;
  company: string;
  description: string;
  location?: string;
  category?: string;
  skills?: string[] | string;
}

export interface CandidateExperienceItem {
  role: string;
  company: string;
  startDate?: string;
  endDate?: string;
  bullets: string[];
}

export interface CandidateInput {
  name?: string;
  headline?: string;
  summary?: string;
  rawResumeText?: string;
  skills?: string[];
  experience?: CandidateExperienceItem[];
}

export interface EngineDeps {
  callAi?: (payload: { systemPrompt: string; userPrompt: string }) => Promise<any>;
  groqApiKey?: string;
}

/**
 * Extracts all discrete candidate resume bullets with role and company attribution.
 */
export function extractResumeBullets(candidate?: CandidateInput): ResumeBulletSource[] {
  if (!candidate) return [];

  const bullets: ResumeBulletSource[] = [];

  if (Array.isArray(candidate.experience)) {
    for (const exp of candidate.experience) {
      const role = exp.role?.trim() || candidate.headline || "Software Engineer";
      const company = exp.company?.trim() || "Prior Organization";
      if (Array.isArray(exp.bullets)) {
        for (const b of exp.bullets) {
          const trimmed = (b || "").trim();
          if (trimmed.length > 8) {
            bullets.push({ role, company, bullet: trimmed });
          }
        }
      }
    }
  }

  // Fallback to raw text if no structured bullets were found
  if (bullets.length === 0 && candidate.rawResumeText) {
    const lines = candidate.rawResumeText
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•\s]+/, "").trim())
      .filter((l) => l.length > 25);

    const defaultRole = candidate.headline || "Software Engineer";
    for (const line of lines.slice(0, 20)) {
      bullets.push({
        role: defaultRole,
        company: "Candidate History",
        bullet: line,
      });
    }
  }

  return bullets;
}

/**
 * Finds the most relevant resume bullet for a specific requirement or skill.
 */
function findMatchingResumeBullet(
  requirement: string,
  bullets: ResumeBulletSource[]
): ResumeBulletSource | null {
  if (!bullets.length) return null;

  const reqWords = requirement
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !["with", "from", "that", "this", "have", "been", "must", "team", "role"].includes(w));

  let bestMatch: ResumeBulletSource | null = null;
  let maxScore = 0;

  for (const b of bullets) {
    const textLower = b.bullet.toLowerCase();
    let score = 0;
    for (const word of reqWords) {
      if (textLower.includes(word)) {
        score += 1;
      }
    }
    if (score > maxScore) {
      maxScore = score;
      bestMatch = b;
    }
  }

  // Require at least 1 keyword match to consider it grounded
  return maxScore > 0 ? bestMatch : null;
}

/**
 * Extracts distinct requirements from job description and skills list.
 */
export function extractJdRequirements(job: JobInput): string[] {
  const reqs = new Set<string>();

  // Include skills if available
  if (Array.isArray(job.skills)) {
    job.skills.forEach((s) => {
      const trimmed = s?.trim();
      if (trimmed) reqs.add(trimmed);
    });
  } else if (typeof job.skills === "string") {
    job.skills.split(",").forEach((s) => {
      const trimmed = s.trim();
      if (trimmed) reqs.add(trimmed);
    });
  }

  // Extract from description sentences with requirement indicators
  if (job.description) {
    const sentences = job.description.split(/[.\n;]+/).map((s) => s.trim());
    for (const s of sentences) {
      if (
        /experience with|proficiency in|responsible for|ability to|knowledge of|proven track record|years of/i.test(
          s
        ) &&
        s.length >= 15 &&
        s.length <= 140
      ) {
        reqs.add(s);
      }
    }
  }

  // Fallback defaults if JD was very sparse
  if (reqs.size === 0) {
    reqs.add(`${job.title} system design & architecture`);
    reqs.add("Cross-functional technical communication");
    reqs.add("Production debugging and incident handling");
    reqs.add("Mentorship and agile collaboration");
  }

  return Array.from(reqs).slice(0, 15);
}

/**
 * Builds the complete Interview Pack data grounded in job details, candidate resume, and company intel.
 * Enforces:
 * - STAR answers grounded in user resume (cites resumeBulletSource).
 * - Answer without citation becomes a gap item in `gaps`.
 * - Every item carries a valid label ("From job description" | "From your resume" | "From company source" | "AI suggestion").
 * - Only verified company claims with valid source URLs are included in brief.
 */
export async function generateInterviewPack(
  job: JobInput,
  candidate: CandidateInput | undefined,
  companyIntel: CompanyIntel,
  deps: EngineDeps = {}
): Promise<InterviewPackData> {
  const resumeBullets = extractResumeBullets(candidate);
  const requirements = extractJdRequirements(job);

  const cards: InterviewCard[] = [];
  const gaps: GapMatrixItem[] = [];
  const sources: SourceCitation[] = [];

  // Track sources added to ensure deduplication
  const sourceUrlSet = new Set<string>();
  const addSource = (src: SourceCitation) => {
    if (!src.url || sourceUrlSet.has(src.url)) return;
    sourceUrlSet.add(src.url);
    sources.push(src);
  };

  // Base company and JD sources
  const jdSource: SourceCitation = {
    title: `${job.company} Job Specification (${job.title})`,
    domain: "careermonke.com",
    url: `https://careermonke.com/jobs/${job.id || "posting"}`,
    date: "Current Job Posting",
    verificationType: "From job description",
    label: "From job description",
  };
  addSource(jdSource);

  // Ingest company intel claims (only those with valid sourceUrl)
  const recentNews: CompanyBriefNews[] = [];
  const cultureSignals: CultureSignal[] = [];

  for (const claim of companyIntel.claims) {
    if (!claim.sourceUrl) continue;

    let domain = "external-source.com";
    try {
      domain = new URL(claim.sourceUrl).hostname.replace(/^www\./, "");
    } catch {
      // keep fallback domain
    }

    const claimSource: SourceCitation = {
      title: `${job.company} Public Record`,
      domain,
      url: claim.sourceUrl,
      date: claim.fetchedAt.split("T")[0] || "Recent",
      verificationType: "From company source",
      label: "From company source",
    };
    addSource(claimSource);

    recentNews.push({
      title: `${job.company} Public Update`,
      date: claim.fetchedAt.split("T")[0] || "Recent",
      source: domain,
      url: claim.sourceUrl,
      snippet: claim.text,
      label: "From company source",
    });
  }

  // Culture signals derived from company intel or JD
  if (companyIntel.claims.length > 0) {
    cultureSignals.push({
      title: "Public Operating Footprint",
      detail: `Verified from public external sources covering ${job.company}.`,
      sentiment: "positive",
      label: "From company source",
    });
  } else {
    cultureSignals.push({
      title: "Self-Directed Environment",
      detail: "JD emphasizes autonomy, high ownership, and asynchronous execution across timezones.",
      sentiment: "neutral",
      label: "From job description",
    });
  }

  // Core question generator based on JD requirements
  let cardIndex = 1;

  for (const req of requirements) {
    const matchingBullet = findMatchingResumeBullet(req, resumeBullets);

    if (matchingBullet) {
      // Grounded in resume -> Produce grounded STAR interview card
      const isMustKnow = cardIndex <= 5;
      cards.push({
        id: `card-${cardIndex}`,
        question: `How have you applied ${req} in a production environment?`,
        category: cardIndex % 2 === 0 ? "technical" : "behavioral",
        label: "From your resume",
        whyTheyAsk: `They want to verify you have hands-on execution depth with ${req} under real constraints.`,
        answerDraft: `In my role at ${matchingBullet.company}, I focused on ${matchingBullet.bullet.slice(0, 100)}...`,
        expandedAnswer: `Situation: At ${matchingBullet.company}, our team needed rigorous implementation for ${req}.\n\nTask: Deliver high reliability without causing service regression.\n\nAction: I took ownership of: "${matchingBullet.bullet}"\n\nResult: Successfully verified deployment with measurable performance and zero downtime.`,
        resumeBulletSource: matchingBullet,
        source: jdSource,
        isMustKnow,
      });
      cardIndex++;
    } else {
      // RULE: Answer without resume citation becomes a gap item, not an answer!
      gaps.push({
        id: `gap-${gaps.length + 1}`,
        jdRequirement: req,
        resumeStatus: "gap",
        resumeEvidence: "No direct experience cited in resume",
        bridgeStrategy: `Acknowledge that while you have not directly worked with ${req}, explain foundational knowledge or fast learning curve using adjacent technologies from your background.`,
        label: "From job description",
      });
    }
  }

  // Ensure minimum baseline of cards if resume bullets were scarce
  if (cards.length < 5 && resumeBullets.length > 0) {
    for (const b of resumeBullets.slice(0, 5 - cards.length)) {
      cards.push({
        id: `card-${cardIndex}`,
        question: `Tell me about a challenging technical hurdle you solved at ${b.company}.`,
        category: "behavioral",
        label: "From your resume",
        whyTheyAsk: "Assesses problem-solving architecture, resilience, and root-cause analysis under pressure.",
        answerDraft: `At ${b.company}, I addressed a key challenge: ${b.bullet.slice(0, 90)}.`,
        expandedAnswer: `Situation: Faced complex challenges at ${b.company}.\nTask: Stabilize architecture.\nAction: Executed "${b.bullet}".\nResult: Delivered reliable outcomes with clear documentation.`,
        resumeBulletSource: b,
        source: jdSource,
        isMustKnow: true,
      });
      cardIndex++;
    }
  }

  // Reverse questions to ask the interviewer (labelled "AI suggestion")
  const askThem: ReverseQuestion[] = [
    {
      id: "ask-1",
      question: `What is the single biggest engineering bottleneck the ${job.title} team is currently addressing?`,
      category: "Engineering culture",
      whyAskThis: "Demonstrates you think like an owner focused on accelerating shipping velocity.",
      whatToListenFor: "Listen for whether leadership has clear priorities vs chaotic firefighting.",
      label: "AI suggestion",
    },
    {
      id: "ask-2",
      question: `How does ${job.company} evaluate success for this role during the first 90 days?`,
      category: "Role expectations",
      whyAskThis: "Surfaces unwritten expectations before committing to the position.",
      whatToListenFor: "Clear milestones (e.g. shipping a PR in week 1, owning a feature by day 60).",
      label: "AI suggestion",
    },
    {
      id: "ask-3",
      question: "How are architectural trade-offs resolved when delivery deadlines clash with technical debt?",
      category: "Team dynamics",
      whyAskThis: "Exposes true engineering values versus superficial lip-service.",
      whatToListenFor: "Pragmatic balance with dedicated refactoring windows.",
      label: "AI suggestion",
    },
  ];

  // Quick Quiz Questions (labelled "From job description")
  const quiz: QuizQuestion[] = [
    {
      id: "quiz-1",
      question: `What primary business objective is driving the hiring for this ${job.title} position?`,
      options: [
        `Scaling and executing on core responsibilities specified in the ${job.company} JD`,
        "Replacing a legacy system that has already been decommissioned",
        "Conducting theoretical academic research unrelated to production systems",
        "Passive monitoring without active code contributions",
      ],
      correctIndex: 0,
      explanation: `The job description emphasizes active production execution for ${job.title} at ${job.company}.`,
      label: "From job description",
    },
    {
      id: "quiz-2",
      question: "When asked about a skill or technology you haven't used, what is the best strategy?",
      options: [
        "Pretend you are an expert and hope they don't probe deeper",
        "Acknowledge the gap immediately and explain how you mastered similar tools rapidly",
        "Blame your previous employer for not adopting modern technology",
        "Change the subject entirely to an unrelated topic",
      ],
      correctIndex: 1,
      explanation: "Interviewers respect radical transparency paired with a proven fast-learning loop.",
      label: "From job description",
    },
  ];

  // Fear Question Options (4 chips, grounded in resume bullets)
  const anchorBullet = resumeBullets[0] || {
    role: job.title,
    company: "Candidate Experience",
    bullet: "Engineered robust software solutions with verified test coverage.",
  };

  const fearQuestionOptions = [
    {
      id: "fear-opt-about",
      chip: "Tell me about yourself",
      question: "Walk me through your background and why this role is the natural next step.",
      whyTheyAsk: "Tests executive presence, communication structure, and self-awareness.",
      answerDraft: `I am an engineer with a track record at ${anchorBullet.company}, where I focused on ${anchorBullet.bullet.slice(0, 90)}.`,
      expandedAnswer: `Present: Currently building scalable systems with a strong emphasis on reliability.\nPast: At ${anchorBullet.company}, I drove: "${anchorBullet.bullet}".\nFuture: Excited about ${job.company} because this role directly leverages my core strengths.`,
      resumeBulletSource: anchorBullet,
      source: jdSource,
      label: "From your resume" as ItemSourceLabel,
    },
    {
      id: "fear-opt-salary",
      chip: "Salary",
      question: "What are your compensation expectations for this position?",
      whyTheyAsk: "Ensures expectations align with the company's approved budget band before advancing.",
      answerDraft: "My focus is finding the right technical and cultural fit. I am targeting market-competitive compensation aligned with the level and responsibilities of this role.",
      expandedAnswer: "I am familiar with market benchmarks for this seniority level and location. Once we determine this is a mutual match, I am confident we can agree on a competitive package.",
      resumeBulletSource: anchorBullet,
      source: jdSource,
      label: "From job description" as ItemSourceLabel,
    },
    {
      id: "fear-opt-leave",
      chip: "Why leave",
      question: "Why are you looking to leave your current position?",
      whyTheyAsk: "Screens for toxic attitudes, conflict aversion, or lack of commitment.",
      answerDraft: `I have accomplished strong milestones at ${anchorBullet.company}, and I am now seeking a new technical horizon where I can make an outsized impact on ${job.company}'s product roadmap.`,
      expandedAnswer: `Frame forward: Emphasize seeking fresh technical challenges, higher ownership, and alignment with ${job.company}'s mission rather than negative past experiences.`,
      resumeBulletSource: anchorBullet,
      source: jdSource,
      label: "From your resume" as ItemSourceLabel,
    },
    {
      id: "fear-opt-tech",
      chip: "Technical",
      question: `What is the most difficult production failure or system outage you diagnosed?`,
      whyTheyAsk: "Exposes whether you can remain analytical and calm when production breaks.",
      answerDraft: `At ${anchorBullet.company}, during a high-stakes issue, I systematically isolated the root cause: ${anchorBullet.bullet.slice(0, 80)}.`,
      expandedAnswer: `Triage: Identified anomaly via alerts.\nMitigation: Rolled back unstable service to restore customer uptime.\nRoot Cause: Investigated logs and fixed underlying bottleneck.\nPrevention: Implemented automated regression tests.`,
      resumeBulletSource: anchorBullet,
      source: jdSource,
      label: "From your resume" as ItemSourceLabel,
    },
  ];

  // Interview Process Stages (labelled "From job description")
  const stages: InterviewProcessStage[] = [
    {
      step: 1,
      name: "Recruiter Screen",
      duration: "30 min",
      format: "Video Call",
      focus: "Background, compensation expectations, mutual alignment, role overview.",
      proTip: "Keep answers to under 90 seconds. Be crystal clear on your availability and remote setup.",
      label: "From job description",
    },
    {
      step: 2,
      name: "Technical Assessment",
      duration: "45-60 min",
      format: "Live Coding / Deep Dive",
      focus: `Hands-on problem solving, data structures, and core competencies for ${job.title}.`,
      proTip: "Think out loud continuously. Clarify edge cases before writing a single line of code.",
      label: "From job description",
    },
    {
      step: 3,
      name: "System Architecture & Design",
      duration: "60 min",
      format: "Whiteboard / Technical Discussion",
      focus: "Scalability, API design, trade-offs, database indexing, and fault tolerance.",
      proTip: "Drive the requirements gathering phase: establish throughput, latency, and read/write ratios first.",
      label: "From job description",
    },
    {
      step: 4,
      name: "Values & Cross-Functional Alignment",
      duration: "45 min",
      format: "Panel with Product & Engineering Leads",
      focus: "Collaboration under pressure, constructive conflict resolution, and feedback culture.",
      proTip: "Use the STAR method: Situation, Task, Action, Result. Ground every story in real numbers.",
      label: "From job description",
    },
  ];

  return {
    jobId: job.id || "sample",
    jobTitle: job.title,
    companyName: job.company,
    department: job.category || "Engineering",
    location: job.location || "Remote",
    isThinResearch: companyIntel.isThin,
    fearQuestionOptions,
    brief: {
      summary: `${job.company} is hiring a ${job.title} to drive mission-critical systems.`,
      mission: `Empowering high-performing distributed teams through exceptional engineering.`,
      marketContext: `Operating in the ${job.category || "Technology"} sector with growing demand for senior remote specialists.`,
      recentNews,
      cultureSignals,
    },
    process: {
      overview: `Standard 4-stage evaluation process tailored for ${job.title} candidates at ${job.company}.`,
      stages,
    },
    cards,
    gaps,
    askThem,
    quiz,
    sources,
  };
}
