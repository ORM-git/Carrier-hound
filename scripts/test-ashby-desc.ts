import { politeFetchJson } from '../scripts/utils/polite-fetch';

async function testAshby() {
  const url = 'https://api.ashbyhq.com/posting-api/job-board/openai';
  const data = await politeFetchJson<any>(url);
  const sample = data?.jobs?.[0];
  console.log('Sample job keys:', Object.keys(sample || {}));
  console.log('descriptionPlain len:', sample?.descriptionPlain?.length);
  console.log('descriptionHtml len:', sample?.descriptionHtml?.length);
}

testAshby();
