import { describe, expect, it } from 'vitest';
import { reconcileFeedWithDetail } from '../matcher/scoreCache';
describe('fresh detail score reconciliation', () => {
  it('a fresh authoritative detail score must survive replacing a stale feed row', () => {
    const detail = { id: 'j1', scoreRevision: 'new', matchScore: 72 };
    expect(reconcileFeedWithDetail([{ id: 'j1', scoreRevision: 'old', matchScore: 88 }], detail)[0].matchScore).toBe(72);
  });
  it.each([null, undefined, NaN, Infinity, -Infinity])('drops a stale score when fresh detail has no finite score: %s', (matchScore) => {
    const detail = { id: 'j1', scoreRevision: 'new', matchScore };
    expect(reconcileFeedWithDetail([{ id: 'j1', scoreRevision: 'old', matchScore: 88 }], detail)[0].matchScore).toBeNull();
  });
  it.each([0, 10, 72, 99, 100])('preserves finite authoritative score exactly, without reclamping: %s', (matchScore) => {
    const detail = { id: 'j1', scoreRevision: 'new', matchScore };
    expect(reconcileFeedWithDetail([{ id: 'j1', scoreRevision: 'old', matchScore: 88 }], detail)[0].matchScore).toBe(matchScore);
  });
});
