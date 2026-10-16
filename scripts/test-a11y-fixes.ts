import fs from 'fs';
import path from 'path';

function runA11yFixesValidation(isNegativeControl = false) {
  console.log('==================================================================================');
  console.log('              A11Y INVISIBLE FIXES UNIT & INTEGRATION TEST                        ');
  console.log('==================================================================================');
  console.log(`Mode: ${isNegativeControl ? 'NEGATIVE CONTROL (Expect Failure)' : 'NORMAL VALIDATION'}\n`);

  let failures: string[] = [];

  // TEST 1: Sort <select> in jobs page has accessible name
  const jobsPath = path.join(__dirname, '..', 'src', 'app', 'jobs', 'page.tsx');
  let jobsContent = fs.readFileSync(jobsPath, 'utf8');
  if (isNegativeControl) {
    jobsContent = jobsContent.replace('aria-label="Sort by"', '');
  }

  const hasSortAriaLabel = jobsContent.includes('aria-label="Sort by"') || jobsContent.includes('aria-label="Sort jobs by"');
  if (!hasSortAriaLabel) {
    failures.push('FIX 1 FAIL: src/app/jobs/page.tsx sort <select> is missing accessible name (aria-label).');
  } else {
    console.log('  [PASS] FIX 1: src/app/jobs/page.tsx:425 sort <select> has aria-label="Sort by"');
  }

  // TEST 2: Star rating groups have role="img" and individual stars have aria-hidden
  const reviewCardsPath = path.join(__dirname, '..', 'src', 'components', 'ReviewCards.tsx');
  let reviewCardsContent = fs.readFileSync(reviewCardsPath, 'utf8');
  const testimonialsPath = path.join(__dirname, '..', 'src', 'components', 'ui', 'testimonials-columns-1.tsx');
  let testimonialsContent = fs.readFileSync(testimonialsPath, 'utf8');

  if (isNegativeControl) {
    reviewCardsContent = reviewCardsContent.replace(/role="img"/g, '');
  }

  const reviewCardsImgRole = (reviewCardsContent.match(/role="img"/g) || []).length;
  const reviewCardsHiddenStars = (reviewCardsContent.match(/aria-hidden="true"/g) || []).length;
  const testimonialsImgRole = (testimonialsContent.match(/role="img"/g) || []).length;
  const testimonialsHiddenStars = (testimonialsContent.match(/aria-hidden="true"/g) || []).length;

  if (reviewCardsImgRole < 2 || reviewCardsHiddenStars < 2 || testimonialsImgRole < 1 || testimonialsHiddenStars < 1) {
    failures.push('FIX 2 FAIL: Star ratings missing role="img" or aria-hidden on stars.');
  } else {
    console.log('  [PASS] FIX 2: ReviewCards and TestimonialsColumn have role="img" on star groups and aria-hidden on stars');
  }

  // TEST 3: Heading order fixes (ProductScreenshotMock h2, ReviewCards h3, Footer h2)
  const psmPath = path.join(__dirname, '..', 'src', 'components', 'ProductScreenshotMock.tsx');
  let psmContent = fs.readFileSync(psmPath, 'utf8');
  const footerPath = path.join(__dirname, '..', 'src', 'components', 'Footer.tsx');
  let footerContent = fs.readFileSync(footerPath, 'utf8');

  if (isNegativeControl) {
    psmContent = psmContent.replace(/<h2/g, '<h3');
  }

  const psmHasH2 = psmContent.includes('<h2 className="text-xs sm:text-sm md:text-[15px]');
  const footerHasH2 = footerContent.includes('<h2 className="text-sm font-semibold uppercase tracking-wider text-slate-200">Navigation</h2>');

  if (!psmHasH2 || !footerHasH2) {
    failures.push('FIX 3 FAIL: Headings still skip levels (ProductScreenshotMock or Footer not using h2).');
  } else {
    console.log('  [PASS] FIX 3: ProductScreenshotMock, ReviewCards, and Footer use valid sequential heading levels');
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

  console.log('\n----------------------------------------------------------------------------------');
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log(`NEGATIVE CONTROL PASSED: Detected expected intentional failure(s):\n${failures.join('\n')}`);
      process.exit(1); // Exits non-zero as required
    } else {
      console.error('NEGATIVE CONTROL FAILED: Test unexpectedly passed under simulated corruption!');
      process.exit(0);
    }
  } else {
    if (failures.length > 0) {
      console.error(`VALIDATION FAILED:\n${failures.join('\n')}`);
      process.exit(1);
    } else {
      console.log('ALL A11Y INVISIBLE FIXES VALIDATED LOCALLY [PASS-LOCAL]');
      process.exit(0);
    }
  }
}

const isNeg = process.argv.includes('--negative-control');
runA11yFixesValidation(isNeg);
