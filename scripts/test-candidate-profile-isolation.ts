import assert from "assert";
import { spawnSync } from "child_process";
import * as path from "path";

// Ensure NODE_ENV is set to "test" so client mock gate activates
process.env.NODE_ENV = "test";

const isNegativeControl = process.argv.includes("--negative-control");

// In-memory mock storage
const storageMap = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => storageMap.get(key) || null,
  setItem: (key: string, val: string) => storageMap.set(key, String(val)),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
  get length() {
    return storageMap.size;
  },
  key: (i: number) => Array.from(storageMap.keys())[i] || null,
};

// Setup browser globals
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = mockLocalStorage;
(globalThis as any).document = {
  cookie: "",
};
(globalThis as any).Event = class Event {
  type: string;
  constructor(type: string) {
    this.type = type;
  }
};
(globalThis as any).dispatchEvent = () => true;

// Mock Supabase DB records
const mockDbProfiles: Record<string, any> = {
  "user-A": {
    user_id: "user-A",
    name: "User A Candidate",
    email: "userA@example.com",
    headline: "Staff Engineer A",
    summary: "Senior backend developer A",
    skills: ["TypeScript", "PostgreSQL"],
    confirmed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  "user-B": null, // User B has no saved profile in Supabase
};

function createMockSupabase(currentUserId: string | null = null) {
  const queryBuilder: any = {
    select: () => queryBuilder,
    eq: (col: string, val: any) => {
      queryBuilder._userId = val;
      return queryBuilder;
    },
    maybeSingle: async () => {
      const data = mockDbProfiles[queryBuilder._userId] || null;
      return { data, error: null };
    },
    upsert: async (payload: any) => {
      mockDbProfiles[payload.user_id] = { ...payload };
      return { data: payload, error: null };
    },
    delete: () => queryBuilder,
  };

  return {
    from: (table: string) => queryBuilder,
    auth: {
      getSession: async () => ({
        data: {
          session: currentUserId
            ? { user: { id: currentUserId, email: `${currentUserId}@example.com` } }
            : null,
        },
        error: null,
      }),
      getUser: async () => ({
        data: {
          user: currentUserId
            ? { id: currentUserId, email: `${currentUserId}@example.com` }
            : null,
        },
        error: null,
      }),
    },
  };
}

const sampleProfileA: any = {
  name: "User A Candidate",
  email: "userA@example.com",
  phone: "+1 555-0100",
  location: "San Francisco, CA",
  headline: "Staff Engineer A",
  summary: "Results-driven engineer A",
  skills: ["TypeScript", "React", "PostgreSQL"],
  experience: [],
  education: [],
  certifications: [],
  confirmedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

async function runTests() {
  const {
    getCandidateProfile,
    saveCandidateProfileLocally,
    saveConfirmedCandidateProfile,
    clearCandidateProfileMemoryCache,
  } = await import("../src/lib/resume/storage");

  if (isNegativeControl) {
    console.log("--- RUNNING NEGATIVE CONTROL: Verifying non-zero exit on isolation failure ---");
    mockLocalStorage.clear();
    clearCandidateProfileMemoryCache();

    // Save profile for User A
    saveCandidateProfileLocally(sampleProfileA, false, "user-A");
    (globalThis as any).__mockSupabaseClient = createMockSupabase("user-B");

    const profileForUserB = await getCandidateProfile("user-B");

    // Negative control condition: If isolation works, profileForUserB is null.
    // In negative control mode, we assert that profileForUserB IS User A (which is FALSE),
    // proving that this assertion detects the flaw and causes non-zero exit.
    assert.strictEqual(
      profileForUserB?.name,
      "User A Candidate",
      "Negative control intentional failure: User A profile must not load for User B"
    );
    return;
  }

  console.log("================================================================================");
  console.log("     CANDIDATE PROFILE USER ISOLATION & STORAGE CACHE BEHAVIOUR SUITE           ");
  console.log("================================================================================\n");

  let passCount = 0;

  // Test 1: Save local profile for user A -> must not load for user B
  {
    mockLocalStorage.clear();
    clearCandidateProfileMemoryCache();
    (globalThis as any).__mockSupabaseClient = createMockSupabase("user-B");

    saveCandidateProfileLocally(sampleProfileA, false, "user-A");
    assert.strictEqual(
      mockLocalStorage.getItem("careermonke_candidate_profile") !== null,
      true,
      "Profile should be saved in localStorage under PROFILE_STORAGE_KEY"
    );

    const userBProfile = await getCandidateProfile("user-B");
    assert.strictEqual(
      userBProfile,
      null,
      "getCandidateProfile('user-B') must return null and never load user A's profile"
    );

    // Assert that the mismatched profile was cleared from localStorage
    const storedAfter = mockLocalStorage.getItem("careermonke_candidate_profile");
    assert.strictEqual(
      storedAfter,
      null,
      "Mismatched profile for user A must be cleared from localStorage when user B accesses it"
    );

    console.log("  [PASS] Test 1: Local profile saved for user A does not load for user B and is cleared from storage");
    passCount++;
  }

  // Test 2: In-memory memoized cache isolation
  {
    mockLocalStorage.clear();
    clearCandidateProfileMemoryCache();

    // User A loads their profile into in-memory memoizedProfile
    (globalThis as any).__mockSupabaseClient = createMockSupabase("user-A");
    saveCandidateProfileLocally(sampleProfileA, false, "user-A");
    const userAProfile = await getCandidateProfile("user-A");
    assert.strictEqual(
      userAProfile?.name,
      "User A Candidate",
      "User A must be able to load their own profile"
    );

    // Now User B calls getCandidateProfile while User A's profile is in memory
    (globalThis as any).__mockSupabaseClient = createMockSupabase("user-B");
    const userBProfile = await getCandidateProfile("user-B");
    assert.strictEqual(
      userBProfile,
      null,
      "In-memory memoized profile of user A must not leak to user B"
    );

    console.log("  [PASS] Test 2: In-memory cache invalidates when signed-in user differs");
    passCount++;
  }

  // Test 3: Confirmed profile saves with ownerUserId and isolates correctly
  {
    mockLocalStorage.clear();
    clearCandidateProfileMemoryCache();

    (globalThis as any).__mockSupabaseClient = createMockSupabase("user-A");
    await saveConfirmedCandidateProfile(sampleProfileA);

    const raw = mockLocalStorage.getItem("careermonke_candidate_profile");
    assert.strictEqual(Boolean(raw), true, "Confirmed profile saved to storage");
    const parsed = JSON.parse(raw!);
    assert.strictEqual(
      parsed.ownerUserId,
      "user-A",
      "Stored profile must record ownerUserId"
    );

    // Read by User A -> works
    const profileA = await getCandidateProfile("user-A");
    assert.strictEqual(profileA?.name, "User A Candidate");

    // Read by User B -> returns null and clears
    (globalThis as any).__mockSupabaseClient = createMockSupabase("user-B");
    const profileB = await getCandidateProfile("user-B");
    assert.strictEqual(profileB, null);
    assert.strictEqual(mockLocalStorage.getItem("careermonke_candidate_profile"), null);

    console.log("  [PASS] Test 3: saveConfirmedCandidateProfile stores ownerUserId and isolates from user B");
    passCount++;
  }

  // Test 4: Ambient Supabase session detection without explicit userId param
  {
    mockLocalStorage.clear();
    clearCandidateProfileMemoryCache();

    // Store user A's profile
    saveCandidateProfileLocally(sampleProfileA, false, "user-A");

    // Supabase auth session has user B
    (globalThis as any).__mockSupabaseClient = createMockSupabase("user-B");

    // Call without explicit userId argument
    const profile = await getCandidateProfile();
    assert.strictEqual(
      profile,
      null,
      "getCandidateProfile() with user B session must reject and clear user A profile"
    );

    console.log("  [PASS] Test 4: Ambient Supabase session detects user mismatch and rejects foreign profile");
    passCount++;
  }

  // Test 5: Negative control verification via child process
  {
    const scriptPath = path.resolve(__dirname, "test-candidate-profile-isolation.ts");
    const neg = spawnSync("npx", ["tsx", scriptPath, "--negative-control"], {
      encoding: "utf8",
      shell: true,
    });

    assert.strictEqual(
      neg.status !== 0,
      true,
      `Negative control MUST exit non-zero. Received status ${neg.status}`
    );
    console.log("  [PASS] Test 5: Negative control verified — child process exited non-zero on simulated leak assertion");
    passCount++;
  }

  console.log(`\nAll ${passCount}/${passCount} tests passed [PASS-LOCAL].\n`);
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
