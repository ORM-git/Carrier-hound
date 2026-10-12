const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function measure() {
  const htmlPath = path.join(__dirname, '../out/index.html');
  if (!fs.existsSync(htmlPath)) {
    console.error("out/index.html not found. Run build first.");
    return;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  let totalDecoded = html.length;
  let totalGzipped = zlib.gzipSync(Buffer.from(html)).length;

  console.log("--------------------------------------------------");
  console.log("HOMEPAGE (out/index.html) INITIAL CRITICAL ASSETS");
  console.log("--------------------------------------------------");
  console.log(`HTML: ${(html.length / 1024).toFixed(2)} KB decoded | ${(totalGzipped / 1024).toFixed(2)} KB gzipped`);

  // Stylesheets
  const styleMatches = [...html.matchAll(/href=["']\/_next\/([^"']+\.css)["']/g)].map(m => m[1]);
  let totalCssDecoded = 0;
  let totalCssGzipped = 0;
  console.log("\nBlocking Stylesheets:");
  styleMatches.forEach(relPath => {
    const fullPath = path.join(__dirname, '../.next', relPath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath);
      const dec = content.length;
      const gz = zlib.gzipSync(content).length;
      totalCssDecoded += dec;
      totalCssGzipped += gz;
      totalDecoded += dec;
      totalGzipped += gz;
      console.log(`  - ${path.basename(relPath)}: ${(dec / 1024).toFixed(2)} KB decoded (${(gz / 1024).toFixed(2)} KB gzip)`);
    }
  });
  console.log(`  TOTAL BLOCKING CSS: ${(totalCssDecoded / 1024).toFixed(2)} KB decoded | ${(totalCssGzipped / 1024).toFixed(2)} KB gzip`);

  // Scripts
  const scriptMatches = [...html.matchAll(/src=["']\/_next\/([^"']+)["']/g)].map(m => m[1]);
  let totalJsDecoded = 0;
  let totalJsGzipped = 0;
  console.log("\nScripts:");
  scriptMatches.forEach(relPath => {
    const fullPath = path.join(__dirname, '../.next', relPath);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath);
      const dec = content.length;
      const gz = zlib.gzipSync(content).length;
      totalJsDecoded += dec;
      totalJsGzipped += gz;
      totalDecoded += dec;
      totalGzipped += gz;
      console.log(`  - ${path.basename(relPath)}: ${(dec / 1024).toFixed(2)} KB decoded (${(gz / 1024).toFixed(2)} KB gzip)`);
    }
  });
  console.log(`  TOTAL JS: ${(totalJsDecoded / 1024).toFixed(2)} KB decoded | ${(totalJsGzipped / 1024).toFixed(2)} KB gzip`);

  console.log("--------------------------------------------------");
  console.log(`TOTAL HOMEPAGE TRANSFER (Decoded): ${(totalDecoded / 1024).toFixed(2)} KB (${totalDecoded} bytes)`);
  console.log(`TOTAL HOMEPAGE TRANSFER (Gzipped): ${(totalGzipped / 1024).toFixed(2)} KB (${totalGzipped} bytes)`);
  console.log("--------------------------------------------------");
}

measure();
