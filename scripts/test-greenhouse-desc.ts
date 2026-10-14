import { politeFetchJson } from '../scripts/utils/polite-fetch';

async function testGreenhouse() {
  const url = 'https://boards-api.greenhouse.io/v1/boards/datadog/jobs?content=true';
  const data = await politeFetchJson<any>(url);
  const sample = data?.jobs?.[0];
  console.log('Sample job keys:', Object.keys(sample || {}));
  console.log('Sample content type:', typeof sample?.content);
  console.log('Sample content length:', sample?.content?.length);
  console.log('Sample content snippet:', sample?.content?.slice(0, 300));
}

testGreenhouse();
