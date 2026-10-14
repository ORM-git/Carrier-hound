async function fetchCheckRun() {
  try {
    const res = await fetch('https://api.github.com/repos/suryakant-source/Carrier-hound/check-runs/114607089239', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await res.json();
    console.log('Check run output:', JSON.stringify(data.output, null, 2));

    const resAnn = await fetch('https://api.github.com/repos/suryakant-source/Carrier-hound/check-runs/114607089239/annotations', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const annData = await resAnn.json();
    console.log('Annotations:', JSON.stringify(annData, null, 2));
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

fetchCheckRun();
