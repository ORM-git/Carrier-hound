import * as fs from 'fs';

const html = fs.readFileSync('C:/Users/ASUS/.gemini/antigravity/brain/caf034a4-a523-4c7f-8755-7fa4fad550ba/.system_generated/steps/14710/content.md', 'utf-8');

const regex = /<script type="application\/json" data-target="react-partial\.embeddedData">([\s\S]*?)<\/script>/g;
let match;
while ((match = regex.exec(html)) !== null) {
  if (match[1].includes('selectedJobId')) {
    console.log('FOUND PROPS:');
    try {
      const parsed = JSON.parse(match[1]);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log(match[1]);
    }
  }
}
