"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, RefreshCw, AlertTriangle, Building2, Sparkles } from "lucide-react";
import type { InterviewPackData, InterviewCard } from "@/data/interviewPackFixture";
import FearQuestionScreen from "./FearQuestionScreen";
import TimeBoxScreen, { TimeBoxOption } from "./TimeBoxScreen";
import DossierRail, { DossierSection } from "./DossierRail";
import MobileProgressStrip from "./MobileProgressStrip";
import QuestionsCardDeck from "./QuestionsCardDeck";
import BriefSection from "./BriefSection";
import ProcessSection from "./ProcessSection";
import YourAnswersSection from "./YourAnswersSection";
import GapsSection from "./GapsSection";
import AskThemSection from "./AskThemSection";
import QuickQuizSection from "./QuickQuizSection";
import LastNightModeView from "./LastNightModeView";
import ThinResearchBanner from "./ThinResearchBanner";
import SourcesDrawer from "./SourcesDrawer";
import DossierFooter from "./DossierFooter";

interface InterviewPackViewProps {
  pack: InterviewPackData | null;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  jobId?: string;
}

type FlowStep = "fear" | "timebox" | "dossier";

export default function InterviewPackView({
  pack,
  loading,
  error,
  onRetry,
  jobId,
}: InterviewPackViewProps) {
  const router = useRouter();

  const [step, setStep] = useState<FlowStep>("fear");
  const [fearCustomQuestion, setFearCustomQuestion] = useState<string | null>(null);
  const [fearOptionId, setFearOptionId] = useState<string | null>(null);
  const [timeBox, setTimeBox] = useState<TimeBoxOption>("30min");
  const [cardLimit, setCardLimit] = useState<number>(10);
  const [activeSection, setActiveSection] = useState<DossierSection>("questions");
  const [isLastNightMode, setIsLastNightMode] = useState<boolean>(false);
  const [isSourcesDrawerOpen, setIsSourcesDrawerOpen] = useState<boolean>(false);

  // Derive adjusted card deck:
  // 1. If fear question was set, inject it at position 0!
  // 2. Trim cards according to timeBox cardLimit (5, 10, or 15).
  const trimmedCards = useMemo(() => {
    if (!pack) return [];
    let baseCards = [...pack.cards];

    if (fearCustomQuestion || fearOptionId) {
      const fearOpt = pack.fearQuestionOptions.find((o) => o.id === fearOptionId);
      const fearCard: InterviewCard = {
        id: "card-fear-target",
        question: fearCustomQuestion || fearOpt?.question || "Targeted Area of Concern",
        category: "fear",
        label: fearOpt?.source.verificationType || "Reported by candidates",
        whyTheyAsk: fearOpt?.whyTheyAsk || "They want to evaluate composure, executive clarity, and self-awareness under pressure.",
        answerDraft: fearOpt?.answerDraft || "I ground my answer in verifiable outcomes from my previous roles, focusing on systemic improvements, measurable impact, and accountability.",
        expandedAnswer: fearOpt?.expandedAnswer || "Detailed structured STAR response framework.",
        resumeBulletSource: fearOpt?.resumeBulletSource || {
          role: "Senior Engineer",
          company: "Verified Role",
          bullet: "Demonstrated direct project delivery and cross-functional team alignment.",
        },
        source: fearOpt?.source || {
          title: "Candidate Debrief Synthesis",
          domain: "careermonke.com",
          url: "https://careermonke.com",
          date: "Oct 2025",
          verificationType: "Reported by candidates",
        },
        isMustKnow: true,
      };

      // Place fear card as card #1
      baseCards = [fearCard, ...baseCards.filter((c) => c.question !== fearCard.question)];
    }

    return baseCards.slice(0, cardLimit);
  }, [pack, fearCustomQuestion, fearOptionId, cardLimit]);

  // Loading State
  if (loading) {
    return (
      <div className="min-h-[70vh] flex flex-col items-center justify-center p-6 space-y-4">
        <div className="w-12 h-12 rounded-full border-4 border-[#2563EB] border-t-transparent animate-spin" />
        <div className="text-center space-y-1">
          <h3 className="text-lg font-bold text-[#0F172A]">Assembling Interview Pack...</h3>
          <p className="text-xs text-[#64748B]">
            Synthesizing public Glassdoor, Blind, and engineering handbook records.
          </p>
        </div>
      </div>
    );
  }

  // Error State
  if (error || !pack) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-rose-50 border border-rose-200 text-rose-600 flex items-center justify-center">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-bold text-[#0F172A]">Failed to Load Interview Pack</h3>
          <p className="text-xs text-[#64748B]">
            {error || "We could not retrieve interview dossier records for this role."}
          </p>
        </div>
        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => router.back()}
            className="px-4 py-2 rounded-xl border border-[#CBD5E1] text-xs font-bold text-[#334155] hover:bg-slate-50 transition cursor-pointer"
          >
            Go Back
          </button>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="px-4 py-2 rounded-xl bg-[#2563EB] text-white text-xs font-bold hover:bg-[#1D4ED8] transition cursor-pointer flex items-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  // Step 1: Fear Question Screen
  if (step === "fear") {
    return (
      <FearQuestionScreen
        pack={pack}
        onComplete={(customQ, optionId) => {
          if (customQ) setFearCustomQuestion(customQ);
          if (optionId) setFearOptionId(optionId);
          setStep("timebox");
        }}
        onSkip={() => {
          setStep("timebox");
        }}
      />
    );
  }

  // Step 2: Time Box Screen
  if (step === "timebox") {
    return (
      <TimeBoxScreen
        initialOption={timeBox}
        onSelect={(opt, limit) => {
          setTimeBox(opt);
          setCardLimit(limit);
          setStep("dossier");
        }}
        onBack={() => setStep("fear")}
      />
    );
  }

  // Step 3: Main Dossier View
  return (
    <div className="w-full">
      {/* Mobile progress & section bar */}
      <MobileProgressStrip
        activeSection={activeSection}
        onSelectSection={(sec) => setActiveSection(sec)}
        isLastNightMode={isLastNightMode}
        onToggleLastNightMode={() => setIsLastNightMode(!isLastNightMode)}
        onOpenSources={() => setIsSourcesDrawerOpen(true)}
        totalCards={trimmedCards.length}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Top Header Bar */}
        <div className="flex items-center justify-between gap-4 pb-6 border-b border-[#E2E8F0] mb-6 flex-wrap">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => router.push(jobId ? `/jobs?selectedJobId=${jobId}` : "/jobs")}
              className="p-2 rounded-xl border border-[#CBD5E1] text-[#475569] hover:text-[#0F172A] hover:bg-slate-100 transition cursor-pointer"
              aria-label="Back to jobs"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-[#2563EB] uppercase tracking-wider">
                  Verified Preparation Pack
                </span>
                <span className="text-slate-300">•</span>
                <span className="text-xs font-semibold text-[#64748B]">
                  {timeBox === "10min" ? "10-Min Fast Track" : timeBox === "30min" ? "30-Min Focused Prep" : "Complete Evening Dossier"}
                </span>
              </div>
              <h1 className="text-xl sm:text-2xl font-extrabold text-[#0F172A] leading-tight">
                {pack.jobTitle} @ {pack.companyName}
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsSourcesDrawerOpen(true)}
              className="px-3.5 py-1.5 rounded-xl border border-[#CBD5E1] bg-white hover:bg-slate-50 text-xs font-bold text-[#334155] transition cursor-pointer shadow-2xs"
            >
              Public Sources ({pack.sources.length})
            </button>
          </div>
        </div>

        {/* Thin Research Banner (shown when evidence is general-practice only) */}
        <ThinResearchBanner
          isThinResearch={pack.isThinResearch}
          onOpenSources={() => setIsSourcesDrawerOpen(true)}
        />

        {/* Main Two-Column Layout (Desktop sticky rail + Content area) */}
        <div className="flex flex-col lg:flex-row gap-8 items-start">
          {/* Sticky Left Rail (Desktop) */}
          <div className="hidden lg:block">
            <DossierRail
              activeSection={activeSection}
              onSelectSection={(sec) => setActiveSection(sec)}
              isLastNightMode={isLastNightMode}
              onToggleLastNightMode={() => setIsLastNightMode(!isLastNightMode)}
              onOpenSources={() => setIsSourcesDrawerOpen(true)}
              sourcesCount={pack.sources.length}
              companyName={pack.companyName}
              onBackToJobs={() => router.push(jobId ? `/jobs?selectedJobId=${jobId}` : "/jobs")}
            />
          </div>

          {/* Center Content Section */}
          <main className="flex-1 min-w-0 w-full" role="region" aria-label="Dossier content">
            {isLastNightMode ? (
              <LastNightModeView
                cards={trimmedCards}
                onSelectSection={(sec) => {
                  setIsLastNightMode(false);
                  setActiveSection(sec as DossierSection);
                }}
              />
            ) : (
              <>
                {activeSection === "brief" && (
                  <BriefSection brief={pack.brief} companyName={pack.companyName} />
                )}

                {activeSection === "process" && (
                  <ProcessSection processData={pack.process} companyName={pack.companyName} />
                )}

                {activeSection === "questions" && (
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#2563EB]">
                        <Sparkles className="w-4 h-4" />
                        <span>Interactive Preparation Cards</span>
                      </div>
                      <h2 className="text-2xl sm:text-3xl font-extrabold text-[#0F172A] tracking-tight">
                        Predicted Question Cards for {pack.companyName}
                      </h2>
                      <p className="text-[15px] sm:text-[16px] text-[#475569] leading-relaxed">
                        Step through one card at a time. Review the underlying psychological motive, practice your concise draft, and mark cards ready as you go.
                      </p>
                    </div>

                    <QuestionsCardDeck
                      cards={trimmedCards}
                      onSelectSection={(sec) => setActiveSection(sec as DossierSection)}
                    />
                  </div>
                )}

                {activeSection === "answers" && (
                  <YourAnswersSection cards={trimmedCards} />
                )}

                {activeSection === "gaps" && (
                  <GapsSection gaps={pack.gaps} />
                )}

                {activeSection === "askThem" && (
                  <AskThemSection questions={pack.askThem} />
                )}

                {activeSection === "quiz" && (
                  <QuickQuizSection quiz={pack.quiz} />
                )}
              </>
            )}

            {/* Persistent Compliance Footer */}
            <DossierFooter />
          </main>
        </div>
      </div>

      {/* Slide-over Sources Directory Drawer */}
      <SourcesDrawer
        open={isSourcesDrawerOpen}
        onClose={() => setIsSourcesDrawerOpen(false)}
        sources={pack.sources}
      />
    </div>
  );
}
