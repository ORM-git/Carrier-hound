/** Only for dedicated structured employment-type fields, never descriptions or combined fields. */
import { mapEmploymentType, type CanonicalJobType } from '../../src/lib/jobs/employmentTypeMap';
import { detectJobType } from './sanitizer';

export function sourceEmploymentType(title: string, raw: unknown): CanonicalJobType {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return detectJobType(title);
  return mapEmploymentType(raw).job_type;
}
