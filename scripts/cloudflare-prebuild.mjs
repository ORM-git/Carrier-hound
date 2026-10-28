import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isRevert = process.argv.includes('--revert');

const targetFiles = [
  path.join(rootDir, 'src', 'app', 'remote', '[slug]', 'page.tsx'),
  path.join(rootDir, 'src', 'app', 'remote', '[slug]', 'titles', 'page.tsx'),
  path.join(rootDir, 'src', 'app', 'remote', 'jobs', '[category]', 'page.tsx'),
  path.join(rootDir, 'src', 'app', 'jobs', '[id]', 'interview-pack', 'page.tsx'),
  path.join(rootDir, 'src', 'app', 'jobs', '[id]', 'skill-what-if', 'page.tsx'),
];

const RUNTIME_EXPORT = "export const runtime = 'edge';";
const RUNTIME_REGEX = /export\s+const\s+runtime\s*=\s*['"]edge['"];?\r?\n/g;

let modifiedCount = 0;

for (const filePath of targetFiles) {
  if (!fs.existsSync(filePath)) {
    console.warn(`[cloudflare-prebuild] File not found: ${filePath}`);
    continue;
  }

  const content = fs.readFileSync(filePath, 'utf8');

  if (isRevert) {
    if (RUNTIME_REGEX.test(content)) {
      const reverted = content.replace(RUNTIME_REGEX, '');
      fs.writeFileSync(filePath, reverted, 'utf8');
      console.log(`[cloudflare-prebuild] Reverted edge runtime: ${path.relative(rootDir, filePath)}`);
      modifiedCount++;
    } else {
      console.log(`[cloudflare-prebuild] Already clean: ${path.relative(rootDir, filePath)}`);
    }
    continue;
  }

  // Prebuild injection mode
  if (/export\s+const\s+runtime\s*=\s*['"]edge['"]/.test(content)) {
    console.log(`[cloudflare-prebuild] Already configured: ${path.relative(rootDir, filePath)}`);
    continue;
  }

  let updatedContent;
  if (/export const dynamicParams\s*=\s*(false|true);/.test(content)) {
    updatedContent = content.replace(
      /export const dynamicParams\s*=\s*(false|true);/,
      `${RUNTIME_EXPORT}\nexport const dynamicParams = $1;`
    );
  } else if (content.includes('export function generateStaticParams')) {
    updatedContent = content.replace(
      'export function generateStaticParams',
      `${RUNTIME_EXPORT}\nexport function generateStaticParams`
    );
  } else {
    updatedContent = `${RUNTIME_EXPORT}\n${content}`;
  }

  fs.writeFileSync(filePath, updatedContent, 'utf8');
  console.log(`[cloudflare-prebuild] Injected edge runtime: ${path.relative(rootDir, filePath)}`);
  modifiedCount++;
}

const redirectsFile = path.join(rootDir, 'public', '_redirects');
const redirectsBackup = path.join(rootDir, 'public', '_redirects.netlify.bak');

const CLOUDFLARE_REDIRECTS_CONTENT = [
  '# Cloudflare Pages static redirects (no Netlify function proxies, no /* 404 catch-all)',
  '/job-search /jobs 301',
  '/paywall /jobs 301',
  '/jobs/detail /jobs/detail.html 200',
  '/jobs/:id /jobs/detail.html 200',
  '/jobs/* /jobs/detail.html 200',
  '',
].join('\n');

if (isRevert) {
  if (fs.existsSync(redirectsBackup)) {
    fs.copyFileSync(redirectsBackup, redirectsFile);
    fs.unlinkSync(redirectsBackup);
    console.log('[cloudflare-prebuild] Restored Netlify public/_redirects');
    modifiedCount++;
  }
} else {
  if (fs.existsSync(redirectsFile)) {
    if (!fs.existsSync(redirectsBackup)) {
      fs.copyFileSync(redirectsFile, redirectsBackup);
    }
    fs.writeFileSync(redirectsFile, CLOUDFLARE_REDIRECTS_CONTENT, 'utf8');
    console.log('[cloudflare-prebuild] Replaced public/_redirects with Cloudflare-safe routing');
    modifiedCount++;
  }
}

console.log(`[cloudflare-prebuild] Complete (${isRevert ? 'revert' : 'inject'}). Modified ${modifiedCount} file(s)/artifact(s).`);
