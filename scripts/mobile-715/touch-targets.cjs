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
    for (const width of [360, 390, 768]) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: 1000 });
      await page.setRequestInterception(true);
      page.on('request', r => r.url().startsWith('http://127.0.0.1:4173/') || r.url().startsWith('data:') ? r.continue() : r.abort());
      for (const view of ['step1', 'filters']) {
        await page.goto(`http://127.0.0.1:4173/jobs?view=${view}&state=long`, { waitUntil: 'load' });
        await page.waitForFunction(() => [...document.querySelectorAll('button[aria-label^="Remove "]')].some(b => b.offsetHeight));
        const check = await page.evaluate(view => {
          const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetHeight && (b.getAttribute('aria-label')?.startsWith('Remove ') || b.textContent.trim() === 'Clear all'));
          const rows = [];
          for (const b of buttons) {
            b.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = b.getBoundingClientRect();
            const misses = [];
            for (const [dx, dy] of [[1, 1], [r.width - 1, 1], [1, r.height - 1], [r.width - 1, r.height - 1], [r.width / 2, r.height / 2]]) {
              const hit = document.elementFromPoint(r.left + dx, r.top + dy);
              if (hit?.closest('button') !== b) misses.push({ dx, dy, hit: hit?.closest('button')?.getAttribute('aria-label') || hit?.tagName });
            }
            rows.push({ name: b.getAttribute('aria-label') || b.textContent.trim(), width: r.width, height: r.height, misses });
          }
          return { rows, overflow: document.documentElement.scrollWidth > innerWidth };
        }, view);
        assert(!check.overflow, JSON.stringify({ width, view, ...check }));
        for (const row of check.rows) {
          assert(row.width >= 44 && row.height >= 44, JSON.stringify({ width, view, row }));
          assert.equal(row.misses.length, 0, JSON.stringify({ width, view, row }));
        }
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: `reports/mobile-715/touch-${view}-${width}.png`, fullPage: true });
        results.push({ width, view, ...check, pass: true });
      }
      await page.close();
    }
    fs.writeFileSync('reports/mobile-715/touch-targets.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally { await browser.close(); server.close(); }
})();
