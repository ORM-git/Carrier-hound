const fs = require('fs');
const path = require('path');

const html = fs.readFileSync('out/jobs.html', 'utf8');
const regex = /\/_next\/static\/chunks\/[a-zA-Z0-9._-]+\.js/g;
const matches = [...new Set(html.match(regex) || [])];

console.log('--- Scripts on /jobs route ---');
let totalBytes = 0;
for (const scriptPath of matches) {
  const localFile = path.join('out', scriptPath);
  if (fs.existsSync(localFile)) {
    const size = fs.statSync(localFile).size;
    totalBytes += size;
    console.log(`${scriptPath}: ${(size / 1024).toFixed(1)} KB`);
  }
}
console.log('------------------------------');
console.log(`Total initial uncompressed JS: ${(totalBytes / 1024).toFixed(1)} KB (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
