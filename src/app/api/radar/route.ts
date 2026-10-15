import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveLocation, TRUSTED_CITIES, COUNTRY_CENTROIDS } from '@/lib/geo/cities';

export const dynamic = 'force-static';

// In-memory cache for ultra-fast responses (5-minute TTL)
interface CachedRadarData {
  payload: any;
  cachedAt: number;
}

let memoryCache: CachedRadarData | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchJobsChunks(
  supabase: any,
  totalActive: number | null,
  batchSize: number = 5,
  chunkSize: number = 1000
): Promise<any[]> {
  const chunkCount = Math.ceil((totalActive || 0) / chunkSize);
  const jobs: any[] = [];

  for (let b = 0; b < chunkCount; b += batchSize) {
    const batchPromises = [];
    const end = Math.min(b + batchSize, chunkCount);
    for (let i = b; i < end; i++) {
      const from = i * chunkSize;
      const to = from + chunkSize - 1;
      batchPromises.push(
        supabase
          .from('jobs_public')
          .select('id, company, title, location, country_code, remote_scope, remote_eligibility, verified')
          .eq('is_active', true)
          .eq('status', 'active')
          .range(from, to)
      );
    }
    const batchResults = await Promise.all(batchPromises);
    for (const r of batchResults) {
      if (r.error) {
        throw new Error(`Failed to fetch jobs chunk: ${r.error.message || JSON.stringify(r.error)}`);
      }
      if (r.data) {
        jobs.push(...r.data);
      }
    }
  }

  return jobs;
}

export async function GET() {
  const now = Date.now();

  // Return in-memory cached aggregate if fresh
  if (memoryCache && now - memoryCache.cachedAt < CACHE_TTL_MS) {
    return NextResponse.json(memoryCache.payload, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': 'HIT',
      },
    });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'Supabase credentials not configured' }, { status: 500 });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  try {
    // 1. Fetch metadata from latest ingest_run
    const { data: latestRun } = await supabase
      .from('ingest_runs')
      .select('finished_at, total_active, total_verified')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // 2. Fetch active jobs in parallel chunks (bypassing PostgREST 1000 row cap)
    const { count: totalActive } = await supabase
      .from('jobs_public')
      .select('*', { count: 'exact', head: true })
      .eq('is_active', true)
      .eq('status', 'active');

    const jobs = await fetchJobsChunks(supabase, totalActive);

    const distinctJobIds = new Set<string>();
    const distinctVerifiedIds = new Set<string>();

    // Buckets
    interface CityAggregate {
      id: string;
      name: string;
      countryCode: string;
      region: string;
      coordinates: [number, number];
      totalCount: number;
      verifiedCount: number;
      companies: Set<string>;
    }

    const cityMap = new Map<string, CityAggregate>();

    // Pre-populate trusted cities so all major hubs exist even if 0 jobs
    for (const c of TRUSTED_CITIES) {
      cityMap.set(c.id, {
        id: c.id,
        name: c.name,
        countryCode: c.countryCode,
        region: c.region,
        coordinates: c.coordinates,
        totalCount: 0,
        verifiedCount: 0,
        companies: new Set(),
      });
    }

    const countryMap = new Map<string, { total: number; verified: number; name: string; coordinates: [number, number] }>();
    for (const [code, meta] of Object.entries(COUNTRY_CENTROIDS)) {
      countryMap.set(code, {
        total: 0,
        verified: 0,
        name: meta.name,
        coordinates: meta.coordinates,
      });
    }

    const worldwideRemote = {
      id: 'worldwide-remote',
      name: 'Worldwide Remote',
      totalCount: 0,
      verifiedCount: 0,
      companies: new Set<string>(),
    };

    const unlocated = {
      id: 'unlocated',
      name: 'Unlocated',
      totalCount: 0,
      verifiedCount: 0,
    };

    // Aggregate jobs
    for (const j of jobs) {
      distinctJobIds.add(j.id);
      const isVerified = Boolean(j.verified);
      if (isVerified) distinctVerifiedIds.add(j.id);

      const resolved = resolveLocation(j.location, j.country_code, j.remote_scope, j.remote_eligibility);

      if (resolved.type === 'worldwide_remote') {
        worldwideRemote.totalCount++;
        if (isVerified) worldwideRemote.verifiedCount++;
        if (j.company) worldwideRemote.companies.add(j.company);
      } else if (resolved.type === 'city') {
        let city = cityMap.get(resolved.id);
        if (!city && resolved.coordinates) {
          city = {
            id: resolved.id,
            name: resolved.name,
            countryCode: resolved.countryCode || 'US',
            region: resolved.region,
            coordinates: resolved.coordinates,
            totalCount: 0,
            verifiedCount: 0,
            companies: new Set(),
          };
          cityMap.set(resolved.id, city);
        }
        if (city) {
          city.totalCount++;
          if (isVerified) city.verifiedCount++;
          if (j.company) city.companies.add(j.company);
        }
        if (resolved.countryCode && countryMap.has(resolved.countryCode)) {
          const c = countryMap.get(resolved.countryCode)!;
          c.total++;
          if (isVerified) c.verified++;
        }
      } else if (resolved.type === 'country') {
        if (resolved.countryCode && countryMap.has(resolved.countryCode)) {
          const c = countryMap.get(resolved.countryCode)!;
          c.total++;
          if (isVerified) c.verified++;
        }
      } else {
        unlocated.totalCount++;
        if (isVerified) unlocated.verifiedCount++;
      }
    }

    // Format cities list (filter out cities with 0 jobs or keep active ones)
    const formattedCities = Array.from(cityMap.values())
      .filter((c) => c.totalCount > 0)
      .map((c) => ({
        id: c.id,
        name: c.name,
        countryCode: c.countryCode,
        region: c.region,
        coordinates: c.coordinates,
        totalCount: c.totalCount,
        verifiedCount: c.verifiedCount,
        topCompanies: Array.from(c.companies).slice(0, 5),
      }))
      .sort((a, b) => b.totalCount - a.totalCount);

    const formattedCountries: Record<string, { total: number; verified: number; name: string; coordinates: [number, number] }> = {};
    countryMap.forEach((val, code) => {
      if (val.total > 0) {
        formattedCountries[code] = val;
      }
    });

    const payload = {
      header: {
        totalActive: totalActive || distinctJobIds.size,
        totalVerified: distinctVerifiedIds.size,
        dataAsOf: latestRun?.finished_at || new Date().toISOString(),
      },
      cities: formattedCities,
      countries: formattedCountries,
      worldwideRemote: {
        id: worldwideRemote.id,
        name: worldwideRemote.name,
        totalCount: worldwideRemote.totalCount,
        verifiedCount: worldwideRemote.verifiedCount,
        topCompanies: Array.from(worldwideRemote.companies).slice(0, 5),
      },
      unlocated,
    };

    memoryCache = {
      payload,
      cachedAt: now,
    };

    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache': 'MISS',
      },
    });
  } catch (err: any) {
    console.error('Radar Aggregation Error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
