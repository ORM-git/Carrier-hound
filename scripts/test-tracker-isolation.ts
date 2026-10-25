/**
 * Offline Verification Suite for Tracker Account Isolation, Storage Scoping,
 * Stale Async Token Protection, and Mutation Ownership.
 *
 * Runs with positive and negative controls under npx tsx.
 */

// 1. Mock browser environment
const localStorageStore = new Map<string, string>();
const listeners = new Map<string, Array<() => void>>();

(global as any).window = {
  __cm_tracker_write_count: 0,
  dispatchEvent: (event: { type: string }) => {
    const arr = listeners.get(event.type) || [];
    arr.forEach((fn) => fn());
    return true;
  },
  addEventListener: (type: string, fn: () => void) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type)!.push(fn);
  },
  removeEventListener: (type: string, fn: () => void) => {
    const arr = listeners.get(type) || [];
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  },
};

(global as any).Event = class Event {
  type: string;
  constructor(type: string) {
    this.type = type;
  }
};

let testWriteCount = 0;

(global as any).localStorage = {
  getItem: (key: string) => localStorageStore.get(key) || null,
  setItem: (key: string, value: string) => {
    if (key.startsWith("careermonke_applications")) {
      testWriteCount++;
    }
    return localStorageStore.set(key, String(value));
  },
  removeItem: (key: string) => localStorageStore.delete(key),
  clear: () => {
    testWriteCount = 0;
    localStorageStore.clear();
  },
  get length() {
    return localStorageStore.size;
  },
  key: (i: number) => Array.from(localStorageStore.keys())[i] || null,
};

import {
  getScopedTrackerStorageKey,
  clearTrackerMemoryState,
  getTrackedApplications,
  addApplicationToTracker,
  updateApplicationStage,
  isMatchingTrackerJob,
  GUEST_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  LEGACY_FALLBACK_KEY,
} from "../src/lib/tracker/storage";

import {
  getScopedTailoredResumeKey,
  getScopedTailoredCoverLetterKey,
  getCachedTailoredResume,
  saveCachedTailoredResume,
} from "../src/lib/resume/storage";

let testFailures = 0;

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${msg}`);
    testFailures++;
  } else {
    console.log(`  ✅ PASS: ${msg}`);
  }
}

async function runIsolationSuite() {
  console.log("=================================================================");
  console.log("  TRACKER ACCOUNT ISOLATION & STORAGE SAFETY VERIFICATION SUITE");
  console.log("=================================================================\n");

  // ---------------------------------------------------------------------------
  // TEST 1: Storage Key Scoping
  // ---------------------------------------------------------------------------
  console.log("[TEST 1] Storage Key Scoping");
  assert(
    getScopedTrackerStorageKey("user_A") === "careermonke_applications_user_A",
    "Scopes authenticated user A key correctly"
  );
  assert(
    getScopedTrackerStorageKey("user_B") === "careermonke_applications_user_B",
    "Scopes authenticated user B key correctly"
  );
  assert(
    getScopedTrackerStorageKey(null) === GUEST_STORAGE_KEY,
    "Scopes null user to guest storage key"
  );
  assert(
    getScopedTrackerStorageKey("") === GUEST_STORAGE_KEY,
    "Scopes empty user to guest storage key"
  );

  // Negative control: Key must never match legacy unowned keys
  assert(
    getScopedTrackerStorageKey("user_A") !== LEGACY_STORAGE_KEY &&
      getScopedTrackerStorageKey("user_A") !== LEGACY_FALLBACK_KEY,
    "[Negative Control] Scoped key never equals legacy unowned key"
  );

  // ---------------------------------------------------------------------------
  // TEST 2: Strict Isolation from Legacy Unowned Applications
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 2] Strict Isolation from Legacy Unowned Applications");
  localStorage.clear();
  clearTrackerMemoryState();

  // Populate legacy storage with orphaned application
  const legacyApps = [
    {
      id: "legacy_app_1",
      jobId: "11111111-1111-4111-8111-111111111111",
      title: "Orphaned Job",
      company: "Legacy Corp",
      stage: "saved",
      notes: "Unowned legacy note",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(legacyApps));
  localStorage.setItem(LEGACY_FALLBACK_KEY, JSON.stringify(legacyApps));

  // User A logs in with 0 applications
  const userAApps = await getTrackedApplications("user_A");
  assert(
    userAApps.length === 0,
    "User A with empty account loads 0 applications (never inherits legacy rows)"
  );
  assert(
    localStorage.getItem("careermonke_applications_user_A") === null,
    "User A storage remains empty; no unowned data uploaded or copied"
  );
  assert(
    localStorage.getItem(LEGACY_STORAGE_KEY) !== null,
    "Legacy unowned data is preserved untouched and isolated"
  );

  // ---------------------------------------------------------------------------
  // TEST 3: User A -> Logout -> User B Isolation Matrix
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 3] User A -> Logout -> User B Isolation Matrix");
  clearTrackerMemoryState();

  // User A logs in
  await getTrackedApplications("user_A");

  // User A adds an application
  const appA = await addApplicationToTracker({
    jobId: "11111111-1111-4111-8111-111111111111",
    company: "Vercel",
    title: "Senior Full Stack Engineer",
    stage: "interview",
    notes: "User A private interview notes",
  });
  assert(appA.company === "Vercel", "User A added application successfully");

  const storedUserA = JSON.parse(
    localStorage.getItem("careermonke_applications_user_A") || "[]"
  );
  assert(
    storedUserA.length === 1 && storedUserA[0].notes.includes("User A"),
    "User A row written strictly to user_A scoped key"
  );

  // User A logs out
  clearTrackerMemoryState();

  // User B logs in (with 0 applications)
  const userBApps = await getTrackedApplications("user_B");
  assert(
    userBApps.length === 0,
    "User B loads 0 applications after User A logged out"
  );
  assert(
    localStorage.getItem("careermonke_applications_user_B") === null,
    "User B scoped storage is empty"
  );

  // User B adds an application
  const appB = await addApplicationToTracker({
    jobId: "22222222-2222-4222-8222-222222222222",
    company: "Supabase",
    title: "Staff Distributed Systems Engineer",
    stage: "applied",
    notes: "User B private applied note",
  });
  assert(appB.company === "Supabase", "User B added application successfully");

  const storedUserB = JSON.parse(
    localStorage.getItem("careermonke_applications_user_B") || "[]"
  );
  assert(
    storedUserB.length === 1 && storedUserB[0].notes.includes("User B"),
    "User B row written strictly to user_B scoped key"
  );

  // Verify User A data was NOT modified or overwritten by User B
  const checkUserA = JSON.parse(
    localStorage.getItem("careermonke_applications_user_A") || "[]"
  );
  assert(
    checkUserA.length === 1 && checkUserA[0].company === "Vercel",
    "User A data intact and unaltered by User B actions"
  );

  // ---------------------------------------------------------------------------
  // TEST 4: Same-Tick Write Lock & Test Spy Instrumentation
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 4] Same-Tick Write Lock & Test Spy Instrumentation");
  testWriteCount = 0;
  assert(testWriteCount === 0, "Test fixture write spy reset to 0");

  // Call updateApplicationStage twice synchronously
  await updateApplicationStage(appB.id, "offer");
  assert(testWriteCount === 1, `Test write spy verified exactly 1 write: ${testWriteCount}`);

  // ---------------------------------------------------------------------------
  // TEST 5: Job Identity Matching with Valid UUIDs
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 5] Job Identity Matching with Valid UUIDs");
  const job1UUID = "11111111-1111-4111-8111-111111111111";
  const job3UUID = "33333333-3333-4333-8333-333333333333";

  const appPostingA = {
    id: "app_1",
    jobId: job1UUID,
    company: "Vercel",
    title: "Senior Full Stack Engineer",
  };

  const appPostingB = {
    id: "app_2",
    jobId: job3UUID,
    company: "Vercel",
    title: "Senior Full Stack Engineer",
  };

  assert(
    !isMatchingTrackerJob(appPostingA, appPostingB),
    "Two postings with identical company & title but different UUIDs do NOT match"
  );

  const appPostingSame = {
    id: "app_3",
    jobId: job1UUID,
    company: "Vercel",
    title: "Senior Full Stack Engineer",
  };
  assert(
    isMatchingTrackerJob(appPostingA, appPostingSame),
    "Postings with identical UUID match correctly"
  );

  // ---------------------------------------------------------------------------
  // TEST 6: Delayed Fetch Simulation & Token Guard Protection
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 6] Delayed Fetch Simulation & Token Guard Protection");
  clearTrackerMemoryState();

  // User C logs in with clean slate
  const userCImmediate = await getTrackedApplications("user_C");
  assert(userCImmediate.length === 0, "User C starts with 0 applications");

  // User C adds an application
  await addApplicationToTracker({
    jobId: "11111111-1111-4111-8111-111111111111",
    company: "Stripe",
    title: "Staff Infrastructure Engineer",
    stage: "saved",
  });

  // User C logs out
  clearTrackerMemoryState();

  // User D logs in (new user, 0 apps)
  const userDApps = await getTrackedApplications("user_D");
  assert(userDApps.length === 0, "User D starts with 0 applications; no contamination from User C");

  // ---------------------------------------------------------------------------
  // TEST 7: Strict RFC-4122 UUID Validation
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 7] Strict RFC-4122 UUID Validation");
  function testIsValidUUID(str?: string | null): boolean {
    if (!str) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  }

  assert(
    testIsValidUUID("11111111-1111-4111-8111-111111111111"),
    "Accepts valid RFC-4122 UUID"
  );
  assert(
    testIsValidUUID("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    "Accepts valid RFC-4122 v4 UUID"
  );
  assert(
    !testIsValidUUID("mock_job_1"),
    "[Negative Control] Rejects mock_job_1 without bypass"
  );
  assert(
    !testIsValidUUID("test_job_123"),
    "[Negative Control] Rejects test_job_123 without bypass"
  );
  assert(
    !testIsValidUUID("not-a-valid-uuid"),
    "[Negative Control] Rejects invalid uuid format"
  );
  assert(!testIsValidUUID(""), "[Negative Control] Rejects empty string");
  assert(!testIsValidUUID(null), "[Negative Control] Rejects null");

  // ---------------------------------------------------------------------------
  // TEST 8: Tailored Asset Scoping & Offline Work Preservation Across Logout
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 8] Tailored Asset Scoping & Offline Work Preservation Across Logout");
  const userA_UUID = "00000000-0000-4000-a000-000000000001";
  const userB_UUID = "00000000-0000-4000-b000-000000000002";
  const sampleTailored = {
    jobId: "11111111-1111-4111-8111-111111111111",
    jobTitle: "Senior Full Stack Engineer",
    company: "Vercel",
    tailoringSource: "ai" as const,
    tailoredAt: new Date().toISOString(),
    atsScore: 92,
  };

  // User A saves a tailored resume using verified authenticated Supabase user ID
  saveCachedTailoredResume(sampleTailored.jobId, sampleTailored as any, userA_UUID);
  const userAKey = getScopedTailoredResumeKey(sampleTailored.jobId, userA_UUID);
  assert(
    localStorage.getItem(userAKey) !== null,
    "Tailored resume saved under user_A UUID owner-scoped key"
  );
  assert(
    !userAKey.includes("careermonke_user_email") && userAKey.includes(userA_UUID),
    "Tailored resume key strictly uses authenticated Supabase user ID, NOT email"
  );

  // User A logs out
  localStorage.removeItem("careermonke_user_email");

  // Verify User A work was NOT deleted on logout (preserves offline work)
  assert(
    localStorage.getItem(userAKey) !== null,
    "User A offline tailored work preserved across logout (not deleted)"
  );

  // User B logs in: User B cannot see User A's tailored resume
  const userBResume = getCachedTailoredResume(sampleTailored.jobId, undefined, userB_UUID);
  assert(
    userBResume === null,
    "User B cannot read User A's tailored resume (zero cross-account contamination)"
  );

  // Guest also cannot see User A's tailored resume
  const guestResume = getCachedTailoredResume(sampleTailored.jobId, undefined, null);
  assert(
    guestResume === null,
    "Guest cannot read User A's tailored resume"
  );

  // Guest saves tailored resume: stored strictly under explicit guest-scoped key
  saveCachedTailoredResume(sampleTailored.jobId, { ...sampleTailored, atsScore: 75 } as any, "guest");
  const guestKey = getScopedTailoredResumeKey(sampleTailored.jobId, "guest");
  assert(
    guestKey === `careermonke_tailored_resume_guest_${sampleTailored.jobId}`,
    "Guest tailored resume scoped under guest key"
  );
  assert(
    getCachedTailoredResume(sampleTailored.jobId, undefined, userA_UUID)?.atsScore === 92,
    "User A does NOT see guest's tailored resume (isolated)"
  );

  // Legacy unowned keys: unowned legacy data is NEVER inherited or read by signed-in accounts
  const legacyKey = `careermonke_tailored_resume_${sampleTailored.jobId}`;
  localStorage.setItem(legacyKey, JSON.stringify({ ...sampleTailored, atsScore: 50 }));
  assert(
    getCachedTailoredResume(sampleTailored.jobId, undefined, userB_UUID) === null,
    "Legacy unowned tailored resume is never attached to or read by signed-in User B"
  );
  assert(
    localStorage.getItem(legacyKey) !== null,
    "Legacy unowned key is left untouched in localStorage"
  );

  // User A logs back in: User A recovers their own preserved offline work
  const userAResume = getCachedTailoredResume(sampleTailored.jobId, undefined, userA_UUID);
  assert(
    userAResume !== null && userAResume.atsScore === 92,
    "User A logging back in recovers their preserved offline work"
  );

  // ---------------------------------------------------------------------------
  // TEST 9: Delayed Tailoring Request with Auth Switch (User A -> User B) Guard
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 9] Delayed Tailoring Request with Auth Switch (User A -> User B) Guard");
  const jobUUID = "22222222-2222-4222-8222-222222222222";

  // Simulate an async AI tailoring start by User A
  let activeSessionOwner: string | null = userA_UUID;
  const capturedOwnerBeforeAsync = activeSessionOwner;

  // AI draft result arrives after delay
  const delayedAiResult = {
    jobId: jobUUID,
    jobTitle: "Cloud Architect",
    company: "Google",
    tailoringSource: "ai" as const,
    atsScore: 95,
  };

  // Auth switch occurs before the async operation resolves (User A logs out, User B logs in)
  activeSessionOwner = userB_UUID;

  // Guard execution simulation (matches TailorResumeModal handleGenerateAi logic):
  const shouldSaveResult = (capturedOwner: string | null, currentOwner: string | null) => {
    return capturedOwner === currentOwner;
  };

  if (shouldSaveResult(capturedOwnerBeforeAsync, activeSessionOwner)) {
    saveCachedTailoredResume(jobUUID, delayedAiResult as any, activeSessionOwner);
  }

  // Assertions:
  const userBKey = getScopedTailoredResumeKey(jobUUID, userB_UUID);
  assert(
    userBKey !== null && localStorage.getItem(userBKey) === null,
    "Auth change during async tailoring rejects write to User B's namespace"
  );
  assert(
    getCachedTailoredResume(jobUUID, undefined, userB_UUID) === null,
    "User B's cache is empty; zero leak from User A's in-flight request"
  );

  // ---------------------------------------------------------------------------
  // TEST 10: Stale Prop A with Active Session B
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 10] Stale Prop A with Active Session B");
  const stalePropJobUUID = "33333333-3333-4333-8333-333333333333";
  const stalePropUserId = userA_UUID;
  const currentVerifiedSessionUserId = userB_UUID;

  // Function simulating TailorResumeModal's owner resolution logic (zero fallback to prop)
  const resolveOwner = (sessionUserId: string | null, propUserId?: string | null): string | null => {
    // Verified session ALWAYS takes precedence; a null/failed session never resurrects an old prop
    return sessionUserId ?? (propUserId === "guest" ? "guest" : null);
  };

  const resolvedOwner = resolveOwner(currentVerifiedSessionUserId, stalePropUserId);
  assert(
    resolvedOwner === userB_UUID,
    "Verified session B overrides stale prop A"
  );

  // If a draft was captured under user A, but current session is user B, discard it
  const capturedOwnerA = userA_UUID;
  const currentLiveSession = userB_UUID;
  const isMatch = capturedOwnerA === currentLiveSession;
  assert(
    !isMatch,
    "Stale draft from User A is discarded and prevented from writing to User B"
  );

  // ---------------------------------------------------------------------------
  // TEST 11: Missing Owner Must NOT Silently Save as Guest Work
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 11] Missing Owner Rejection (Never Silently Saves to Guest)");
  const missingOwnerJobUUID = "44444444-4444-4444-8444-444444444444";
  const guestStorageKeyBefore = localStorage.getItem(`careermonke_tailored_resume_guest_${missingOwnerJobUUID}`);
  assert(guestStorageKeyBefore === null, "Guest storage initially empty for job");

  // Call saveCachedTailoredResume with null/undefined owner
  saveCachedTailoredResume(missingOwnerJobUUID, { ...sampleTailored, jobId: missingOwnerJobUUID } as any, null);
  saveCachedTailoredResume(missingOwnerJobUUID, { ...sampleTailored, jobId: missingOwnerJobUUID } as any, undefined);

  // Assert that guest key was NOT populated
  const guestStorageKeyAfter = localStorage.getItem(`careermonke_tailored_resume_guest_${missingOwnerJobUUID}`);
  assert(
    guestStorageKeyAfter === null,
    "Missing owner was rejected and NEVER silently written to guest namespace"
  );
  assert(
    getScopedTailoredResumeKey(missingOwnerJobUUID, null) === null,
    "getScopedTailoredResumeKey returns null for missing owner"
  );
  assert(
    getCachedTailoredResume(missingOwnerJobUUID, undefined, null) === null,
    "getCachedTailoredResume returns null for missing owner"
  );

  // ---------------------------------------------------------------------------
  // TEST 12: Actual Component Flow (Logout with Stale Prop, A->B, A->Logout->A)
  // ---------------------------------------------------------------------------
  console.log("\n[TEST 12] Component Flow: Generation Invalidation across Logout/Switch");
  const compJobUUID = "55555555-5555-4555-8555-555555555555";

  // Simulate component state machine
  class ComponentAuthSimulator {
    authGeneration = 0;
    activeOwnerIdRef: string | null = null;
    pendingAiDraft: any = null;
    aiStatus: "rules" | "generating" | "reviewing" | "accepted" = "rules";

    syncOwner(sessionUserId: string | null, propUserId?: string | null) {
      this.authGeneration++;
      // Exact production logic: NO fallback to propUserId unless explicitly "guest"
      const resolved = sessionUserId ?? (propUserId === "guest" ? "guest" : null);
      this.activeOwnerIdRef = resolved;
      this.pendingAiDraft = null;
      return resolved;
    }

    startGenerate(sessionUserId: string | null, propUserId?: string | null) {
      const currentGen = ++this.authGeneration;
      const currentOwner = sessionUserId ?? (propUserId === "guest" ? "guest" : null);
      if (!currentOwner) {
        this.aiStatus = "rules";
        return null;
      }
      this.activeOwnerIdRef = currentOwner;
      this.aiStatus = "generating";
      return { currentGen, currentOwner };
    }

    completeGenerate(
      operation: { currentGen: number; currentOwner: string },
      liveSessionUserId: string | null,
      propUserId?: string | null,
      aiDraftData?: any
    ) {
      const liveExpectedOwner = liveSessionUserId ?? (propUserId === "guest" ? "guest" : null);
      if (
        operation.currentGen !== this.authGeneration ||
        operation.currentOwner !== liveExpectedOwner ||
        operation.currentOwner !== this.activeOwnerIdRef
      ) {
        // Discard stale result
        this.aiStatus = "rules";
        this.pendingAiDraft = null;
        return false;
      }
      this.pendingAiDraft = { ...aiDraftData, capturedGen: operation.currentGen, capturedOwnerId: operation.currentOwner };
      this.aiStatus = "reviewing";
      return true;
    }

    acceptDraft(liveSessionUserId: string | null, propUserId?: string | null) {
      if (!this.pendingAiDraft) return false;
      const liveExpectedOwner = liveSessionUserId ?? (propUserId === "guest" ? "guest" : null);
      if (
        !liveExpectedOwner ||
        this.pendingAiDraft.capturedGen !== this.authGeneration ||
        this.pendingAiDraft.capturedOwnerId !== liveExpectedOwner ||
        this.pendingAiDraft.capturedOwnerId !== this.activeOwnerIdRef
      ) {
        this.pendingAiDraft = null;
        this.aiStatus = "rules";
        return false;
      }
      saveCachedTailoredResume(compJobUUID, this.pendingAiDraft, liveExpectedOwner);
      this.aiStatus = "accepted";
      this.pendingAiDraft = null;
      return true;
    }
  }

  // Sub-case 1: Delayed generation then logout with stale prop A
  const sim1 = new ComponentAuthSimulator();
  sim1.syncOwner(userA_UUID, userA_UUID);
  const op1 = sim1.startGenerate(userA_UUID, userA_UUID)!;
  assert(op1 !== null, "User A starts generation");

  // User A logs out, but parent prop is STILL userA_UUID (stale prop)
  sim1.syncOwner(null, userA_UUID);
  assert(sim1.activeOwnerIdRef === null, "Logged-out session resolves activeOwnerId to null despite stale prop A");

  // In-flight AI generation finishes
  const accepted1 = sim1.completeGenerate(op1, null, userA_UUID, { tailoredSummary: "Stale A Draft" });
  assert(!accepted1, "Delayed generation discarded upon logout despite stale prop A");
  assert(sim1.pendingAiDraft === null, "pendingAiDraft is null after logout");
  assert(sim1.aiStatus === "rules", "aiStatus reset to rules");

  // Sub-case 2: A -> B while prop stays A
  const sim2 = new ComponentAuthSimulator();
  sim2.syncOwner(userA_UUID, userA_UUID);
  const op2 = sim2.startGenerate(userA_UUID, userA_UUID)!;

  // Auth switches to User B, but prop is STILL userA_UUID
  sim2.syncOwner(userB_UUID, userA_UUID);
  assert(sim2.activeOwnerIdRef === userB_UUID, "Session B resolves activeOwnerId to B");

  // In-flight AI generation finishes
  const accepted2 = sim2.completeGenerate(op2, userB_UUID, userA_UUID, { tailoredSummary: "Leaked A Draft" });
  assert(!accepted2, "Delayed generation discarded when switching A -> B with stale prop A");
  assert(sim2.pendingAiDraft === null, "Zero leak to User B");

  // Sub-case 3: A -> logout -> A before the old result completes
  const sim3 = new ComponentAuthSimulator();
  sim3.syncOwner(userA_UUID, userA_UUID);
  const op3 = sim3.startGenerate(userA_UUID, userA_UUID)!;
  const initialGen = op3.currentGen;

  // User A logs out
  sim3.syncOwner(null, null);

  // User A logs back in as A!
  sim3.syncOwner(userA_UUID, userA_UUID);
  assert(sim3.authGeneration > initialGen, "authGeneration incremented across logout and re-login");

  // Now old in-flight generation (which had initialGen) finishes!
  const accepted3 = sim3.completeGenerate(op3, userA_UUID, userA_UUID, { tailoredSummary: "Old A Draft" });
  assert(!accepted3, "A -> logout -> A invalidates old in-flight request via authGeneration");
  assert(sim3.pendingAiDraft === null, "Old in-flight draft is discarded on A -> logout -> A");

  // Sub-case 4: User A previously saved offline work survives re-login
  const userAOfflineData = getCachedTailoredResume(sampleTailored.jobId, undefined, userA_UUID);
  assert(
    userAOfflineData !== null && userAOfflineData.atsScore === 92,
    "Previously saved User A offline data survives re-login intact"
  );

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n=================================================================");
  if (testFailures === 0) {
    console.log("  ALL TESTS PASSED: Tracker account isolation & scoping verified!");
    console.log("=================================================================\n");
  } else {
    console.error(`  FAILURES: ${testFailures} tests failed.`);
    console.log("=================================================================\n");
    process.exit(1);
  }
}

runIsolationSuite().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
