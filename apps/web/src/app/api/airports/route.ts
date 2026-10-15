import { NextRequest } from 'next/server';
import { apiSuccess, apiError } from '@/lib/api-response';
import airportsRaw from '@/data/airports.json';

export interface AirportResult {
  code: string;
  city: string;
  name: string;
  country: string;
}

// airports.json format: { "JFK": ["New York", "John F. Kennedy International Airport", "US"], ... }
const airports = airportsRaw as unknown as Record<string, [string, string, string]>;

const MAX_RESULTS = 8;

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim();
  if (!q || q.length < 2) {
    return apiError('Query must be at least 2 characters', 400);
  }

  const upper = q.toUpperCase();
  const lower = q.toLowerCase();
  const results: AirportResult[] = [];

  // Exact IATA code match first
  if (upper.length === 3 && airports[upper]) {
    const [city, name, country] = airports[upper]!;
    results.push({ code: upper, city, name, country });
  }

  // Prefix match on IATA codes (if typing 2 letters)
  if (upper.length <= 3) {
    for (const [code, [city, name, country]] of Object.entries(airports)) {
      if (results.length >= MAX_RESULTS) break;
      if (code === upper) continue; // already added
      if (code.startsWith(upper)) {
        results.push({ code, city, name, country });
      }
    }
  }

  // City and airport name substring match
  for (const [code, [city, name, country]] of Object.entries(airports)) {
    if (results.length >= MAX_RESULTS) break;
    if (results.some((r) => r.code === code)) continue;
    if (city.toLowerCase().includes(lower) || name.toLowerCase().includes(lower)) {
      results.push({ code, city, name, country });
    }
  }

  return apiSuccess(results);
}
