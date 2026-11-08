import { NextResponse } from 'next/server';
import { cachedSource } from '@/lib/sourceCache';
import { parseSondeTelemetry, type Balloon } from '@/lib/balloons';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

/**
 * OSIRIS — High-altitude balloon / radiosonde telemetry.
 *
 * SondeHub v2 is keyless and returns one observation map per sonde serial,
 * which balloons.ts reduces to the newest frame per balloon. The client polls
 * this every five minutes while the balloon layer is on.
 *
 * `duration` is an allow-list, not a passthrough: SondeHub rejects any window
 * outside its enum, and forwarding arbitrary input would turn this route into a
 * query proxy for the upstream API.
 */

const SONDEHUB_URL = 'https://api.v2.sondehub.org/sondes/telemetry';
const SONDEHUB_UA = 'OSIRIS/5.0 (+https://osirisai.live)';

/** SondeHub's accepted `duration` values (anything else is a 4xx upstream). */
const ALLOWED_DURATIONS = ['15s', '1m', '30m', '1h', '3h'] as const;
const DEFAULT_DURATION = '1h';

/** Radiosondes report every few seconds; 5 min is already finer than we render. */
const TTL_MS = 5 * 60 * 1000;

const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
};

/** Constrain `?duration=` to SondeHub's enum, falling back to the default. */
export function resolveDuration(raw: string | null): string {
  const value = (raw ?? '').trim();
  return (ALLOWED_DURATIONS as readonly string[]).includes(value) ? value : DEFAULT_DURATION;
}

function unavailable() {
  return NextResponse.json(
    {
      balloons: [],
      total: 0,
      error: 'SondeHub unavailable',
      timestamp: new Date().toISOString(),
    },
    { headers: CACHE_HEADERS },
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const duration = resolveDuration(searchParams.get('duration'));

  // cachedSource swallows a failed fetch (that is its stale-on-error contract),
  // so the failure has to be remembered here to tell "upstream is down" apart
  // from "no sondes are airborne".
  let upstreamFailed = false;

  try {
    const balloons = await cachedSource<Balloon>(
      `balloons:sondehub:${duration}`,
      async () => {
        try {
          const response = await fetch(`${SONDEHUB_URL}?duration=${duration}`, {
            signal: AbortSignal.timeout(15_000),
            headers: { 'User-Agent': SONDEHUB_UA },
          });
          if (!response.ok) throw new Error(`SondeHub responded with ${response.status}`);
          // Next/Node decompresses the gzip body before json() sees it.
          return parseSondeTelemetry(await response.json());
        } catch (error) {
          upstreamFailed = true;
          throw error;
        }
      },
      TTL_MS,
    )();

    // A stale-on-error cache hit is still better than an empty map; only a
    // failure with nothing to fall back on is reported as an outage.
    if (upstreamFailed && balloons.length === 0) return unavailable();

    return NextResponse.json(
      {
        balloons,
        total: balloons.length,
        source: 'SondeHub',
        timestamp: new Date().toISOString(),
      },
      { headers: CACHE_HEADERS },
    );
  } catch (error) {
    console.error('[OSIRIS] SondeHub error:', error);
    return unavailable();
  }
}
