async function fetchBatch() {
  try {
    const res = await fetch('https://github.com/suryakant-source/Carrier-hound/actions/runs/38185588418/job_groups_batch?attempt=1', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Response:', text.slice(0, 1000));
  } catch (err) {
    console.error('Error:', err);
  }
}
fetchBatch();
