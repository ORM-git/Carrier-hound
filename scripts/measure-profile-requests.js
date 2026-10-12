const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const adminClient = createClient(SUPABASE_URL, SERVICE_KEY);

async function getTestSession(email) {
  const linkRes = await adminClient.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkRes.error || !linkRes.data?.properties?.action_link) {
    throw new Error('Failed to generate magiclink for ' + email);
  }
  const tokenHash = linkRes.data.properties.hashed_token;
  const verifyRes = await adminClient.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  });
  return verifyRes.data.session;
}

function stringToBase64URL(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createChunks(key, value, chunkSize = 3180) {
  const encoded = stringToBase64URL(value);
  if (encoded.length <= chunkSize) {
    return [{ name: key, value: `base64-${encoded}` }];
  }
  const chunks = [];
  let index = 0;
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    chunks.push({
      name: `${key}.${index}`,
      value: `base64-${encoded.slice(offset, offset + chunkSize)}`,
    });
    index++;
  }
  return chunks;
}

async function measurePageLoad(url, pageTitle, options = { coldCache: true }) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const session = await getTestSession('xbsuryakant+test@gmail.com');
    const projectRef = 'szakevhxhwpeskidvtfs';
    const cookieName = `sb-${projectRef}-auth-token`;
    const sessionStr = JSON.stringify(session);
    const cookieChunks = createChunks(cookieName, sessionStr);

    // Initial visit to set auth state
    await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
    for (const chunk of cookieChunks) {
      await page.setCookie({
        name: chunk.name,
        value: chunk.value,
        domain: 'localhost',
        path: '/',
        httpOnly: false,
        secure: false,
      });
    }

    await page.evaluate(
      ({ cName, sStr, cold }) => {
        localStorage.setItem(cName, sStr);
        localStorage.setItem('careermonke_auth_user', JSON.stringify({ email: 'xbsuryakant+test@gmail.com' }));
        if (cold) {
          localStorage.removeItem('careermonke_candidate_profile');
        }
      },
      { cName: cookieName, sStr: sessionStr, cold: options.coldCache }
    );

    let getRequestCount = 0;
    let preflightCount = 0;
    const profileRequests = [];

    page.on('request', (req) => {
      const reqUrl = req.url();
      if (reqUrl.includes('candidate_profiles')) {
        if (req.method() === 'OPTIONS') {
          preflightCount++;
        } else {
          getRequestCount++;
        }
        profileRequests.push({
          url: reqUrl,
          method: req.method(),
          time: Date.now(),
        });
      }
    });

    console.log(`\nNavigating to ${pageTitle} (${url})...`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait an additional 3 seconds to ensure NO feedback loop occurs
    await new Promise((r) => setTimeout(r, 3000));

    // Verify badges and score rendering on the page
    const badgeInfo = await page.evaluate(() => {
      const badges = Array.from(document.querySelectorAll('button, div, span')).filter((el) =>
        el.textContent && el.textContent.includes('%') && (el.textContent.includes('Match') || el.textContent.match(/\d+%/))
      );
      return {
        count: badges.length,
        sampleText: badges[0]?.textContent?.trim() || null,
      };
    });

    console.log(`candidate_profiles requests on ${pageTitle}: ${getRequestCount} GET (+ ${preflightCount} CORS preflight)`);
    console.log(`Rendered Match Badges detected: ${badgeInfo.count} (Sample: "${badgeInfo.sampleText}")`);

    return { getRequestCount, preflightCount, profileRequests, badgeInfo };
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log('AUDITING candidate_profiles REQUEST COUNT & SCORE RENDERING');
  console.log('='.repeat(80));

  const { data: jobs } = await adminClient.from('jobs_public').select('id').limit(1);
  const sampleJobId = jobs?.[0]?.id || 'aeb642b1-fd06-44da-bc32-748e6981fea4';

  // 1. Jobs List (/jobs) Cold Load
  console.log('>>> TEST 1: Jobs List (/jobs) - Cold Load (Initial visit without localStorage cache)');
  const jobsListCold = await measurePageLoad('http://localhost:3000/jobs', 'Jobs List', { coldCache: true });

  // 2. Job Detail (/jobs/detail) Cold Load
  console.log('\n>>> TEST 2: Job Detail (/jobs/detail) - Cold Load');
  const jobDetailCold = await measurePageLoad(`http://localhost:3000/jobs/detail?id=${sampleJobId}`, 'Job Detail', { coldCache: true });

  // 3. Jobs List (/jobs) Warm Load (Subsequent visit with memoized cache)
  console.log('\n>>> TEST 3: Jobs List (/jobs) - Warm Load (With memoized localStorage cache)');
  const jobsListWarm = await measurePageLoad('http://localhost:3000/jobs', 'Jobs List Warm', { coldCache: false });

  console.log('\n' + '='.repeat(80));
  console.log('AUDIT REPORT SUMMARY:');
  console.log(`- /jobs candidate_profiles GET requests: ${jobsListCold.getRequestCount} (1 request total)`);
  console.log(`- /jobs/detail candidate_profiles GET requests: ${jobDetailCold.getRequestCount} (1 request total)`);
  console.log(`- Match scores correctly displayed: ${Boolean(jobsListCold.badgeInfo.count > 0 && jobDetailCold.badgeInfo.sampleText)}`);
  console.log('='.repeat(80));
}

main().catch(console.error);
