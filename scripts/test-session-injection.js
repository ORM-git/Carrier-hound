const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

async function test() {
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: { session }, error } = await s.auth.signInWithPassword({
    email: 'xbsuryakant+test@gmail.com',
    password: 'TestPassword123!'
  });

  if (error || !session) {
    throw new Error('Failed to sign in via node: ' + error?.message);
  }

  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  // 1. Navigate to origin to access localStorage
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });

  // 2. Set Supabase session in localStorage
  await page.evaluate((sess) => {
    localStorage.setItem('sb-szakevhxhwpeskidvtfs-auth-token', JSON.stringify(sess));
    localStorage.setItem('careermonke_user_email', sess.user.email);
  }, session);

  // 3. Now navigate to /dashboard
  await page.goto('http://localhost:3000/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  const url = page.url();
  console.log('Navigated URL after setting session:', url);
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log('Dashboard text snippet:', bodyText.replace(/\n+/g, ' '));

  await browser.close();
}

test().catch(e => {
  console.error(e);
  process.exit(1);
});
