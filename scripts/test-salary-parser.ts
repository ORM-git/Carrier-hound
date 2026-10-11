import { parseSalary, formatSalary } from '../src/lib/salary/parser';

const testCases = [
  // 1. Mangled cases that should be REJECTED (return null)
  { input: 'EUR 2,007 - 50,00,000', expected: null, desc: 'Corrupted year 2007 with mangled Indian grouping' },
  { input: '$2,025 - 5,00,00,000', expected: null, desc: 'Corrupted year 2025 with mangled Indian grouping' },
  { input: 'CAD 2,027 - 2,027', expected: null, desc: 'Graduation year 2027 repeated' },
  { input: '$2,022', expected: null, desc: 'Copyright year 2022' },
  { input: 'AUD 1,00,000 - 80,00,000', expected: null, desc: 'Mangled user count in London with AUD' },
  { input: '$1,107 - 2,024', expected: null, desc: 'Corrupted min with year 2024' },
  { input: 'Join our 2,500+ team members worldwide', expected: null, desc: 'Team member count' },
  { input: '401(k) matching up to 4%', expected: null, desc: 'Retirement 401(k)' },
  { input: 'Over 50,00,000 active users', expected: null, desc: 'User traffic' },
  { input: 'Founded in 2015 with $50M Series B', expected: null, desc: 'Funding & founding year' },

  // 2. Real valid salary cases that should be ACCEPTED & NORMALIZED
  {
    input: '$120,000 - $160,000',
    expected: { min: 120000, max: 160000, curr: 'USD', period: 'yearly', text: '$120,000 - $160,000 /yr' },
    desc: 'Standard US annual range',
  },
  {
    input: '$140k - $180k / year',
    expected: { min: 140000, max: 180000, curr: 'USD', period: 'yearly', text: '$140,000 - $180,000 /yr' },
    desc: 'US range with k suffix',
  },
  {
    input: 'Base Salary: $150,000 USD',
    expected: { min: 150000, max: 150000, curr: 'USD', period: 'yearly', text: '$150,000 /yr' },
    desc: 'Single salary with label and USD',
  },
  {
    input: '£60,000 - £80,000 per year',
    expected: { min: 60000, max: 80000, curr: 'GBP', period: 'yearly', text: '£60,000 - £80,000 /yr' },
    desc: 'UK GBP salary',
  },
  {
    input: '€65,000 - €85,000',
    expected: { min: 65000, max: 85000, curr: 'EUR', period: 'yearly', text: '€65,000 - €85,000 /yr' },
    desc: 'European EUR salary',
  },
  {
    input: '₹18,00,000 - ₹25,00,000 per annum',
    expected: { min: 1800000, max: 2500000, curr: 'INR', period: 'yearly', text: '₹18,00,000 - ₹25,00,000 /yr' },
    desc: 'Indian INR salary with Indian digit grouping',
  },
  {
    input: '20 - 35 LPA',
    expected: { min: 2000000, max: 3500000, curr: 'INR', period: 'yearly', text: '₹20,00,000 - ₹35,00,000 /yr' },
    desc: 'Indian LPA format',
  },
  {
    input: '$45 - $65 / hour',
    expected: { min: 45, max: 65, curr: 'USD', period: 'hourly', text: '$45 - $65 /hr' },
    desc: 'Hourly rate',
  },
  {
    input: 'CAD $110,000 - $140,000',
    expected: { min: 110000, max: 140000, curr: 'CAD', period: 'yearly', text: 'CA$110,000 - CA$140,000 /yr' },
    desc: 'Canadian CAD salary',
  },
  {
    input: 'AUD $120,000 - $150,000',
    expected: { min: 120000, max: 150000, curr: 'AUD', period: 'yearly', text: 'AU$120,000 - AU$150,000 /yr' },
    desc: 'Australian AUD salary',
  },
  // 3. Full description extraction tests
  {
    input: `About the Role:
We are looking for a Staff Software Engineer to join our Platform team.
Founded in 2015, we have over 2,500 team members and 50,000,000 active users.

Compensation:
The base salary range for this role is $180,000 - $225,000 USD per year.

Benefits:
- 401(k) matching up to 4%
- Comprehensive health, dental, and vision insurance`,
    expected: { min: 180000, max: 225000, curr: 'USD', period: 'yearly', text: '$180,000 - $225,000 /yr' },
    desc: 'Full job description with embedded compensation section',
  },
  {
    input: `About Figma:
We are looking for a Recruiter based in Singapore.
In this role you will partner with hiring managers.
Founded in 2012. We have 1,500 employees worldwide.
&copy; 2022 Figma, Inc. All rights reserved.`,
    expected: null,
    desc: 'Full job description with no salary (only employee count and copyright 2022)',
  },
];

console.log('Running Salary Parser Test Suite...\n');
let passed = 0;
let failed = 0;

for (const t of testCases) {
  const result = parseSalary(t.input);
  if (t.expected === null) {
    if (result.salary_text === null && result.salary_min === null) {
      console.log(`✅ PASS: [${t.desc}] -> Rejected as null as expected`);
      passed++;
    } else {
      console.error(`❌ FAIL: [${t.desc}] -> Expected null but got:`, result);
      failed++;
    }
  } else {
    const isMinMatch = result.salary_min === t.expected.min;
    const isMaxMatch = result.salary_max === t.expected.max;
    const isCurrMatch = result.currency === t.expected.curr;
    const isPeriodMatch = result.salary_period === t.expected.period;
    const isTextMatch = result.salary_text === t.expected.text;

    if (isMinMatch && isMaxMatch && isCurrMatch && isPeriodMatch && isTextMatch) {
      console.log(`✅ PASS: [${t.desc}] -> ${result.salary_text}`);
      passed++;
    } else {
      console.error(`❌ FAIL: [${t.desc}] -> Got:`, result, 'Expected:', t.expected);
      failed++;
    }
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${testCases.length} tests.`);
if (failed > 0) process.exit(1);
