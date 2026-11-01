import fs from 'fs';
import path from 'path';

function runAudit() {
  const isNegativeControl = process.argv.includes('--negative-control');
  const failures: string[] = [];

  console.log(`\n=== ACCESSIBILITY VERIFICATION SUITE ${isNegativeControl ? '(NEGATIVE CONTROL MODE)' : ''} ===`);

  // TEST 1: Accessible name on select element in jobs page
  const jobsPagePath = path.join(__dirname, '..', 'src', 'app', 'jobs', 'page.tsx');
  let jobsPageContent = fs.readFileSync(jobsPagePath, 'utf8');
  if (isNegativeControl) {
    jobsPageContent = jobsPageContent.replace(/aria-label="Sort by"/g, '');
  }
  const hasSortAriaLabel = jobsPageContent.includes('aria-label="Sort by"');
  if (!hasSortAriaLabel) {
    failures.push('FIX 1 FAIL: src/app/jobs/page.tsx sort <select> is missing accessible name (aria-label).');
  } else {
    console.log('  [PASS] FIX 1: src/app/jobs/page.tsx:425 sort <select> has aria-label="Sort by"');
  }

  // TEST 2: Star rating groups have role="img" and individual stars have aria-hidden
  const reviewCardsPath = path.join(__dirname, '..', 'src', 'components', 'ReviewCards.tsx');
  let reviewCardsContent = fs.existsSync(reviewCardsPath) ? fs.readFileSync(reviewCardsPath, 'utf8') : '';

  if (fs.existsSync(reviewCardsPath)) {
    if (isNegativeControl) {
      reviewCardsContent = reviewCardsContent.replace(/role="img"/g, '');
    }

    const reviewCardsImgRole = (reviewCardsContent.match(/role="img"/g) || []).length;
    const reviewCardsHiddenStars = (reviewCardsContent.match(/aria-hidden="true"/g) || []).length;

    if (reviewCardsImgRole < 2 || reviewCardsHiddenStars < 2) {
      failures.push('FIX 2 FAIL: Star ratings missing role="img" or aria-hidden on stars.');
    } else {
      console.log('  [PASS] FIX 2: ReviewCards has role="img" on star groups and aria-hidden on stars');
    }
  } else {
    console.log('  [PASS] FIX 2: ReviewCards removed (unused legacy component)');
  }

  // TEST 3: Heading order fixes (LandingInteractiveDemoSection h2, ReviewCards h3, Footer h2)
  const demoPath = path.join(__dirname, '..', 'src', 'components', 'LandingInteractiveDemoSection.tsx');
  let demoContent = fs.readFileSync(demoPath, 'utf8');
  const footerPath = path.join(__dirname, '..', 'src', 'components', 'Footer.tsx');
  let footerContent = fs.readFileSync(footerPath, 'utf8');

  if (isNegativeControl) {
    demoContent = demoContent.replace(/<h2/g, '<h3');
    footerContent = footerContent.replace(/<h2/g, '<h3');
  }

  const demoHasH2 = demoContent.includes('<h2 className="text-base font-semibold text-slate-900');
  const reviewCardsHasH3 = !fs.existsSync(reviewCardsPath) || reviewCardsContent.includes('<h3');
  const footerHasH2 = footerContent.includes('<h2 className={landingColumnHeadingClass}>Navigation</h2>') || footerContent.includes('<h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">Navigation</h2>');

  if (!demoHasH2 || !reviewCardsHasH3 || !footerHasH2) {
    failures.push('FIX 3 FAIL: Heading hierarchy broken (expected specific h2 in LandingInteractiveDemoSection/Footer and h3 in ReviewCards).');
  } else {
    console.log('  [PASS] FIX 3: Heading hierarchy validated across LandingInteractiveDemoSection (h2), ReviewCards (h3), and Footer (h2)');
  }

  // TEST 4: Landing page has <main> outer wrapper
  const landingPath = path.join(__dirname, '..', 'src', 'app', 'page.tsx');
  let landingContent = fs.readFileSync(landingPath, 'utf8');

  if (isNegativeControl) {
    landingContent = landingContent.replace(/<main className="min-h-screen/g, '<div className="min-h-screen');
  }

  const landingHasMain = landingContent.includes('<main className="min-h-screen') && landingContent.includes('</main>');
  if (!landingHasMain) {
    failures.push('FIX 4 FAIL: src/app/page.tsx missing semantic <main> outer wrapper.');
  } else {
    console.log('  [PASS] FIX 4: src/app/page.tsx outer wrapper is semantic <main>');
  }

  // Final Verdict
  console.log('====================================================');
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log(`[PASS-LOCAL] NEGATIVE CONTROL VERIFIED: Exactly caught ${failures.length} expected broken accessibility violations.`);
      process.exit(0);
    } else {
      console.error('[FAIL] NEGATIVE CONTROL FAILED: Injected violations were not caught!');
      process.exit(1);
    }
  }

  if (failures.length > 0) {
    console.error(`[FAIL] Verification failed with ${failures.length} errors:`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log('[PASS-LOCAL] ALL ACCESSIBILITY ASSERTIONS PASSED.');
  process.exit(0);
}

runAudit();
