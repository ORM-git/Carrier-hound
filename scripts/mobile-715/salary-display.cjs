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
      res.setHeader('content-type', p.endsWith('.js') ? 'application/javascript; charset=utf-8' : p.endsWith('.css') ? 'text/css; charset=utf-8' : p.endsWith('.png') ? 'image/png' : 'text/html; charset=utf-8');
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
      for(const state of ['free','salary-missing']) {
        await page.goto('http://127.0.0.1:4173/jobs?view=jobs&state='+state,{waitUntil:'load'});
        await page.waitForSelector('[data-testid=job-card]');await new Promise(r=>setTimeout(r,600));
        const body=await page.$eval('body',e=>e.innerText);
        assert(body.includes(state==='free'?'₹1.2 Cr - ₹2 Cr /year':'Not disclosed'));
        assert(!body.includes('₹1,23,45,678'));
        await page.screenshot({path:`reports/mobile-715/salary-${state}-${width}.png`});
        await page.$eval('[data-testid=job-card]',e=>e.click());
        await page.waitForSelector('#company-section');await new Promise(r=>setTimeout(r,400));
        const detail=await page.$eval('body',e=>e.innerText);
        assert(detail.includes(state==='free'?'₹1.2 Cr - ₹2 Cr /year':'Not disclosed'));
        assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
        await page.screenshot({path:`reports/mobile-715/salary-detail-${state}-${width}.png`});
        results.push({width,state,salaryVisible:true,noOverflow:true});
      }
      await page.close();
    }
    fs.writeFileSync('reports/mobile-715/salary-display.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally { await browser.close(); server.close(); }
})();
