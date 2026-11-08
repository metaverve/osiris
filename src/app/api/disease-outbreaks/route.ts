import { NextResponse } from 'next/server';
import { httpJson } from '@/lib/httpJson';
import { cachedSource } from '@/lib/sourceCache';
import {
  WHO_DON_SOURCE,
  buildDiseaseReport,
  summariseOutbreaks,
  type DiseaseOutbreak,
} from '@/lib/disease-outbreaks';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;

/**
 * OSIRIS — WHO Disease Outbreak News.
 *
 * WHO's DON portal is a keyless OData JSON API; the item pages are ordinary
 * public pages. It is the fastest official bulletin feed for outbreaks —
 * Ebola, yellow fever, cholera, novel influenza — and it is entirely
 * text-based: there is no severity field and there are no coordinates. The
 * normaliser is in `lib/disease-outbreaks.ts`; this route caches its output for
 * half an hour and degrades to an empty feed (with an error) rather than
 * failing the panel.
 *
 * `$top=60` is the whole current feed (WHO keeps roughly two years of DONs).
 */
const UPSTREAM =
  'https://www.who.int/api/news/diseaseoutbreaknews?$orderby=PublicationDateAndTime%20desc&$top=60';

const CACHE_KEY = 'who:disease-outbreak-news';
/** DONs are published a few times a week; half an hour is plenty fresh. */
const CACHE_TTL_MS = 30 * 60_000;
const MAX_ITEMS = 60;
const CACHE_CONTROL = 'public, s-maxage=1800, stale-while-revalidate=3600';

interface CachedRows {
  rows: DiseaseOutbreak[];
  /** True when this request's upstream attempt failed (cache may still hold a last good feed). */
  failed: boolean;
}

/**
 * Rows from the shared process cache, refilling from WHO on a miss.
 *
 * `cachedSource` swallows a failed refresh (serving the last good rows when it
 * has them), so the failure is recorded in this request's closure and the
 * degraded response is only sent when there is nothing to show at all.
 */
async function loadRows(): Promise<CachedRows> {
  let failed = false;
  const rows = await cachedSource<DiseaseOutbreak>(
    CACHE_KEY,
    async () => {
      try {
        const payload = await httpJson<unknown>(UPSTREAM, { timeoutMs: 12_000 });
        return buildDiseaseReport(payload).outbreaks;
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    CACHE_TTL_MS,
  )();
  return { rows, failed };
}

/** The one shape the panel needs when nothing could be loaded. */
function degraded(timestamp: string) {
  return {
    outbreaks: [] as DiseaseOutbreak[],
    total: 0,
    countries: 0,
    latest: null,
    source: WHO_DON_SOURCE,
    error: 'Failed to fetch WHO disease outbreak news',
    timestamp,
  };
}

export async function GET(request: Request) {
  // `?limit=` is a display cap only: the cache and the counts always cover the
  // whole feed, so asking for ten items cannot change what "latest" means.
  let limit = MAX_ITEMS;
  try {
    const { searchParams } = new URL(request.url);
    const raw = parseInt(searchParams.get('limit') || '', 10);
    if (Number.isFinite(raw)) limit = Math.min(MAX_ITEMS, Math.max(1, raw));
  } catch {
    // A malformed URL is not a reason to blank the panel; use the full feed.
  }

  try {
    const { rows, failed } = await loadRows();
    const timestamp = new Date().toISOString();

    if (failed && rows.length === 0) {
      return NextResponse.json(degraded(timestamp), {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const report = summariseOutbreaks(rows);
    /* The panel renders the title, country, date and summary; the full
       overview/assessment/response bodies are several kilobytes each and would
       make the feed ~400 kB for data no consumer on this route displays. Keep
       the wire shape to what is shown; the lib still parses the full text. */
    const outbreaks = rows.slice(0, limit).map(({ id, title, published, summary, url, donId, country, lat, lng }) => ({
      id, title, published, summary, url, donId, country, lat, lng,
    }));
    return NextResponse.json(
      {
        outbreaks,
        total: report.total,
        countries: report.countries,
        latest: report.latest,
        source: WHO_DON_SOURCE,
        timestamp,
        window: {
          limit,
          returned: outbreaks.length,
          newest: outbreaks[0]?.published || null,
          oldest: outbreaks.length ? outbreaks[outbreaks.length - 1].published || null : null,
        },
      },
      { headers: { 'Cache-Control': CACHE_CONTROL } },
    );
  } catch (error) {
    console.error('[OSIRIS] WHO disease outbreaks error:', error);
    return NextResponse.json(degraded(new Date().toISOString()), {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
