// Show exactly half of the second listing (it matches the first card's height).
// Port of the inline script in ORM-git/ssampe index.html @ f21504b; returns a cleanup for unmount.
export function initCareerMonkeLanding(): () => void {
  if (typeof window === "undefined" || typeof ResizeObserver === "undefined") return () => {};
  const first = document.getElementById("first-card");
  const peek = document.querySelector<HTMLElement>(".landing-wrapper .peek");
  if (!first || !peek) return () => {};

  const set = () => peek.style.setProperty("--peek-h", Math.round(first.offsetHeight * 0.5 + 28) + "px"); // +28 = area hidden under the CTA overlap
  set();
  const ro = new ResizeObserver(set);
  ro.observe(first);
  return () => ro.disconnect();
}
