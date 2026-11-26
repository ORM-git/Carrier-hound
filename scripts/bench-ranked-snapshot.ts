/**
 * Phase 0 local benchmark: rankJobsByRecommendation + capJobsPerCompany over N synthetic rows shaped like the
 * recommended route's candidate columns (with description/skills, the resume path's heaviest input).
 * Offline: no DB, no network. Run: npx tsx scripts/bench-ranked-snapshot.ts [N ...]
 */
import { rankJobsByRecommendation } from "../src/lib/jobs/recommendations";
import { capJobsPerCompany } from "../src/lib/jobs/capping";

const TITLES = ["Senior Software Engineer", "Frontend Engineer", "Data Analyst", "Product Manager", "Junior React Developer",
  "DevOps Engineer", "Sales Executive", "Machine Learning Engineer", "Backend Developer (Node.js)", "Customer Success Manager"];
const SKILLS = ["React", "TypeScript", "Node.js", "Python", "SQL", "AWS", "Kubernetes", "Go", "Figma", "Excel"];
const LOCS = ["Bengaluru, India", "Remote (Worldwide)", "London, UK", "New York, NY", "Hybrid - Pune"];

function rows(n: number, now: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    title: TITLES[i % TITLES.length] + (i % 7 === 0 ? " II" : ""),
    company: `Company ${i % 997}`,
    company_id: `co-${i % 997}`,
    location: LOCS[i % LOCS.length],
    remote: i % 5 === 1, remote_scope: i % 5 === 1 ? "worldwide" : "onsite", remote_eligibility: "unknown",
    job_type: i % 13 === 0 ? "internship" : "full-time",
    salary_min: i % 3 ? 800000 + (i % 50) * 10000 : null, salary_max: null, salary_text: null, salary_period: "yearly", currency: "INR",
    posted_at: new Date(now - (i % 2000) * 3600e3).toISOString(), created_at: null, first_seen_at: null,
    category: i % 4 ? "engineering" : "data", country: "India", country_code: i % 3 ? "IN" : "US",
    description: `We are hiring. ${SKILLS.slice(i % 5, (i % 5) + 4).join(", ")} experience required. `.repeat(20),
    skills: SKILLS.slice(i % 6, (i % 6) + 4),
  }));
}

const answers = {
  roles: ["Software Engineer", "Frontend Engineer"], experienceLevel: "mid", remotePreference: "any",
  locations: ["Bengaluru"], employmentTypes: ["full-time"], categories: ["engineering"], countryCode: "IN",
  resumeProfile: { jobTitles: ["Frontend Engineer"], skills: ["React", "TypeScript", "Node.js"], yearsOfExperience: 4 },
};

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
for (const n of sizes.length ? sizes : [1000, 10000, 50000, 100000]) {
  const now = Date.now();
  const input = rows(n, now);
  global.gc?.();
  const heap0 = process.memoryUsage().heapUsed;
  const times: number[] = [];
  let kept = 0;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    const ranked = rankJobsByRecommendation(input, answers, now).filter((j) => (j.matchScore ?? 0) > 0);
    const capped = capJobsPerCompany(ranked, 3, 30);
    times.push(performance.now() - t0);
    kept = capped.length;
  }
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1048576;
  const idBytes = kept * 37; // uuid text + separator, the snapshot payload
  console.log(JSON.stringify({ n, kept, msMin: +Math.min(...times).toFixed(1), msMax: +Math.max(...times).toFixed(1), heapDeltaMb: +heapMb.toFixed(1), snapshotIdBytes: idBytes }));
}
