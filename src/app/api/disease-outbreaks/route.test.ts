import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* WHO is faked at the seam this route actually uses. The normaliser itself is
   covered by src/lib/disease-outbreaks.test.ts; these tests pin the route's
   caching, ordering, limit and degrade-never-blank behaviour. */
const httpJson = vi.fn();
vi.mock('@/lib/httpJson', () => ({ httpJson: (...args: unknown[]) => httpJson(...args) }));

import { GET } from './route';
import { clearSourceCache } from '@/lib/sourceCache';

const WHO = 'https://www.who.int/api/news/diseaseoutbreaknews';

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Id: 'id-1',
    DonId: '2026-DON625',
    UrlName: '2026-DON625',
    ItemDefaultUrl: '/2026-DON625',
    Title: 'Ebola disease caused by Bundibugyo virus — Democratic Republic of the Congo',
    Summary: '<p>Bundibugyo virus disease continues.</p>',
    Overview: '<p>Cases reported in the Democratic Republic of the Congo.</p>',
    Assessment: '<p>Risk is assessed as high.</p>',
    PublicationDateAndTime: '2026-11-06T20:42:12Z',
    ...over,
  };
}

const payload = (...values: unknown[]) => ({ '@odata.context': WHO, value: values });
const request = (query = '') => GET(new Request(`http://localhost:3000/api/disease-outbreaks${query}`));

beforeEach(() => {
  httpJson.mockReset();
  clearSourceCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/disease-outbreaks', () => {
  it('returns the normalised feed with the published counters', async () => {
    httpJson.mockResolvedValue(
      payload(
        row(),
        row({
          Id: 'id-2',
          DonId: '2026-DON624',
          UrlName: '2026-DON624',
          ItemDefaultUrl: '/2026-DON624',
          Title: 'Yellow fever — Kenya',
          Summary: '<p>Transmission continues in <strong>Kenya</strong>.</p>',
          PublicationDateAndTime: '2026-11-01T09:00:00Z',
        }),
      ),
    );

    const res = await request();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=1800');
    expect(body.source).toBe('WHO Disease Outbreak News');
    expect(typeof body.timestamp).toBe('string');
    expect(body.total).toBe(2);
    expect(body.countries).toBe(2);
    expect(body.latest).toBe('2026-11-06T20:42:12.000Z');
    expect(String(httpJson.mock.calls[0][0])).toContain('diseaseoutbreaknews');

    const first = body.outbreaks[0];
    expect(first.title).toContain('Ebola');
    expect(first.url).toBe('https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON625');
    expect(first.summary).toBe('Bundibugyo virus disease continues.');
    expect(first.country).toEqual({ name: 'Democratic Republic of the Congo', code: 'CD' });
    expect(typeof first.lat).toBe('number');
    expect(typeof first.lng).toBe('number');
  });

  it('orders the list newest first even when WHO sends it unsorted', async () => {
    httpJson.mockResolvedValue(
      payload(
        row({ Id: 'old', PublicationDateAndTime: '2026-10-20T00:00:00Z' }),
        row({ Id: 'new', PublicationDateAndTime: '2026-11-06T00:00:00Z' }),
        row({ Id: 'mid', PublicationDateAndTime: '2026-11-01T00:00:00Z' }),
      ),
    );
    const body = await (await request()).json();
    expect(body.outbreaks.map((o: { id: string }) => o.id)).toEqual(['new', 'mid', 'old']);
  });

  it('strips HTML before the payload reaches the client', async () => {
    httpJson.mockResolvedValue(payload(row({ Summary: '<p>Risk &amp; response</p>' })));
    const body = await (await request()).json();
    expect(body.outbreaks[0].summary).toBe('Risk & response');
    expect(JSON.stringify(body)).not.toContain('<p>');
  });

  it('degrades to an empty 200 with an error when WHO fails, so the panel is never blank', async () => {
    httpJson.mockRejectedValue(new Error('HTTP 500'));

    const res = await request();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.outbreaks).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.countries).toBe(0);
    expect(body.latest).toBeNull();
    expect(body.error).toBe('Failed to fetch WHO disease outbreak news');
    expect(typeof body.timestamp).toBe('string');
  });

  it('serves the cached feed without asking WHO again inside the TTL', async () => {
    httpJson.mockResolvedValue(payload(row()));

    await request();
    const body = await (await request()).json();

    expect(httpJson).toHaveBeenCalledTimes(1);
    expect(body.total).toBe(1);
  });

  it('keeps the last good feed when a later refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
    httpJson.mockResolvedValue(payload(row()));

    const first = await (await request()).json();
    expect(first.total).toBe(1);

    // Past the 30-minute TTL, WHO goes down: the stale feed is still served.
    vi.setSystemTime(new Date('2026-11-08T00:31:00Z'));
    httpJson.mockRejectedValue(new Error('HTTP 502'));

    const body = await (await request()).json();
    expect(body.total).toBe(1);
    expect(body.outbreaks).toHaveLength(1);
    expect(body.error).toBeUndefined();
  });

  it('caps the list with ?limit= while the counters still describe the whole feed', async () => {
    httpJson.mockResolvedValue(
      payload(
        row({ Id: 'a', PublicationDateAndTime: '2026-11-06T00:00:00Z' }),
        row({ Id: 'b', PublicationDateAndTime: '2026-11-05T00:00:00Z' }),
        row({ Id: 'c', PublicationDateAndTime: '2026-11-04T00:00:00Z' }),
      ),
    );

    const body = await (await request('?limit=1')).json();
    expect(body.outbreaks).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.window.limit).toBe(1);
    expect(body.window.returned).toBe(1);

    // Out-of-range values are clamped, not rejected.
    const clamped = await (await request('?limit=0')).json();
    expect(clamped.window.limit).toBe(1);
    const big = await (await request('?limit=999')).json();
    expect(big.window.limit).toBe(60);
    expect(big.outbreaks).toHaveLength(3);
  });
});
