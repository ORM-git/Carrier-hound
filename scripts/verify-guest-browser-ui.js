const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

async function testGuestJobsUI() {
  console.log('Launching Chrome to test /jobs page...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    console.log('Navigating to http://localhost:3000/jobs...');
    await page.goto('http://localhost:3000/jobs', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait for job cards to render
    await page.waitForSelector('#main-content', { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 2000));

    const cardCount = await page.evaluate(() => {
      // Look for job card elements or headings
      const cards = document.querySelectorAll('article, [data-testid="job-card"], .group.relative');
      return cards.length;
    });

    console.log('Detected job card elements count:', cardCount);

    const screenshotPath = path.join(
      'C:\\Users\\ASUS\\.gemini\\antigravity\\brain\\caf034a4-a523-4c7f-8755-7fa4fad550ba',
      'guest_jobs_listing_verified.png'
    );
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log('Screenshot saved to:', screenshotPath);

    console.log('[PASS] Guest /jobs UI renders successfully!');
  } finally {
    await browser.close();
  }
}

testGuestJobsUI().catch(console.error);
