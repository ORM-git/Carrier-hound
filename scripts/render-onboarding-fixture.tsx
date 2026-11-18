// @ts-ignore
if (typeof window !== "undefined") {
  (window as any).process = {
    env: {
      NODE_ENV: "production",
      NEXT_PUBLIC_ONBOARDING_STEP2_ENABLED: "true",
      NEXT_PUBLIC_ONBOARDING_FLOW_ENABLED: "true",
    },
  };
}

import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import OnboardingStep1 from "../src/components/onboarding/OnboardingStep1";
import OnboardingStep2 from "../src/components/onboarding/OnboardingStep2";
import JobFunctionBottomSheet from "../src/components/onboarding/JobFunctionBottomSheet";
import OnboardingProcessingScreen from "../src/components/onboarding/OnboardingProcessingScreen";
import { AlertCircle } from "lucide-react";

function FixtureApp() {
  const [view, setView] = useState("step1-default");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get("view");
    if (v) setView(v);
  }, []);

  if (view === "step1-default") {
    return (
      <OnboardingStep1
        roles={[]}
        onToggleRole={() => {}}
        onRemoveRole={() => {}}
        employmentTypes={[]}
        onToggleEmploymentType={() => {}}
        country=""
        onSelectCountry={() => {}}
        openToRemote={true}
        onToggleOpenToRemote={() => {}}
        workAuth=""
        onSelectWorkAuth={() => {}}
        onNext={() => {}}
      />
    );
  }

  if (view === "step1-filled") {
    return (
      <OnboardingStep1
        roles={["Backend Engineer", "Full Stack Engineer"]}
        onToggleRole={() => {}}
        onRemoveRole={() => {}}
        employmentTypes={["full-time"]}
        onToggleEmploymentType={() => {}}
        country="United States"
        onSelectCountry={() => {}}
        openToRemote={true}
        onToggleOpenToRemote={() => {}}
        workAuth="authorized"
        onSelectWorkAuth={() => {}}
        onNext={() => {}}
      />
    );
  }

  if (view === "picker-open") {
    return (
      <div>
        <OnboardingStep1
          roles={["Frontend Developer"]}
          onToggleRole={() => {}}
          onRemoveRole={() => {}}
          employmentTypes={["full-time"]}
          onToggleEmploymentType={() => {}}
          country="United States"
          onSelectCountry={() => {}}
          openToRemote={true}
          onToggleOpenToRemote={() => {}}
          workAuth="authorized"
          onSelectWorkAuth={() => {}}
          onNext={() => {}}
        />
        <JobFunctionBottomSheet
          isOpen={true}
          onClose={() => {}}
          selectedRoles={["Frontend Developer"]}
          onToggleRole={() => {}}
        />
      </div>
    );
  }

  if (view === "picker-search") {
    return (
      <div>
        <OnboardingStep1
          roles={["Backend Engineer"]}
          onToggleRole={() => {}}
          onRemoveRole={() => {}}
          employmentTypes={["full-time"]}
          onToggleEmploymentType={() => {}}
          country="United States"
          onSelectCountry={() => {}}
          openToRemote={true}
          onToggleOpenToRemote={() => {}}
          workAuth="authorized"
          onSelectWorkAuth={() => {}}
          onNext={() => {}}
        />
        <JobFunctionBottomSheet
          isOpen={true}
          onClose={() => {}}
          selectedRoles={["Backend Engineer"]}
          onToggleRole={() => {}}
        />
      </div>
    );
  }

  if (view === "step2-initial") {
    return (
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="tok_mock"
      />
    );
  }

  if (view === "step2-processing") {
    return (
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="tok_mock"
        initialResumeName="Alex_Morgan_Resume_2026.pdf"
        initialUploading={true}
      />
    );
  }

  if (view === "step2-parsed") {
    return (
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="tok_mock"
        initialResumeName="Alex_Morgan_Resume_2026.pdf"
        initialResumeParse={{
          status: "parsed",
          source: "rules",
          jobTitle: "Senior Backend Engineer",
          skillsCount: 8,
          topSkills: ["Node.js", "TypeScript", "PostgreSQL", "Go", "Docker"],
          yearsOfExperience: 6.5,
        }}
      />
    );
  }

  if (view === "step2-failed") {
    return (
      <OnboardingStep2
        onBack={() => {}}
        onFinish={() => {}}
        isSaving={false}
        authToken="tok_mock"
        initialResumeName="scanned_resume_doc.pdf"
        initialResumeParse={{
          status: "failed",
          reason: "scanned_pdf",
        }}
      />
    );
  }

  if (view === "error-state") {
    return (
      <main className="min-h-screen bg-zinc-50/60 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col justify-between">
        <div>
          <div role="alert" className="max-w-6xl mx-auto px-4 sm:px-6 pt-4">
            <div className="flex items-center gap-3 p-3.5 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-xl text-red-700 dark:text-red-300 text-sm">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <span className="flex-1 font-medium">Failed to save your preferences. Please try again.</span>
              <button
                type="button"
                className="text-xs font-semibold underline hover:no-underline ml-auto"
              >
                Dismiss
              </button>
            </div>
          </div>
          <OnboardingStep1
            roles={["Backend Engineer"]}
            onToggleRole={() => {}}
            onRemoveRole={() => {}}
            employmentTypes={["full-time"]}
            onToggleEmploymentType={() => {}}
            country="United States"
            onSelectCountry={() => {}}
            openToRemote={true}
            onToggleOpenToRemote={() => {}}
            workAuth="authorized"
            onSelectWorkAuth={() => {}}
            onNext={() => {}}
          />
        </div>
      </main>
    );
  }

  return <div>Unknown view: {view}</div>;
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<FixtureApp />);
}
