/**
 * src/lib/companies/logoVisibility.ts
 *
 * Is a decoded logo actually readable on the tile it is shown on? Browser-safe and shared by the repair
 * worker (sharp-decoded bytes, before upload) and CompanyLogo / the landing ticker (canvas pixels, after
 * load), so a transparent, all-white or faint-white image never becomes an empty-looking tile.
 *
 * Each pixel is composited over the tile background and counted as VISIBLE when its WCAG contrast ratio
 * against that background is at least MIN_PIXEL_CONTRAST. A logo passes only if, on EVERY light tile we
 * render, at least MIN_VISIBLE_COVERAGE of the (contain-fitted) tile area is visible. Light logos that fail
 * get initials, never a recoloured or invented mark.
 */

export type Rgb = readonly [number, number, number];

/** The light backings logos sit on: card tiles pass bg-white, CompanyLogo defaults to slate-50, the ticker uses #F4F4F5. */
export const LOGO_TILE_BACKGROUNDS: readonly Rgb[] = [
  [255, 255, 255], // bg-white (job cards, detail header, Company tab, related jobs, tracker)
  [248, 250, 252], // bg-slate-50 (CompanyLogo default: Radar, Top 10)
  [244, 244, 245], // #F4F4F5 (landing ticker)
];

/** Size of the square the image is contain-fitted into before measuring (both server and client). */
export const LOGO_SAMPLE_PX = 64;
/** A pixel this close to the tile colour is not seen. 1.5:1 keeps light-grey/pastel marks, drops near-white. */
export const MIN_PIXEL_CONTRAST = 1.5;
/** At least 2% of the tile must be visibly painted (82 of 4096 px): a speck or hairline reads as empty. */
export const MIN_VISIBLE_COVERAGE = 0.02;
/** Alpha at or above this counts as painted, for the "transparent" diagnosis. */
const PAINTED_ALPHA = 32;

const LIN = Array.from({ length: 256 }, (_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const lum = (r: number, g: number, b: number) => 0.2126 * LIN[r] + 0.7152 * LIN[g] + 0.0722 * LIN[b];

export type LogoVisibility = { ok: true; painted: number; visible: number } | { ok: false; reason: string; painted: number; visible: number };

/** `rgba` is straight (non-premultiplied) RGBA, row-major, `width * height * 4` bytes. */
export function logoVisibility(rgba: ArrayLike<number>, width: number, height: number, backgrounds: readonly Rgb[] = LOGO_TILE_BACKGROUNDS): LogoVisibility {
  const n = width * height;
  if (!n || rgba.length < n * 4) return { ok: false, reason: "empty-image", painted: 0, visible: 0 };
  let paintedPx = 0;
  const visiblePx = backgrounds.map(() => 0);
  const bgLum = backgrounds.map(([r, g, b]) => lum(r, g, b));
  for (let i = 0; i < n * 4; i += 4) {
    const a = rgba[i + 3];
    if (a >= PAINTED_ALPHA) paintedPx++;
    if (a === 0) continue;
    const t = a / 255;
    backgrounds.forEach(([br, bg, bb], k) => {
      const L = lum(Math.round(rgba[i] * t + br * (1 - t)), Math.round(rgba[i + 1] * t + bg * (1 - t)), Math.round(rgba[i + 2] * t + bb * (1 - t)));
      const ratio = (Math.max(L, bgLum[k]) + 0.05) / (Math.min(L, bgLum[k]) + 0.05);
      if (ratio >= MIN_PIXEL_CONTRAST) visiblePx[k]++;
    });
  }
  const painted = paintedPx / n;
  const visible = Math.min(...visiblePx) / n;
  if (painted < MIN_VISIBLE_COVERAGE) return { ok: false, reason: `transparent: ${(painted * 100).toFixed(1)}% painted`, painted, visible };
  if (visible < MIN_VISIBLE_COVERAGE) return { ok: false, reason: `invisible-on-tile: ${(visible * 100).toFixed(1)}% visible on a light tile`, painted, visible };
  return { ok: true, painted, visible };
}
