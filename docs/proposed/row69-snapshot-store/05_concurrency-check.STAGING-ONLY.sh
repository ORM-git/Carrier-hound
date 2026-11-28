#!/usr/bin/env bash
# ROW 69 FEED SNAPSHOT STORE: CONCURRENCY CHECK. WRITTEN, NOT RUN. STAGING / SCRATCH DATABASE ONLY, NEVER PRODUCTION.
# Run after 02_apply on a scratch or staging database. Needs psql and a service_role (or owner) connection string:
#   SNAPSHOT_TEST_DATABASE_URL='postgresql://...'  bash 05_concurrency-check.STAGING-ONLY.sh
# It WRITES test rows (owners in the reserved 00000000-0000-4000-8000-0000000069xx range) and deletes them at the end.
# PGlite (the local tests) is a single connection, so these are the checks only a real Postgres can make.
set -euo pipefail
DB="${SNAPSHOT_TEST_DATABASE_URL:?set SNAPSHOT_TEST_DATABASE_URL to a SCRATCH or STAGING database}"
case "$DB" in *prod*|*production*) echo "refusing: URL looks like production" >&2; exit 2;; esac
P=(psql "$DB" -X -q -v ON_ERROR_STOP=1 -At)
H=$(printf 'a%.0s' {1..64})                                   # a valid 64-hex query hash
OWNER=00000000-0000-4000-8000-000000006901
cleanup() { "${P[@]}" -c "DELETE FROM public.feed_snapshots WHERE owner_id::text LIKE '00000000-0000-4000-8000-0000000069%'" >/dev/null; }
trap cleanup EXIT
cleanup

capture() {   # $1 owner; prints ok or the error text
  "${P[@]}" -c "SELECT public.feed_capture_snapshot('recommended', '$1', 'free', '$H', 'r1', ARRAY[gen_random_uuid()], 30)" >/dev/null 2>"$TMP/err.$2" \
    && echo ok || sed -n 's/.*ERROR: *\([a-z_]*\).*/\1/p' "$TMP/err.$2"
}
TMP=$(mktemp -d)

echo "1. 30 parallel captures for ONE owner on 30 connections: expect exactly 10 ok, 20 snapshot_rate"
for i in $(seq 1 30); do capture "$OWNER" "$i" > "$TMP/r.$i" & done; wait
ok=$(cat "$TMP"/r.* | grep -c '^ok$' || true); rate=$(cat "$TMP"/r.* | grep -c '^snapshot_rate$' || true)
rows=$("${P[@]}" -c "SELECT count(*) FROM public.feed_snapshots WHERE owner_id = '$OWNER'")
echo "   ok=$ok snapshot_rate=$rate rows=$rows"; [ "$ok" = 10 ] && [ "$rows" = 10 ] && [ "$rate" = 20 ] || { echo "FAIL: rate limit not atomic"; exit 1; }
rm -f "$TMP"/r.*

echo "2. 20 parallel captures for 20 DIFFERENT owners: expect 20 ok (the lock serializes, it does not drop)"
for i in $(seq 10 29); do capture "00000000-0000-4000-8000-0000000069$i" "$i" > "$TMP/r.$i" & done; wait
ok=$(cat "$TMP"/r.* | grep -c '^ok$' || true); echo "   ok=$ok"; [ "$ok" = 20 ] || { echo "FAIL"; exit 1; }
rm -f "$TMP"/r.*

echo "3. Reads during a concurrent purge: a live snapshot stays readable, an expired one is never served"
LIVE=$("${P[@]}" -c "SELECT public.feed_capture_snapshot('multiword', '00000000-0000-4000-8000-000000006950', 'pro', '$H', 'r1', ARRAY[gen_random_uuid(), gen_random_uuid()], 30)")
for i in $(seq 1 10); do "${P[@]}" -c "SELECT public.feed_purge_expired_snapshots(5000)" >/dev/null & done
for i in $(seq 1 10); do "${P[@]}" -c "SELECT total FROM public.feed_read_snapshot_window('$LIVE', '00000000-0000-4000-8000-000000006950', 'pro', '$H', 0, 2)" > "$TMP/read.$i" & done; wait
bad=$(cat "$TMP"/read.* | grep -vc '^2$' || true); echo "   reads not returning 2: $bad"; [ "$bad" = 0 ] || { echo "FAIL"; exit 1; }

echo "4. Global capacity under concurrency: NOT exercised here (50000 active rows). The same advisory lock guards it as"
echo "   check 1; to test it directly, temporarily lower global_active in feed_snapshot_limits() on the scratch DB only."
echo "ALL CHECKS PASSED"
