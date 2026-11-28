import { describe, expect, it } from "vitest";
import { searchRadarCities, radarMarkerSize } from "./radarView";
import type { RadarCityAggregate } from "@/data/radarCities";
const cities: RadarCityAggregate[] = [
  {
    id: "b",
    name: "Bengaluru",
    countryCode: "IN",
    region: "asia_pac",
    coordinates: [77, 12],
    totalCount: 23,
    verifiedCount: 20,
    topCompanies: ["Acme"],
  },
  {
    id: "l",
    name: "London",
    countryCode: "GB",
    region: "europe",
    coordinates: [0, 51],
    totalCount: 111,
    verifiedCount: 100,
    topCompanies: ["Example"],
  },
];
describe("radar discovery controls", () => {
  it("preserves all city records and counts for empty search", () =>
    expect(searchRadarCities(cities, "  ")).toEqual(cities));
  it("searches city names case insensitively", () =>
    expect(searchRadarCities(cities, "  BENG  ")).toEqual([cities[0]]));
  it("searches country codes", () => expect(searchRadarCities(cities, "gb")).toEqual([cities[1]]));
  it("searches only observed top company labels", () =>
    expect(searchRadarCities(cities, "acme")).toEqual([cities[0]]));
  it("does not invent missing company coordinates", () =>
    expect(searchRadarCities(cities, "unknown")).toEqual([]));
  it("does not change source city data", () => {
    const before = JSON.stringify(cities);
    searchRadarCities(cities, "acme");
    expect(JSON.stringify(cities)).toBe(before);
  });
  it("keeps small count discs readable", () =>
    expect(radarMarkerSize(1)).toBeGreaterThanOrEqual(42));
  it("caps large count discs", () => expect(radarMarkerSize(1000000)).toBe(82));
  it("uses monotonic size rather than fabricated counts", () =>
    expect(radarMarkerSize(1000)).toBeGreaterThan(radarMarkerSize(10)));
});

import { placeFlatRadarCities } from "./radarView";
describe("flat map collision placement", () => {
  it("keeps original city counts rather than making synthetic groups", () => {
    expect(placeFlatRadarCities(cities, 1000, 600)).toEqual([cities[1], cities[0]]);
  });
  it("prefers the larger city when discs overlap", () => {
    const near = { ...cities[0], coordinates: [0.01, 51.01] as [number, number] };
    expect(placeFlatRadarCities([near, cities[1]], 1000, 600)).toEqual([cities[1]]);
  });
  it("reveals nearby cities with enough zoom", () => {
    const near = { ...cities[0], coordinates: [10, 51] as [number, number] };
    expect(placeFlatRadarCities([near, cities[1]], 1000, 600)).toHaveLength(1);
    expect(placeFlatRadarCities([near, cities[1]], 4000, 2400)).toHaveLength(2);
  });
  it("does not mutate source sort order", () => {
    placeFlatRadarCities(cities, 1000, 600);
    expect(cities[0].id).toBe("b");
  });
});
