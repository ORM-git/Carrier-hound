/**
 * Trusted Geo Registry & Location Normalizer for CareerMonke 3D Radar.
 * Coordinates are [longitude, latitude] in degrees.
 */

export interface GeoLocation {
  id: string;
  name: string;
  countryCode: string; // ISO 3166-1 alpha-2 (e.g. US, IN, GB)
  region: 'americas' | 'europe' | 'asia_pac' | 'global';
  coordinates: [number, number]; // [lng, lat]
  aliases?: string[];
}

export interface ResolvedLocation {
  type: 'city' | 'country' | 'worldwide_remote' | 'unlocated';
  id: string;
  name: string;
  countryCode: string | null;
  region: 'americas' | 'europe' | 'asia_pac' | 'global';
  coordinates: [number, number] | null;
}

// 1. Curated Tech Hub Cities with precise coordinates
export const TRUSTED_CITIES: GeoLocation[] = [
  // North America
  {
    id: 'sf-bay',
    name: 'San Francisco',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-122.4194, 37.7749],
    aliases: ['sf', 'san francisco', 'san jose', 'oakland', 'palo alto', 'mountain view', 'sunnyvale', 'santa clara', 'redwood city', 'san mateo', 'berkeley', 'fremont', 'menlo park', 'cupertino', 'bay area', 'south san francisco'],
  },
  {
    id: 'nyc',
    name: 'New York',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-74.006, 40.7128],
    aliases: ['new york', 'new york city', 'nyc', 'brooklyn', 'manhattan', 'queens'],
  },
  {
    id: 'seattle',
    name: 'Seattle',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-122.3321, 47.6062],
    aliases: ['seattle', 'bellevue', 'redmond', 'kirkland'],
  },
  {
    id: 'austin',
    name: 'Austin',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-97.7431, 30.2672],
    aliases: ['austin', 'round rock'],
  },
  {
    id: 'boston',
    name: 'Boston',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-71.0589, 42.3601],
    aliases: ['boston', 'cambridge', 'somerville', 'waltham'],
  },
  {
    id: 'los-angeles',
    name: 'Los Angeles',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-118.2437, 34.0522],
    aliases: ['los angeles', 'santa monica', 'culver city', 'pasadena', 'burbank', 'irvine'],
  },
  {
    id: 'chicago',
    name: 'Chicago',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-87.6298, 41.8781],
    aliases: ['chicago', 'evanston', 'naperville'],
  },
  {
    id: 'denver',
    name: 'Denver',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-104.9903, 39.7392],
    aliases: ['denver', 'boulder', 'colorado springs'],
  },
  {
    id: 'washington-dc',
    name: 'Washington DC',
    countryCode: 'US',
    region: 'americas',
    coordinates: [-77.0369, 38.9072],
    aliases: ['washington', 'washington dc', 'dc', 'arlington', 'mclean', 'bethesda'],
  },
  {
    id: 'toronto',
    name: 'Toronto',
    countryCode: 'CA',
    region: 'americas',
    coordinates: [-79.3832, 43.6532],
    aliases: ['toronto', 'waterloo', 'mississauga', 'markham'],
  },
  {
    id: 'vancouver',
    name: 'Vancouver',
    countryCode: 'CA',
    region: 'americas',
    coordinates: [-123.1207, 49.2827],
    aliases: ['vancouver', 'burnaby', 'richmond'],
  },
  {
    id: 'montreal',
    name: 'Montreal',
    countryCode: 'CA',
    region: 'americas',
    coordinates: [-73.5673, 45.5017],
    aliases: ['montreal', 'laval'],
  },
  {
    id: 'sao-paulo',
    name: 'São Paulo',
    countryCode: 'BR',
    region: 'americas',
    coordinates: [-46.6333, -23.5505],
    aliases: ['sao paulo', 'são paulo', 'campinas'],
  },

  // Europe
  {
    id: 'london',
    name: 'London',
    countryCode: 'GB',
    region: 'europe',
    coordinates: [-0.1278, 51.5074],
    aliases: ['london', 'greater london', 'reading', 'cambridge uk', 'oxford'],
  },
  {
    id: 'berlin',
    name: 'Berlin',
    countryCode: 'DE',
    region: 'europe',
    coordinates: [13.405, 52.52],
    aliases: ['berlin', 'potsdam'],
  },
  {
    id: 'munich',
    name: 'Munich',
    countryCode: 'DE',
    region: 'europe',
    coordinates: [11.582, 48.1351],
    aliases: ['munich', 'münchen'],
  },
  {
    id: 'paris',
    name: 'Paris',
    countryCode: 'FR',
    region: 'europe',
    coordinates: [2.3522, 48.8566],
    aliases: ['paris', 'courbevoie', 'boulogne-billancourt'],
  },
  {
    id: 'amsterdam',
    name: 'Amsterdam',
    countryCode: 'NL',
    region: 'europe',
    coordinates: [4.9041, 52.3676],
    aliases: ['amsterdam', 'utrecht', 'rotterdam', 'the hague'],
  },
  {
    id: 'dublin',
    name: 'Dublin',
    countryCode: 'IE',
    region: 'europe',
    coordinates: [-6.2603, 53.3498],
    aliases: ['dublin', 'cork', 'galway'],
  },
  {
    id: 'stockholm',
    name: 'Stockholm',
    countryCode: 'SE',
    region: 'europe',
    coordinates: [18.0686, 59.3293],
    aliases: ['stockholm', 'kista', 'gothenburg'],
  },
  {
    id: 'zurich',
    name: 'Zurich',
    countryCode: 'CH',
    region: 'europe',
    coordinates: [8.5417, 47.3769],
    aliases: ['zurich', 'zürich', 'geneva', 'lausanne'],
  },
  {
    id: 'madrid',
    name: 'Madrid',
    countryCode: 'ES',
    region: 'europe',
    coordinates: [-3.7038, 40.4168],
    aliases: ['madrid'],
  },
  {
    id: 'barcelona',
    name: 'Barcelona',
    countryCode: 'ES',
    region: 'europe',
    coordinates: [2.1734, 41.3851],
    aliases: ['barcelona'],
  },
  {
    id: 'warsaw',
    name: 'Warsaw',
    countryCode: 'PL',
    region: 'europe',
    coordinates: [21.0122, 52.2297],
    aliases: ['warsaw', 'warszawa', 'krakow', 'wroclaw'],
  },
  {
    id: 'belgrade',
    name: 'Belgrade',
    countryCode: 'RS',
    region: 'europe',
    coordinates: [20.4489, 44.7866],
    aliases: ['belgrade', 'beograd', 'novi sad'],
  },

  // India
  {
    id: 'blr',
    name: 'Bangalore',
    countryCode: 'IN',
    region: 'asia_pac',
    coordinates: [77.5946, 12.9716],
    aliases: ['bangalore', 'bengaluru', 'whitefield', 'electronic city', 'koramangala', 'bellandur'],
  },
  {
    id: 'hyd',
    name: 'Hyderabad',
    countryCode: 'IN',
    region: 'asia_pac',
    coordinates: [78.4867, 17.385],
    aliases: ['hyderabad', 'secunderabad', 'hitec city', 'gachibowli'],
  },
  {
    id: 'pune',
    name: 'Pune',
    countryCode: 'IN',
    region: 'asia_pac',
    coordinates: [73.8567, 18.5204],
    aliases: ['pune', 'hinjewadi'],
  },
  {
    id: 'mumbai',
    name: 'Mumbai',
    countryCode: 'IN',
    region: 'asia_pac',
    coordinates: [72.8777, 19.076],
    aliases: ['mumbai', 'bombay', 'navi mumbai', 'thane', 'bkc', 'powai'],
  },
  {
    id: 'delhi-ncr',
    name: 'Delhi NCR',
    countryCode: 'IN',
    region: 'asia_pac',
    coordinates: [77.1025, 28.7041],
    aliases: ['delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'faridabad', 'ghaziabad'],
  },
  {
    id: 'chennai',
    name: 'Chennai',
    countryCode: 'IN',
    region: 'asia_pac',
    coordinates: [80.2707, 13.0827],
    aliases: ['chennai', 'madras'],
  },

  // APAC & Middle East
  {
    id: 'singapore',
    name: 'Singapore',
    countryCode: 'SG',
    region: 'asia_pac',
    coordinates: [103.8198, 1.3521],
    aliases: ['singapore'],
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    countryCode: 'JP',
    region: 'asia_pac',
    coordinates: [139.6917, 35.6895],
    aliases: ['tokyo', 'shibuya', 'minato', 'chiyoda', 'shinjuku'],
  },
  {
    id: 'sydney',
    name: 'Sydney',
    countryCode: 'AU',
    region: 'asia_pac',
    coordinates: [151.2093, -33.8688],
    aliases: ['sydney', 'north sydney', 'surry hills'],
  },
  {
    id: 'melbourne',
    name: 'Melbourne',
    countryCode: 'AU',
    region: 'asia_pac',
    coordinates: [144.9631, -37.8136],
    aliases: ['melbourne', 'richmond vic'],
  },
  {
    id: 'seoul',
    name: 'Seoul',
    countryCode: 'KR',
    region: 'asia_pac',
    coordinates: [126.978, 37.5665],
    aliases: ['seoul', 'gangnam', 'pangyo'],
  },
  {
    id: 'tel-aviv',
    name: 'Tel Aviv',
    countryCode: 'IL',
    region: 'europe',
    coordinates: [34.7818, 32.0853],
    aliases: ['tel aviv', 'herzliya'],
  },
];

// 2. Country Centroids (for fallback when location is country-wide or unmapped city)
export const COUNTRY_CENTROIDS: Record<string, { name: string; coordinates: [number, number]; region: 'americas' | 'europe' | 'asia_pac' | 'global' }> = {
  US: { name: 'United States', coordinates: [-98.5795, 39.8283], region: 'americas' },
  IN: { name: 'India', coordinates: [78.9629, 20.5937], region: 'asia_pac' },
  GB: { name: 'United Kingdom', coordinates: [-3.436, 55.3781], region: 'europe' },
  DE: { name: 'Germany', coordinates: [10.4515, 51.1657], region: 'europe' },
  FR: { name: 'France', coordinates: [2.2137, 46.2276], region: 'europe' },
  CA: { name: 'Canada', coordinates: [-106.3468, 56.1304], region: 'americas' },
  AU: { name: 'Australia', coordinates: [133.7751, -25.2744], region: 'asia_pac' },
  NL: { name: 'Netherlands', coordinates: [5.2913, 52.1326], region: 'europe' },
  SE: { name: 'Sweden', coordinates: [18.6435, 60.1282], region: 'europe' },
  CH: { name: 'Switzerland', coordinates: [8.2275, 46.8182], region: 'europe' },
  ES: { name: 'Spain', coordinates: [-3.7492, 40.4637], region: 'europe' },
  IE: { name: 'Ireland', coordinates: [-8.2439, 53.4129], region: 'europe' },
  SG: { name: 'Singapore', coordinates: [103.8198, 1.3521], region: 'asia_pac' },
  JP: { name: 'Japan', coordinates: [138.2529, 36.2048], region: 'asia_pac' },
  BR: { name: 'Brazil', coordinates: [-51.9253, -14.235], region: 'americas' },
  IL: { name: 'Israel', coordinates: [34.8516, 31.0461], region: 'europe' },
  PL: { name: 'Poland', coordinates: [19.1451, 51.9194], region: 'europe' },
  RS: { name: 'Serbia', coordinates: [20.4489, 44.0165], region: 'europe' },
  KR: { name: 'South Korea', coordinates: [127.7669, 35.9078], region: 'asia_pac' },
};

export interface SupportedCountryOption {
  code: string;
  label: string;
  shortLabel: string;
}

/**
 * Historical static country code reference list from 20261001 database backfill.
 * NOTE: This is a static reference, NOT live active-job data.
 * For live country options, use `deriveCountryOptionsFromActiveJobs(activeCodes)` with
 * active-job records queried from `jobs_public` or active job search results.
 */
export const STATIC_TAXONOMY_COUNTRY_CODES: readonly string[] = [
  "US", // United States
  "GB", // United Kingdom
  "CA", // Canada
  "DE", // Germany
  "IN", // India
  "AU", // Australia
  "FR", // France
  "JP", // Japan
  "NL", // Netherlands
  "SG", // Singapore
  "IE", // Ireland
  "SE", // Sweden
  "CH", // Switzerland
  "ES", // Spain
  "BR", // Brazil
  "PL", // Poland
  "IL", // Israel
] as const;

/**
 * Derives user-facing country filter options from an active-job country_code array.
 * Safe empty/error handling: If activeCodes is empty or undefined, returns only Worldwide.
 * Never claims static codes are live data.
 */
export function deriveCountryOptionsFromActiveJobs(
  activeCodes?: readonly string[] | string[]
): SupportedCountryOption[] {
  const options: SupportedCountryOption[] = [
    { code: "", label: "All Locations (Worldwide)", shortLabel: "Worldwide" },
  ];

  if (!activeCodes || activeCodes.length === 0) {
    return options;
  }

  const distinctCodes = Array.from(
    new Set(activeCodes.map((c) => (c || "").toUpperCase().trim()).filter((c) => c.length === 2))
  ).sort();

  for (const code of distinctCodes) {
    const meta = COUNTRY_CENTROIDS[code];
    if (meta) {
      options.push({
        code,
        label: meta.name,
        shortLabel: code === "US" ? "US" : code === "GB" ? "UK" : meta.name,
      });
    }
  }

  return options;
}

// Default fallback options when no active jobs are loaded
export const SUPPORTED_COUNTRY_OPTIONS: SupportedCountryOption[] = deriveCountryOptionsFromActiveJobs();

/**
 * Normalizes raw location string and country_code into a resolved Geo target.
 */
export function resolveLocation(
  rawLocation: string | null | undefined,
  rawCountryCode: string | null | undefined,
  remoteScope: string | null | undefined,
  remoteEligibility: string | null | undefined
): ResolvedLocation {
  const loc = (rawLocation || '').toLowerCase().trim();
  const cc = (rawCountryCode || '').toUpperCase().trim();

  // 1. Worldwide Remote Check: strictly true global remote roles
  const isWorldwideRemote =
    (remoteScope === 'remote' || loc.includes('remote')) &&
    (remoteEligibility === 'worldwide' ||
      /\b(worldwide|anywhere|global|all timezones|work from anywhere)\b/i.test(loc));

  if (isWorldwideRemote) {
    return {
      type: 'worldwide_remote',
      id: 'worldwide-remote',
      name: 'Worldwide Remote',
      countryCode: null,
      region: 'global',
      coordinates: null,
    };
  }

  // 2. Match trusted tech hub cities by alias or name
  if (loc) {
    for (const city of TRUSTED_CITIES) {
      if (loc.includes(city.name.toLowerCase())) {
        return {
          type: 'city',
          id: city.id,
          name: city.name,
          countryCode: city.countryCode,
          region: city.region,
          coordinates: city.coordinates,
        };
      }
      if (city.aliases) {
        for (const alias of city.aliases) {
          // Word boundary or substring check for city alias
          const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escaped}\\b`, 'i');
          if (regex.test(loc)) {
            return {
              type: 'city',
              id: city.id,
              name: city.name,
              countryCode: city.countryCode,
              region: city.region,
              coordinates: city.coordinates,
            };
          }
        }
      }
    }
  }

  // 3. Fallback: If country code is known or can be inferred
  let effectiveCc = cc;
  if (!effectiveCc && loc) {
    if (/\b(united states|usa|u\.s\.a|u\.s\.|us)\b/i.test(loc)) effectiveCc = 'US';
    else if (/\b(india|bharat)\b/i.test(loc)) effectiveCc = 'IN';
    else if (/\b(united kingdom|uk|u\.k\.|great britain|england|scotland)\b/i.test(loc)) effectiveCc = 'GB';
    else if (/\b(germany|deutschland)\b/i.test(loc)) effectiveCc = 'DE';
    else if (/\b(france)\b/i.test(loc)) effectiveCc = 'FR';
    else if (/\b(canada)\b/i.test(loc)) effectiveCc = 'CA';
    else if (/\b(australia)\b/i.test(loc)) effectiveCc = 'AU';
    else if (/\b(netherlands|holland)\b/i.test(loc)) effectiveCc = 'NL';
    else if (/\b(sweden)\b/i.test(loc)) effectiveCc = 'SE';
    else if (/\b(switzerland)\b/i.test(loc)) effectiveCc = 'CH';
    else if (/\b(spain|españa)\b/i.test(loc)) effectiveCc = 'ES';
    else if (/\b(ireland)\b/i.test(loc)) effectiveCc = 'IE';
    else if (/\b(singapore)\b/i.test(loc)) effectiveCc = 'SG';
    else if (/\b(japan)\b/i.test(loc)) effectiveCc = 'JP';
    else if (/\b(brazil|brasil)\b/i.test(loc)) effectiveCc = 'BR';
    else if (/\b(poland|polska)\b/i.test(loc)) effectiveCc = 'PL';
  }

  if (effectiveCc && COUNTRY_CENTROIDS[effectiveCc]) {
    const cData = COUNTRY_CENTROIDS[effectiveCc];
    return {
      type: 'country',
      id: `country-${effectiveCc.toLowerCase()}`,
      name: cData.name,
      countryCode: effectiveCc,
      region: cData.region,
      coordinates: cData.coordinates,
    };
  }

  // 4. Unlocated bucket (unknown country + unknown city)
  return {
    type: 'unlocated',
    id: 'unlocated',
    name: 'Unlocated',
    countryCode: null,
    region: 'global',
    coordinates: null,
  };
}
