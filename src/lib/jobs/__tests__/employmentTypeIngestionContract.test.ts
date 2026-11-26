import { describe, expect, it } from 'vitest';
import { sourceEmploymentType } from '../../../../scripts/utils/sourceEmploymentType';
import { jobTypeOrClause, matchesJobTypeFilter } from '../jobFilters';
import { matchesPostgrestOr } from './postgrestLogicTree';
import { formatJobType } from '../formatJobType';

describe('structured ingestion values through existing employment filters and formatter', () => {
  const rows = [
    ['Full Time', 'full-time', 'Full-time'],
    ['Part time', 'part-time', 'Part-time'],
    ['Contractor', 'contract', 'Contract'],
    ['Intern', 'internship', 'Internship'],
    ['full-time or contract', 'other', null],
    ['unknown', 'other', null],
    [undefined, 'job', null],
  ] as const;
  for (const [raw, stored, label] of rows) {
    it(`stored and formatted value for ${String(raw)}`, () => {
      const actual = sourceEmploymentType('Engineer', raw);
      expect(actual).toBe(stored);
      expect(formatJobType(actual)).toBe(label);
    });
  }
  for (const [selection, expected] of [
    ['Full-time', ['full-time']],
    ['Contract', ['contract']],
    ['Part-time', ['part-time']],
    ['Internship', ['internship']],
    ['Full-time, Contract', ['full-time', 'contract']],
  ] as const) {
    it(`existing server/client filters accept canonical stored values: ${selection}`, () => {
      const values = rows.map(([raw]) => sourceEmploymentType('Engineer', raw));
      const clause = jobTypeOrClause(selection)!;
      // Expected sets are explicit, not generated from the shared filter helper.
      expect(values.filter(job_type => matchesPostgrestOr(clause, { job_type }))).toEqual([...expected]);
      expect(values.filter(value => matchesJobTypeFilter(value, selection))).toEqual([...expected]);
      expect(matchesPostgrestOr(clause, { job_type: null })).toBe(false);
      expect(matchesJobTypeFilter(null, selection)).toBe(false);
    });
  }
});
