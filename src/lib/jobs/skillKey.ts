/**
 * Exact-match key for a skill name, defined so JavaScript and Postgres produce the same bytes:
 *   1. every run of ASCII whitespace (space, \t, \n, \r, \f, \v) becomes one space
 *   2. leading and trailing spaces are removed
 *   3. ASCII letters A-Z are lowercased
 * Nothing else changes. Non-ASCII characters (accents, NBSP, other scripts) are kept byte for byte and compared
 * case-sensitively, so no locale, ICU or Unicode-version difference can make the two sides disagree.
 * No length cut here (saved lists are already capped by normalizeTextList when stored).
 *
 * Postgres equivalent (IMMUTABLE, no locale dependence):
 *   translate(btrim(regexp_replace(s, E'[ \t\n\r\f\v]+', ' ', 'g'), ' '),
 *             'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
 * Both are tested against __tests__/fixtures/skill-key-cases.json.
 */
export function skillKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[ \t\n\r\f\v]+/g, " ")
    .replace(/^ +| +$/g, "")
    .replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** True when the job lists any of the excluded skills (exact key match). An empty job list never matches (unknown is kept). */
export function jobHasAnySkill(jobSkills: unknown, wanted: readonly string[]): boolean {
  if (!Array.isArray(jobSkills) || !wanted.length) return false;
  const set = new Set(wanted.map(skillKey).filter(Boolean));
  return jobSkills.some((s) => set.has(skillKey(s)));
}

export const MAX_SKILLS = 50;
export const MAX_SKILL_LENGTH = 100;

/**
 * Saved skill list. Uses the SAME key as matching, so what is stored, de-duplicated and compared is one thing:
 * entries are cleaned with the ASCII-whitespace rule (spelling of the first occurrence kept), duplicates are decided
 * by skillKey (so "React" and " react " are one, but "Réact"/"React" and NBSP variants stay distinct, exactly as
 * they will match), each entry is cut at 100 characters without splitting a surrogate pair, and the list at 50.
 */
export function normalizeSkillList(values: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(values) ? values : []) {
    if (typeof raw !== "string") continue;
    let v = raw.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ +| +$/g, "");
    if (v.length > MAX_SKILL_LENGTH) {
      v = v.slice(0, MAX_SKILL_LENGTH);
      const last = v.charCodeAt(v.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) v = v.slice(0, -1); // never leave half a surrogate pair
      v = v.replace(/ +$/g, "");
    }
    const key = skillKey(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
}
