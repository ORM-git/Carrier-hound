import type { RadarCityAggregate } from "@/data/radarCities";

/** Search only observed city/country/company labels, never inferred company coordinates. */
export function searchRadarCities(
  cities: readonly RadarCityAggregate[],
  query: string
): RadarCityAggregate[] {
  const key = query.trim().toLocaleLowerCase();
  return cities.filter(
    (city) =>
      !key ||
      [city.name, city.countryCode, ...city.topCompanies].some((v) =>
        v.toLocaleLowerCase().includes(key)
      )
  );
}

export function radarMarkerSize(count: number): number {
  return Math.max(42, Math.min(82, 34 + Math.log2(Math.max(1, count)) * 4));
}

/** Keep each visible count tied to one city. Overlapping cities remain in List view. */
export function placeFlatRadarCities(
  cities: readonly RadarCityAggregate[],
  width: number,
  height: number
): RadarCityAggregate[] {
  const placed: { x: number; y: number }[] = [];
  return [...cities]
    .sort((a, b) => b.totalCount - a.totalCount)
    .filter((city) => {
      const x = ((city.coordinates[0] + 180) / 360) * width;
      const y = ((90 - city.coordinates[1]) / 180) * height;
      if (placed.some((p) => Math.hypot(x - p.x, y - p.y) < 58)) return false;
      placed.push({ x, y });
      return true;
    });
}
