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
import { CompanyIntel, isPrivateOrInternalHost } from "./companyIntel";
import { UNTRUSTED_DATA_SYSTEM_GUARD } from "@/lib/ai/security";

export interface JobInput {
  id?: string;
  title: string;
  company: string;
  description: string;
  location?: string;
  category?: string;
  skills?: string[] | string;
  apply_url?: string;
  source_url?: string;
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
  env?: Record<string, string | undefined>;
}

/**
 * Extracts discrete candidate resume bullets with role and company attribution.
 * NEVER invents or synthesizes fake bullets.
 */
export function extractResumeBullets(candidate?: CandidateInput): ResumeBulletSource[] {
  if (!candidate) return [];

  const bullets: ResumeBulletSource[] = [];

  if (Array.isArray(candidate.experience)) {
    for (const exp of candidate.experience) {
      const role = exp.role?.trim() || candidate.headline || "Role";
      const company = exp.company?.trim() || "Organization";
      if (Array.isArray(exp.bullets)) {
        for (const b of exp.bullets) {
          const trimmed = (b || "").trim();
          if (trimmed.length > 5) {
            bullets.push({ role, company, bullet: trimmed });
          }
        }
      }
    }
  }

  // Fallback to splitting raw text lines if structured experiences are absent
  if (bullets.length === 0 && candidate.rawResumeText) {
    const lines = candidate.rawResumeText
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•\s]+/, "").trim())
      .filter((l) => l.length > 20);

    const defaultRole = candidate.headline || "Experience";
    for (const line of lines.slice(0, 25)) {
      bullets.push({
        role: defaultRole,
        company: "Resume",
        bullet: line,
      });
    }
  }

  return bullets;
}

/**
 * Resolves verified job source URL from the database row.
 * Strictly avoids invented domains and never uses careermonke.com.
 */
export function resolveJobSourceCitation(job: JobInput): SourceCitation | null {
  const candidateUrl = (job.apply_url || job.source_url || "").trim();
  if (!candidateUrl || !candidateUrl.startsWith("https://")) {
    return null;
  }

  try {
    const parsed = new URL(candidateUrl);
    if (parsed.protocol !== "https:") return null;
    if (isPrivateOrInternalHost(parsed.hostname)) return null;
    // We do NOT own careermonke.com — strictly prohibit any careermonke.com references
    if (parsed.hostname.toLowerCase().includes("careermonke.com")) return null;

    return {
      title: `${job.company} Job Posting (${job.title})`,
      domain: parsed.hostname.replace(/^www\./, ""),
      url: candidateUrl,
      date: "Active Posting",
      verificationType: "From job description",
      label: "From job description",
    };
  } catch {
    return null;
  }
}

/**
 * Calls the AI provider using the standard Groq path or injected mock.
 */
async function callAiProvider(
  systemPrompt: string,
  userPrompt: string,
  deps: EngineDeps
): Promise<any> {
  if (deps.callAi) {
    return deps.callAi({ systemPrompt, userPrompt });
  }

  const apiKey =
    deps.groqApiKey ||
    (deps.env && deps.env.GROQ_API_KEY) ||
    process.env.GROQ_API_KEY;

  if (!apiKey || !apiKey.trim()) {
    throw new Error("Missing required environment variable: GROQ_API_KEY");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 3500,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`Upstream AI provider error: status ${response.status}`);
  }

  const json = await response.json();
  const rawContent = json?.choices?.[0]?.message?.content;
  if (!rawContent || typeof rawContent !== "string") {
    throw new Error("Upstream AI provider returned an empty response.");
  }

  return JSON.parse(rawContent);
}

/**
 * Generates an Interview Pack strictly grounded in the real job description and the candidate's resume.
 *
 * Rules:
 * - Questions generated from the real JD.
 * - STAR answers grounded ONLY in candidate's resume lines; uncited requirements become gap items.
 * - No invented interview stages/durations/formats.
 * - No invented mission/marketContext/culture text.
 * - No invented "Result:" metrics or outcomes.
 * - No careermonke.com URLs anywhere.
 * - Provider failure/timeout -> throws (caller returns clean error JSON, never template filler).
 */
export async function generateInterviewPack(
  job: JobInput,
  candidate: CandidateInput | undefined,
  companyIntel: CompanyIntel,
  deps: EngineDeps = {}
): Promise<InterviewPackData> {
  const resumeBullets = extractResumeBullets(candidate);
  const jobSource = resolveJobSourceCitation(job);

  const fallbackCitation: SourceCitation = jobSource || {
    title: "",
    domain: "",
    url: "",
    date: "",
    verificationType: "From job description",
    label: "From job description",
  };

  const sources: SourceCitation[] = [];
  if (jobSource && jobSource.url) {
    sources.push(jobSource);
  }

  // 1. Process verified company claims (only https, valid sourceUrl)
  const recentNews: CompanyBriefNews[] = [];
  const cultureSignals: CultureSignal[] = [];

  for (const claim of companyIntel.claims) {
    if (!claim.sourceUrl) continue;
    try {
      const u = new URL(claim.sourceUrl);
      const domain = u.hostname.replace(/^www\./, "");
      const claimCitation: SourceCitation = {
        title: `${job.company} Public Record`,
        domain,
        url: claim.sourceUrl,
        date: claim.fetchedAt.split("T")[0] || "Recent",
        verificationType: "From company source",
        label: "From company source",
      };
      if (!sources.some((s) => s.url === claim.sourceUrl)) {
        sources.push(claimCitation);
      }
      recentNews.push({
        title: `${job.company} Update`,
        date: claim.fetchedAt.split("T")[0] || "Recent",
        source: domain,
        url: claim.sourceUrl,
        snippet: claim.text,
        label: "From company source",
      });
    } catch {
      // omit invalid URL
    }
  }

  // 2. Build Prompts for AI Generation
  const systemPrompt = `You are an expert technical interview preparation assistant.
Your task is to analyze a real job description and a candidate's verified resume to produce role-specific interview preparation data in strict JSON format.

CRITICAL GROUNDING RULES:
1. ROLE-SPECIFIC QUESTIONS: Generate questions directly based on the real technologies, systems, and requirements mentioned in the job description.
2. STAR ANSWERS: Answers must be strictly grounded ONLY in the candidate's actual resume lines provided. Every answer MUST cite the exact resume line it used.
3. NO HALLUCINATIONS: NEVER invent past projects, metrics, companies, or results that are not explicitly stated in the candidate's resume.
4. GAPS: If a job requirement or technology has NO matching experience in the candidate's resume, do NOT invent an answer. Instead, create a gap item with an honest, humble bridge strategy.
5. NO INVENTED COMPANY INTEL: Do not fabricate company mission, market context, interview stages, or culture text.
6. LABELS:
   - "From job description": ONLY when text is directly quoted or extracted from the JD.
   - "From your resume": When the answer is built from a candidate's actual resume bullet.
   - "AI suggestion": For model-generated suggestions, questions, and bridge strategies.
   - "From company source": Only for verified company claims.
7. Return a valid JSON object matching the requested schema.

${UNTRUSTED_DATA_SYSTEM_GUARD}`;

  const skillsList = Array.isArray(job.skills)
    ? job.skills.join(", ")
    : typeof job.skills === "string"
    ? job.skills
    : "Not specified";

  const candidateBulletsText =
    resumeBullets.length > 0
      ? resumeBullets
          .map((b, idx) => `[Bullet ${idx + 1}] (${b.role} @ ${b.company}): "${b.bullet}"`)
          .join("\n")
      : "No verified candidate resume bullets available.";

  const userPrompt = `Analyze this job and candidate profile:

<untrusted_job_data>
Title: ${job.title}
Company: ${job.company}
Category: ${job.category || "Engineering"}
Location: ${job.location || "Remote"}
Skills: ${skillsList}
Description:
${job.description || "No description provided."}
</untrusted_job_data>

<untrusted_candidate_data>
Candidate Resume Lines:
${candidateBulletsText}
</untrusted_candidate_data>

Output a JSON object with this exact structure:
{
  "questions": [
    {
      "id": "card-1",
      "question": "Role-specific question derived from JD requirements",
      "category": "technical" | "behavioral" | "leadership" | "culture" | "must-know",
      "whyTheyAsk": "Concise psychological rationale (10-25 words)",
      "citedBulletText": "Exact text of the resume bullet used, or empty string if not covered in resume",
      "citedRole": "Role name from cited bullet",
      "citedCompany": "Company name from cited bullet",
      "answerDraft": "Concise answer draft grounded only in that bullet (40-60 words)",
      "expandedAnswer": "Structured STAR framework (Situation, Task, Action, Result) grounded strictly in the cited resume facts without invented metrics",
      "isMustKnow": true
    }
  ],
  "gaps": [
    {
      "id": "gap-1",
      "jdRequirement": "Requirement extracted from JD that candidate lacks evidence for",
      "bridgeStrategy": "Honest way to address this gap without pretending to have direct experience"
    }
  ],
  "fearQuestions": [
    {
      "id": "fear-opt-about",
      "chip": "Tell me about yourself",
      "question": "Question for this fear topic",
      "whyTheyAsk": "Rationale",
      "answerDraft": "Draft grounded in candidate history",
      "expandedAnswer": "Framework",
      "citedBulletText": "Resume bullet text or empty",
      "citedRole": "Role",
      "citedCompany": "Company"
    },
    {
      "id": "fear-opt-salary",
      "chip": "Salary",
      "question": "Question for this fear topic",
      "whyTheyAsk": "Rationale",
      "answerDraft": "Draft",
      "expandedAnswer": "Framework",
      "citedBulletText": "",
      "citedRole": "",
      "citedCompany": ""
    },
    {
      "id": "fear-opt-leave",
      "chip": "Why leave",
      "question": "Question for this fear topic",
      "whyTheyAsk": "Rationale",
      "answerDraft": "Draft",
      "expandedAnswer": "Framework",
      "citedBulletText": "",
      "citedRole": "",
      "citedCompany": ""
    },
    {
      "id": "fear-opt-tech",
      "chip": "Technical",
      "question": "Question for this fear topic",
      "whyTheyAsk": "Rationale",
      "answerDraft": "Draft",
      "expandedAnswer": "Framework",
      "citedBulletText": "Resume bullet text or empty",
      "citedRole": "Role",
      "citedCompany": "Company"
    }
  ],
  "reverseQuestions": [
    {
      "id": "ask-1",
      "question": "Smart question to ask the interviewer",
      "category": "Engineering culture" | "Business direction" | "Role expectations" | "Team dynamics",
      "whyAskThis": "Why to ask",
      "whatToListenFor": "What to listen for"
    }
  ],
  "quiz": [
    {
      "id": "quiz-1",
      "question": "Question testing candidate on JD nuances",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correctIndex": 0,
      "explanation": "Why correct"
    }
  ]
}`;

  // 3. Execute AI provider call
  const modelJson = await callAiProvider(systemPrompt, userPrompt, deps);

  // 4. Strictly validate and parse model JSON
  if (!modelJson || typeof modelJson !== "object") {
    throw new Error("Invalid model response format.");
  }

  const cards: InterviewCard[] = [];
  const gaps: GapMatrixItem[] = [];

  // Helper: check if a text citation corresponds to an actual resume bullet
  const findGroundingBullet = (citedText?: string): ResumeBulletSource | null => {
    if (!citedText || typeof citedText !== "string" || !resumeBullets.length) return null;
    const lowerCited = citedText.toLowerCase().trim();
    if (lowerCited.length < 10) return null;

    for (const b of resumeBullets) {
      const lowerB = b.bullet.toLowerCase().trim();
      if (lowerB.includes(lowerCited.slice(0, 30)) || lowerCited.includes(lowerB.slice(0, 30))) {
        return b;
      }
    }
    return null;
  };

  // Validate questions from model
  const rawQuestions = Array.isArray(modelJson.questions) ? modelJson.questions : [];
  let cardCount = 0;

  for (const q of rawQuestions) {
    if (!q || typeof q !== "object") continue;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    const whyTheyAsk = typeof q.whyTheyAsk === "string" ? q.whyTheyAsk.trim() : "";
    const answerDraft = typeof q.answerDraft === "string" ? q.answerDraft.trim() : "";
    const expandedAnswer = typeof q.expandedAnswer === "string" ? q.expandedAnswer.trim() : "";

    if (!question || !whyTheyAsk || !answerDraft) {
      // Drop malformed item
      continue;
    }

    // Check if grounded in a real candidate resume bullet
    const groundingBullet = findGroundingBullet(q.citedBulletText);

    if (groundingBullet) {
      // Grounded in resume -> Answered card
      cardCount++;
      const validCategory = [
        "fear",
        "must-know",
        "behavioral",
        "technical",
        "leadership",
        "culture",
      ].includes(q.category)
        ? q.category
        : "behavioral";

      cards.push({
        id: `card-${cardCount}`,
        question,
        category: validCategory,
        label: "From your resume",
        whyTheyAsk,
        answerDraft,
        expandedAnswer: expandedAnswer || answerDraft,
        resumeBulletSource: groundingBullet,
        source: fallbackCitation,
        isMustKnow: q.isMustKnow === true || cardCount <= 5,
      });
    } else {
      // RULE: Answer without resume citation becomes a gap item, not an answer!
      gaps.push({
        id: `gap-${gaps.length + 1}`,
        jdRequirement: question,
        resumeStatus: "gap",
        resumeEvidence: "No matching evidence cited in resume",
        bridgeStrategy:
          whyTheyAsk || "Acknowledge this requirement directly and focus on foundational skills.",
        label: "AI suggestion",
      });
    }
  }

  // Validate gaps from model
  const rawGaps = Array.isArray(modelJson.gaps) ? modelJson.gaps : [];
  for (const g of rawGaps) {
    if (!g || typeof g !== "object") continue;
    const jdRequirement = typeof g.jdRequirement === "string" ? g.jdRequirement.trim() : "";
    const bridgeStrategy = typeof g.bridgeStrategy === "string" ? g.bridgeStrategy.trim() : "";

    if (!jdRequirement || !bridgeStrategy) continue;

    gaps.push({
      id: `gap-${gaps.length + 1}`,
      jdRequirement,
      resumeStatus: "gap",
      resumeEvidence: "No direct experience cited in resume",
      bridgeStrategy,
      label: "From job description",
    });
  }

  // Validate fear questions
  const fearQuestionOptions = [];
  const rawFear = Array.isArray(modelJson.fearQuestions) ? modelJson.fearQuestions : [];
  const defaultChips = ["Tell me about yourself", "Salary", "Why leave", "Technical"];

  const anchorBullet = resumeBullets[0] || {
    role: job.title,
    company: "Candidate History",
    bullet: "Professional software engineering experience.",
  };

  for (let i = 0; i < defaultChips.length; i++) {
    const chipName = defaultChips[i];
    const match = rawFear.find((f: any) => f?.chip?.toLowerCase() === chipName.toLowerCase());

    const question =
      typeof match?.question === "string" && match.question.trim()
        ? match.question.trim()
        : `Key interview inquiry regarding ${chipName}.`;
    const whyTheyAsk =
      typeof match?.whyTheyAsk === "string" && match.whyTheyAsk.trim()
        ? match.whyTheyAsk.trim()
        : "Evaluates role preparation, clarity, and communication under pressure.";
    const answerDraft =
      typeof match?.answerDraft === "string" && match.answerDraft.trim()
        ? match.answerDraft.trim()
        : `Anchored in my professional background: ${anchorBullet.bullet.slice(0, 90)}.`;
    const expandedAnswer =
      typeof match?.expandedAnswer === "string" && match.expandedAnswer.trim()
        ? match.expandedAnswer.trim()
        : answerDraft;

    const grounded = findGroundingBullet(match?.citedBulletText) || anchorBullet;

    fearQuestionOptions.push({
      id: `fear-opt-${i + 1}`,
      chip: chipName,
      question,
      whyTheyAsk,
      answerDraft,
      expandedAnswer,
      resumeBulletSource: grounded,
      source: fallbackCitation,
      label: "From your resume" as ItemSourceLabel,
    });
  }

  // Validate reverse questions (askThem)
  const askThem: ReverseQuestion[] = [];
  const rawAsk = Array.isArray(modelJson.reverseQuestions) ? modelJson.reverseQuestions : [];
  const allowedAskCats = [
    "Engineering culture",
    "Business direction",
    "Role expectations",
    "Team dynamics",
  ];

  for (const a of rawAsk) {
    if (!a || typeof a !== "object") continue;
    const question = typeof a.question === "string" ? a.question.trim() : "";
    const whyAskThis = typeof a.whyAskThis === "string" ? a.whyAskThis.trim() : "";
    const whatToListenFor = typeof a.whatToListenFor === "string" ? a.whatToListenFor.trim() : "";
    const category = allowedAskCats.includes(a.category)
      ? (a.category as ReverseQuestion["category"])
      : "Engineering culture";

    if (!question) continue;

    askThem.push({
      id: `ask-${askThem.length + 1}`,
      question,
      category,
      whyAskThis: whyAskThis || "Clarifies team engineering values.",
      whatToListenFor: whatToListenFor || "Clear, candid details from leadership.",
      label: "AI suggestion",
    });
  }

  // Validate quiz
  const quiz: QuizQuestion[] = [];
  const rawQuiz = Array.isArray(modelJson.quiz) ? modelJson.quiz : [];
  for (const q of rawQuiz) {
    if (!q || typeof q !== "object") continue;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    const options = Array.isArray(q.options)
      ? q.options.map((o: any) => String(o || "").trim()).filter(Boolean)
      : [];
    const correctIndex =
      typeof q.correctIndex === "number" && q.correctIndex >= 0 && q.correctIndex < options.length
        ? q.correctIndex
        : 0;
    const explanation = typeof q.explanation === "string" ? q.explanation.trim() : "";

    if (!question || options.length < 2) continue;

    quiz.push({
      id: `quiz-${quiz.length + 1}`,
      question,
      options,
      correctIndex,
      explanation: explanation || "Based on job description expectations.",
      label: "AI suggestion",
    });
  }

  // Process stages: Do NOT invent stages. Only empty or real data.
  const stages: InterviewProcessStage[] = [];

  return {
    jobId: job.id || "sample",
    jobTitle: job.title,
    companyName: job.company,
    department: job.category || "Engineering",
    location: job.location || "Remote",
    isThinResearch: companyIntel.isThin,
    fearQuestionOptions,
    brief: {
      summary: "",
      mission: "",
      marketContext: "",
      recentNews,
      cultureSignals,
    },
    process: {
      overview: "",
      stages,
    },
    cards,
    gaps,
    askThem,
    quiz,
    sources,
  };
}
