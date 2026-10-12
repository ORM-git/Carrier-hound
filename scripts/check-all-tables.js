const fs = require('fs');
const path = require('path');

function walk(dir) {
  let results = [];
  fs.readdirSync(dir).forEach(file => {
    const full = path.join(dir, file);
    if (fs.statSync(full).isDirectory()) {
      if (file !== 'node_modules' && file !== '.next') results.push(...walk(full));
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      results.push(full);
    }
  });
  return results;
}

const files = walk('./src');
const fromCalls = new Map();
files.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  const matches = content.match(/\.from\(['"][a-zA-Z0-9_-]+['"]\)/g);
  if (matches) {
    matches.forEach(m => {
      const list = fromCalls.get(m) || [];
      list.push(f);
      fromCalls.set(m, list);
    });
  }
});
for (const [table, flist] of fromCalls.entries()) {
  console.log(table, '->', flist.length, 'files:', flist);
}
