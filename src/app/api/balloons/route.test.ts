import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearSourceCache } from '@/lib/sourceCache';
import { GET, resolveDuration } from './route';

/**
 * Trimmed SondeHub response: serial → ISO timestamp → frame. The route stubs
 * global fetch, so the fixture is plain JSON — gzip decompression happens in
 * the real fetch and is not part of what this test covers.
 */
const FRAME = {
  serial: 'X4553294',
  manufacturer: 'Vaisala',
  type: 'RS41',
  subtype: 'RS41-SGP',
  uploader_callsign: 'Lahti 24h raspberry',
  lat: 60.32579,
  lon: 24.271,
  alt: 24096.87673,
  temp: -63.8,
  vel_v: 4.80745,
  vel_h: 6.18419,
  datetime: '2026-11-08T07:03:59.987000Z',
};

function telemetry() {
  return { X4553294: { '2026-11-08T07:03:59.987000Z': FRAME } };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

async function call(query = '') {
  const response = await GET(new Request(`http://localhost/api/balloons${query}`));
  return { response, body: await response.json() };
}

beforeEach(() => clearSourceCache());
afterEach(() => vi.unstubAllGlobals());

describe('GET /api/balloons', () => {
  it('normalises SondeHub telemetry into plot-ready balloons', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(telemetry()));
    vi.stubGlobal('fetch', fetchMock);

    const { response, body } = await call();

    expect(response.status).toBe(200);
    expect(body.source).toBe('SondeHub');
    expect(body.total).toBe(1);
    expect(typeof body.timestamp).toBe('string');
    expect(body.balloons).toEqual([
      expect.objectContaining({
        callsign: 'Lahti 24h raspberry',
        type: 'RS41',
        status: 'ASCENT',
        lat: 60.32579,
        lng: 24.271,
        altitude: 24096.87673,
        speed: 22,
        verticalRate: 4.80745,
        temperature: -63.8,
        color: '#00E5FF',
      }),
    ]);
  });

  it('calls SondeHub with the identifying user agent and a timeout signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(telemetry()));
    vi.stubGlobal('fetch', fetchMock);

    await call();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('https://api.v2.sondehub.org/sondes/telemetry?duration=1h');
    expect(init.headers['User-Agent']).toBe('OSIRIS/5.0 (+https://osirisai.live)');
    expect(init.signal).toBeDefined();
  });

  it('sets a five-minute shared cache header', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(telemetry())));
    const { response } = await call();
    expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=600');
  });

  it('answers 200 with an empty list and an error when SondeHub is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));

    const { response, body } = await call();

    // A dead upstream degrades the layer; it must not blank the dashboard.
    expect(response.status).toBe(200);
    expect(body.balloons).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.error).toBe('SondeHub unavailable');
  });

  it('answers 200 with an error when SondeHub sends malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      }),
    );

    const { response, body } = await call();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ balloons: [], total: 0, error: 'SondeHub unavailable' });
  });

  it('treats a legitimate empty sky as success, not an outage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({})));
    const { body } = await call();
    expect(body).toMatchObject({ balloons: [], total: 0, source: 'SondeHub' });
    expect(body.error).toBeUndefined();
  });

  it('falls back to the default duration for a value SondeHub would reject', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(telemetry()));
    vi.stubGlobal('fetch', fetchMock);

    await call('?duration=forever');

    expect(fetchMock.mock.calls[0][0]).toContain('duration=1h');
  });

  it('passes an allowed duration through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(telemetry()));
    vi.stubGlobal('fetch', fetchMock);

    await call('?duration=3h');

    expect(fetchMock.mock.calls[0][0]).toContain('duration=3h');
  });

  it('serves repeat polls from the in-process cache instead of re-downloading', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(telemetry()));
    vi.stubGlobal('fetch', fetchMock);

    await call();
    await call();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('resolveDuration', () => {
  it('accepts only the SondeHub enum and defaults everything else', () => {
    expect(resolveDuration('15s')).toBe('15s');
    expect(resolveDuration('1m')).toBe('1m');
    expect(resolveDuration('30m')).toBe('30m');
    expect(resolveDuration('1h')).toBe('1h');
    expect(resolveDuration('3h')).toBe('3h');
    expect(resolveDuration('12h')).toBe('1h');
    expect(resolveDuration('1H')).toBe('1h');
    expect(resolveDuration('')).toBe('1h');
    expect(resolveDuration(null)).toBe('1h');
  });
});
