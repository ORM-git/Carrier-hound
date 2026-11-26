# Advanced filters: owner activation runbook (STAGING, NOT APPLIED)

Everything here is OFF by default. Nothing below is authorized yet. The owner runs each step by hand and records it.

## SQL staging
- `docs/proposed/executable/20261126b_advanced_preferences_slice1.sql` and `20261126c_advanced_skill_filter_rpc.sql` are staging copies. They are NOT in `supabase/migrations`, so no tool that applies that folder can run them.
- The `*.READONLY.sql` files next to them are the read-only pre-checks. Run those first.
- The owner reviews the executable SQL, applies it by hand, and records when and how.

## Activation order (each step needs the owner's explicit go)
1. Apply 20261126b, then 20261126c. Check privileges (service_role only for the RPC) and run a preview EXPLAIN on real data.
2. Set CM_EXCLUDED_SKILLS_RPC only after step 1 checks pass.
3. MANDATORY before turning CM_PREFERRED_SKILLS_RANKING or the saved-constraints gate ON: bump MATCH_SCORE_VERSION in the same release, so every browser drops its old cached scores. Then verify a real refetch: load the feed after deploy and confirm cards show freshly computed scores, not cached ones. Showing stale numbers is not an accepted option.
4. Only then flip the flag. Check GET /api/jobs/capabilities reports the expected values.
5. Rollback: set the flags OFF. Bump the version again if scores were shown while ON.
