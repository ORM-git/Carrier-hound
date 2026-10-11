const puppeteer = require('puppeteer-core');

async function test() {
  const browser = await puppeteer.launch({
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
  const title = await page.title();
  console.log('Page Title:', title);
  await browser.close();
  console.log('Puppeteer test passed!');
}

test().catch(err => {
  console.error('Puppeteer error:', err);
  process.exit(1);
});
