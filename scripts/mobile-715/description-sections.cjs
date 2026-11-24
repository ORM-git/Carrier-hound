const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const puppeteer = require('puppeteer-core');
(async () => {
  const root = process.cwd();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/jobs') p = '/reports/mobile-715/index.html';
    if (p.startsWith('/careermonke') || p === '/icon.png') p = '/public' + p;
    try {
      res.setHeader('content-type', p.endsWith('.js') ? 'application/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.png') ? 'image/png' : 'text/html');
      res.end(fs.readFileSync(path.join(root, p)));
    } catch { res.statusCode = 404; res.end('Not found'); }
  });
  await new Promise(r => server.listen(4173, '127.0.0.1', r));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const results = [];
  try {
    for (const width of [360, 390, 768, 1440]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 1000 });
      await page.setRequestInterception(true);
      page.on('request', r => r.url().startsWith('http://127.0.0.1:4173/') || r.url().startsWith('data:') ? r.continue() : r.abort());
      await page.goto('http://127.0.0.1:4173/jobs?view=jobs&state=sections', {waitUntil:'load'});
      await page.waitForSelector('[data-testid=job-card]');
      await page.$eval('[data-testid=job-card]', el=>el.click());
      await page.waitForSelector('#company-section');
      await new Promise(r=>setTimeout(r,700));
      await page.addStyleTag({content:"html,body{scroll-behavior:auto!important}"});
      const check=await page.evaluate(()=>{
        const h=[...document.querySelectorAll('h2')];
        const company=h.find(el=>el.textContent==='Company');
        const benefits=h.find(el=>el.textContent==='Benefits');
        const qualifications=h.find(el=>el.textContent==='Qualifications');
        const responsibilities=h.find(el=>el.textContent==='Responsibilities');
        benefits?.scrollIntoView({block:'start',behavior:'instant'});
        window.scrollBy(0,-220);
        return {hasSections:!!(company&&benefits&&qualifications&&responsibilities),order:h.map(el=>el.textContent),overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert(check.hasSections);assert(!check.overflow);
      assert.equal(check.order.indexOf('Company'),check.order.indexOf('Benefits')+1);
      await new Promise(r=>setTimeout(r,350));
      await page.screenshot({path:`reports/mobile-715/sections-${width}.png`});
      await page.evaluate(()=>{[...document.querySelectorAll('h2')].find(e=>e.textContent==='Responsibilities').scrollIntoView({block:'start',behavior:'instant'});window.scrollBy(0,-220);});
      await new Promise(r=>setTimeout(r,350));
      await page.screenshot({path:`reports/mobile-715/sections-top-${width}.png`});
      results.push({width,...check});
      await page.close();
    }
    fs.writeFileSync('reports/mobile-715/description-sections.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally { await browser.close(); server.close(); }
})();
