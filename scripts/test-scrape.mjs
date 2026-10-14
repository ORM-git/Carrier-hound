async function test() {
  try {
    const [jRes, aRes, gRes, sRes] = await Promise.all([
      fetch("https://jobicy.com/api/v2/remote-jobs?count=2").then(r => r.json()),
      fetch("https://api.ashbyhq.com/posting-api/job-board/linear").then(r => r.json()),
      fetch("https://boards-api.greenhouse.io/v1/boards/stripe/jobs").then(r => r.json()),
      fetch("https://api.smartrecruiters.com/v1/companies/visa/postings?limit=2").then(r => r.json())
    ]);
    console.log("Jobicy sample:", {
      title: jRes.jobs[0].jobTitle,
      company: jRes.jobs[0].companyName,
      url: jRes.jobs[0].url,
      type: jRes.jobs[0].jobType
    });
    console.log("Ashby sample (Linear):", {
      title: aRes.jobs[0].title,
      url: aRes.jobs[0].jobUrl,
      compensation: aRes.jobs[0].compensation
    });
    console.log("Greenhouse sample (Stripe):", {
      title: gRes.jobs[0].title,
      url: gRes.jobs[0].absolute_url,
      location: gRes.jobs[0].location?.name
    });
    if (Array.isArray(sRes?.content) && sRes.content.length > 0) {
      console.log("SmartRecruiters (Visa):", {
        name: sRes.content[0].name,
        id: sRes.content[0].id,
        location: sRes.content[0].location
      });
    } else {
      console.log("SmartRecruiters (Visa): empty content[] (totalFound:", sRes?.totalFound ?? 0, ")");
    }
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}
test();
