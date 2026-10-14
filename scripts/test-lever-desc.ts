import { politeFetchJson } from '../scripts/utils/polite-fetch';

async function testLever() {
  const url = 'https://api.lever.co/v0/postings/spotify?mode=json';
  const data = await politeFetchJson<any>(url);
  const sample = data?.[0];
  console.log('Sample job keys:', Object.keys(sample || {}));
  console.log('descriptionPlain len:', sample?.descriptionPlain?.length);
  console.log('description len:', sample?.description?.length);
}

testLever();
