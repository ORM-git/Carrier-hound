const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.next') {
        results = results.concat(walk(fullPath));
      }
    } else if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
      results.push(fullPath);
    }
  });
  return results;
}

const files = walk('./src');
const matches = [];
files.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  const lines = content.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes(".from('jobs'") || line.includes('.from("jobs"') || line.includes(".from('jobs_public'") || line.includes('.from("jobs_public"') || line.includes("JOBS_TABLE") || line.includes("'jobs'") || line.includes('"jobs"')) {
      if (line.includes("from") && (line.includes("jobs") || line.includes("jobs_public"))) {
        matches.push({ file: f, line: idx + 1, content: line.trim() });
      }
    }
  });
});
console.log(JSON.stringify(matches, null, 2));
