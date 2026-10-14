import * as fs from 'fs';

const html = fs.readFileSync('C:/Users/ASUS/.gemini/antigravity/brain/caf034a4-a523-4c7f-8755-7fa4fad550ba/.system_generated/steps/14710/content.md', 'utf-8');

// Find all matches for log URLs or data-log or steps
const matches = html.match(/(?:log|step|stream|archive|annotation)[^"'\s<>]*114607089239[^"'\s<>]*/gi) || [];
console.log('Matches:', matches.slice(0, 20));

// Find script tags containing log or runner or check
const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
for (const s of scripts) {
  if (s.includes('114607089239') || s.includes('Run Job Ingestion Pipeline') || s.includes('exit code')) {
    console.log('Relevant script snippet:', s.slice(0, 500));
  }
}
