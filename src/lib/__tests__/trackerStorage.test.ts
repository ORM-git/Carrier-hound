// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addApplicationToTracker,
  clearTrackerMemoryState,
  deleteApplicationFromTracker,
  generateUUID,
  getScopedTrackerStorageKey,
  getTrackedApplications,
  GUEST_STORAGE_KEY,
  invalidateTrackedApplicationsCache,
  isMatchingTrackerJob,
  quickTrackJob,
  removeApplicationFromTracker,
  updateApplicationNotes,
  updateApplicationStage,
} from "../tracker/storage";

const mockUpsert = vi.fn().mockResolvedValue({ error: null });
const mockUpdate = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  }),
});
const mockDelete = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  }),
});
const mockOrder = vi.fn().mockResolvedValue({ data: [], error: null });
const mockSelect = vi.fn().mockReturnValue({
  eq: vi.fn().mockReturnValue({
    order: mockOrder,
  }),
});

const mockSupabase = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
    getUser: vi.fn().mockResolvedValue({ data: { user: null } }),
  },
  from: vi.fn((_table: string) => ({
    select: mockSelect,
    upsert: mockUpsert,
    update: mockUpdate,
    delete: mockDelete,
  })),
};

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => mockSupabase,
}));

describe("tracker/storage", () => {
  beforeEach(() => {
    localStorage.clear();
    clearTrackerMemoryState();
    vi.clearAllMocks();
    mockOrder.mockResolvedValue({ data: [], error: null });
    mockSupabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } });
  });

  describe("getScopedTrackerStorageKey", () => {
    it("returns GUEST_STORAGE_KEY when userId is undefined, null, or whitespace", () => {
      expect(getScopedTrackerStorageKey()).toBe(GUEST_STORAGE_KEY);
      expect(getScopedTrackerStorageKey(null)).toBe(GUEST_STORAGE_KEY);
      expect(getScopedTrackerStorageKey("")).toBe(GUEST_STORAGE_KEY);
      expect(getScopedTrackerStorageKey("   ")).toBe(GUEST_STORAGE_KEY);
    });

    it("scopes key to the trimmed userId", () => {
      expect(getScopedTrackerStorageKey("user_abc")).toBe("careermonke_applications_user_abc");
      expect(getScopedTrackerStorageKey("  user_xyz  ")).toBe("careermonke_applications_user_xyz");
    });
  });

  describe("generateUUID", () => {
    it("returns a valid UUID string and generates unique values", () => {
      const u1 = generateUUID();
      const u2 = generateUUID();
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(u1).toMatch(uuidRegex);
      expect(u2).toMatch(uuidRegex);
      expect(u1).not.toBe(u2);
    });
  });

  describe("isMatchingTrackerJob", () => {
    it("matches strictly by jobId when both records provide a job id", () => {
      expect(isMatchingTrackerJob({ jobId: "job-10" }, { jobId: "job-10" })).toBe(true);
      expect(isMatchingTrackerJob({ jobId: "job-10" }, { jobId: "job-20" })).toBe(false);
      expect(isMatchingTrackerJob({ jobId: "job-10" }, { id: "job-10" })).toBe(true);
    });

    it("falls back to normalized company and title matching when jobId is absent", () => {
      const app = { company: " Stripe ", title: "Staff Engineer " };
      const target = { company: "stripe", title: "staff engineer" };
      expect(isMatchingTrackerJob(app, target)).toBe(true);

      const differentTitle = { company: "stripe", title: "Senior Engineer" };
      expect(isMatchingTrackerJob(app, differentTitle)).toBe(false);
    });

    it("returns false if company or title is missing on either record", () => {
      expect(isMatchingTrackerJob({ company: "Stripe" }, { company: "Stripe" })).toBe(false);
      expect(isMatchingTrackerJob({ company: "Stripe", title: "Dev" }, { company: "Stripe" })).toBe(false);
    });
  });

  describe("CRUD operations and cache lifecycle", () => {
    it("adds a new application to guest tracker, persists to localStorage, and retrieves it", async () => {
      const added = await addApplicationToTracker({
        company: "Vercel",
        title: "Frontend Engineer",
        stage: "saved",
        location: "Remote",
        notes: "Great team",
      });

      expect(added.id).toBeDefined();
      expect(added.company).toBe("Vercel");
      expect(added.title).toBe("Frontend Engineer");
      expect(added.stage).toBe("saved");

      const apps = await getTrackedApplications();
      expect(apps).toHaveLength(1);
      expect(apps[0].id).toBe(added.id);
    });

    it("updates existing application when re-adding matching job", async () => {
      const first = await addApplicationToTracker({
        jobId: "job-99",
        company: "GitHub",
        title: "Systems Engineer",
        stage: "saved",
      });

      const updated = await addApplicationToTracker({
        jobId: "job-99",
        company: "GitHub",
        title: "Systems Engineer",
        stage: "applied",
        notes: "Applied on site",
      });

      expect(updated.id).toBe(first.id);
      expect(updated.stage).toBe("applied");
      expect(updated.notes).toBe("Applied on site");
      expect(updated.appliedAt).toBeDefined();

      const apps = await getTrackedApplications();
      expect(apps).toHaveLength(1);
      expect(apps[0].stage).toBe("applied");
    });

    it("updates stage using updateApplicationStage", async () => {
      const app = await addApplicationToTracker({
        company: "PostHog",
        title: "Full Stack Engineer",
        stage: "saved",
      });

      await updateApplicationStage(app.id, "applied");
      let apps = await getTrackedApplications();
      expect(apps[0].stage).toBe("applied");
      expect(apps[0].appliedAt).toBeDefined();

      await updateApplicationStage(app.id, "interview");
      apps = await getTrackedApplications();
      expect(apps[0].stage).toBe("interview");
    });

    it("updates notes and follow-up using updateApplicationNotes", async () => {
      const app = await addApplicationToTracker({
        company: "Linear",
        title: "Product Engineer",
        stage: "saved",
      });

      await updateApplicationNotes(app.id, "Spoke with recruiter", "2026-11-20T10:00:00Z");
      const apps = await getTrackedApplications();
      expect(apps[0].notes).toBe("Spoke with recruiter");
      expect(apps[0].followUpAt).toBe("2026-11-20T10:00:00Z");
    });

    it("deletes application using deleteApplicationFromTracker", async () => {
      const a1 = await addApplicationToTracker({ company: "A", title: "Role A", stage: "saved" });
      const a2 = await addApplicationToTracker({ company: "B", title: "Role B", stage: "saved" });

      expect(await getTrackedApplications()).toHaveLength(2);
      await deleteApplicationFromTracker(a1.id);

      const remaining = await getTrackedApplications();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(a2.id);
    });

    it("removes application by jobId using removeApplicationFromTracker", async () => {
      await addApplicationToTracker({ jobId: "target-job", company: "C", title: "Role C", stage: "saved" });
      expect(await getTrackedApplications()).toHaveLength(1);

      await removeApplicationFromTracker("target-job");
      expect(await getTrackedApplications()).toHaveLength(0);
    });

    it("quickTrackJob saves with default saved stage", async () => {
      const quick = await quickTrackJob({
        id: "quick-1",
        title: "Backend Dev",
        company: "Supabase",
      });

      expect(quick.stage).toBe("saved");
      expect(quick.jobId).toBe("quick-1");
      expect(quick.company).toBe("Supabase");

      const apps = await getTrackedApplications();
      expect(apps).toHaveLength(1);
    });

    it("invalidateTrackedApplicationsCache and clearTrackerMemoryState clear in-memory memoization", async () => {
      await addApplicationToTracker({ company: "CacheCo", title: "Tester", stage: "saved" });
      invalidateTrackedApplicationsCache();
      const apps = await getTrackedApplications();
      expect(apps).toHaveLength(1);

      clearTrackerMemoryState();
      const appsAfterReset = await getTrackedApplications();
      expect(appsAfterReset).toHaveLength(1);
    });

    it("syncs with Supabase when authenticated user is present", async () => {
      const userId = "usr_authenticated_1";
      const user = { id: userId, email: "user@example.com" };
      mockSupabase.auth.getSession.mockResolvedValue({ data: { session: { user } as any } });
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user } as any });

      const remoteRows = [
        {
          id: "app-remote-1",
          job_id: "550e8400-e29b-41d4-a716-446655440000",
          company: "RemoteCorp",
          title: "Cloud Architect",
          location: "NYC",
          salary_text: "$180k",
          apply_url: "https://example.com/apply",
          stage: "interview",
          notes: "Round 2 scheduled",
          applied_at: "2026-11-01T00:00:00Z",
          follow_up_at: "2026-11-15T00:00:00Z",
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-02T00:00:00Z",
        },
      ];
      mockOrder.mockResolvedValue({ data: remoteRows, error: null });

      const apps = await getTrackedApplications(userId);
      expect(apps).toHaveLength(1);
      expect(apps[0].company).toBe("RemoteCorp");
      expect(apps[0].stage).toBe("interview");

      // Add with valid UUID vs non-UUID jobId
      await addApplicationToTracker(
        {
          jobId: "550e8400-e29b-41d4-a716-446655440000",
          company: "RemoteCorp",
          title: "Cloud Architect",
          stage: "offer",
          notes: "Got offer",
          followUpAt: "2026-11-18T00:00:00Z",
        },
        userId
      );
      expect(mockUpsert).toHaveBeenCalled();

      // Add non-UUID jobId
      await addApplicationToTracker(
        {
          jobId: "custom-slug-123",
          company: "OtherCorp",
          title: "Designer",
          stage: "saved",
        },
        userId
      );

      await updateApplicationStage("app-remote-1", "offer", userId);
      expect(mockUpdate).toHaveBeenCalled();

      await updateApplicationNotes("app-remote-1", "Updated note", undefined, userId);
      expect(mockUpdate).toHaveBeenCalled();

      await removeApplicationFromTracker("550e8400-e29b-41d4-a716-446655440000", userId);
      expect(mockDelete).toHaveBeenCalled();
    });
  });
});
