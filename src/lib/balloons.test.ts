import { describe, it, expect } from 'vitest';
import { latestFrames, parseSondeTelemetry, toBalloon } from './balloons';

/**
 * A frame trimmed from a live api.v2.sondehub.org response. Numeric fields are
 * numbers here unless a test overrides them; string variants are covered below
 * because auto_rx uploaders are not consistent.
 */
function frame(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    software_name: 'radiosonde_auto_rx',
    manufacturer: 'Vaisala',
    type: 'RS41',
    subtype: 'RS41-SGP',
    serial: 'X4553294',
    uploader_callsign: 'Lahti 24h raspberry',
    lat: 60.32579,
    lon: 24.271,
    alt: 24096.87673,
    temp: -63.8,
    vel_v: 4.80745,
    vel_h: 6.18419,
    datetime: '2026-11-08T07:03:59.987000Z',
    ...over,
  };
}

/** Build the upstream shape: serial → timestamp → frame. */
function payload(framesBySerial: Record<string, Record<string, Record<string, unknown>>>): Record<string, unknown> {
  return framesBySerial;
}

describe('latestFrames', () => {
  it('keeps one frame per sonde — the newest observation', () => {
    const out = latestFrames(
      payload({
        X1: {
          '2026-11-08T07:00:00.000Z': frame({ serial: 'X1', datetime: '2026-11-08T07:00:00.000Z' }),
          '2026-11-08T07:01:00.000Z': frame({ serial: 'X1', datetime: '2026-11-08T07:01:00.000Z' }),
          '2026-11-08T07:02:00.000Z': frame({ serial: 'X1', datetime: '2026-11-08T07:02:00.000Z' }),
        },
      }),
    );
    expect(out).toHaveLength(1);
    expect((out[0] as Record<string, unknown>).datetime).toBe('2026-11-08T07:02:00.000Z');
  });

  // JSON key order is not part of the contract: pick by parsed timestamp.
  it('picks the newest frame even when the map keys are in reverse order', () => {
    const out = latestFrames({
      X1: {
        '2026-11-08T07:09:00.000Z': frame({ serial: 'X1', datetime: '2026-11-08T07:09:00.000Z' }),
        '2026-11-08T07:03:00.000Z': frame({ serial: 'X1', datetime: '2026-11-08T07:03:00.000Z' }),
        '2026-11-08T07:06:00.000Z': frame({ serial: 'X1', datetime: '2026-11-08T07:06:00.000Z' }),
      },
    });
    expect((out[0] as Record<string, unknown>).datetime).toBe('2026-11-08T07:09:00.000Z');
  });

  it('sorts the surviving frames newest first', () => {
    const out = latestFrames({
      OLD: { '2026-11-08T06:00:00.000Z': frame({ serial: 'OLD', datetime: '2026-11-08T06:00:00.000Z' }) },
      NEW: { '2026-11-08T08:00:00.000Z': frame({ serial: 'NEW', datetime: '2026-11-08T08:00:00.000Z' }) },
      MID: { '2026-11-08T07:00:00.000Z': frame({ serial: 'MID', datetime: '2026-11-08T07:00:00.000Z' }) },
    });
    expect((out as Record<string, unknown>[]).map((f) => f.serial)).toEqual(['NEW', 'MID', 'OLD']);
  });

  it('collapses a duplicate serial re-uploaded under a second key', () => {
    const out = latestFrames({
      X1: { '2026-11-08T07:00:00.000Z': frame({ serial: 'X1', datetime: '2026-11-08T07:00:00.000Z' }) },
      X1_REUPLOAD: { '2026-11-08T07:05:00.000Z': frame({ serial: 'X1', datetime: '2026-11-08T07:05:00.000Z' }) },
    });
    expect(out).toHaveLength(1);
    expect((out[0] as Record<string, unknown>).datetime).toBe('2026-11-08T07:05:00.000Z');
  });

  it('tolerates junk instead of throwing', () => {
    expect(latestFrames(null)).toEqual([]);
    expect(latestFrames([])).toEqual([]);
    expect(latestFrames('not json')).toEqual([]);
    expect(latestFrames({ X1: 'nope' })).toEqual([]);
    expect(latestFrames({ X1: { '2026-11-08T07:00:00.000Z': null } })).toEqual([]);
  });
});

describe('toBalloon', () => {
  it('normalises a live frame into the map popup shape', () => {
    expect(toBalloon(frame())).toEqual({
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
      datetime: '2026-11-08T07:03:59.987000Z',
    });
  });

  it('rejects a frame with no usable position', () => {
    expect(toBalloon(frame({ lat: undefined }))).toBeNull();
    expect(toBalloon(frame({ lat: 'n/a' }))).toBeNull();
    expect(toBalloon(frame({ lon: null }))).toBeNull();
    expect(toBalloon(frame({ lat: 91 }))).toBeNull();
    expect(toBalloon(undefined)).toBeNull();
  });

  // The popup shows m/s, but the exact ±1 m/s boundary must read FLOAT.
  it('classifies ascent, descent and float at the ±1 m/s thresholds', () => {
    expect(toBalloon(frame({ vel_v: 1.01 }))?.status).toBe('ASCENT');
    expect(toBalloon(frame({ vel_v: 1 }))?.status).toBe('FLOAT');
    expect(toBalloon(frame({ vel_v: 0 }))?.status).toBe('FLOAT');
    expect(toBalloon(frame({ vel_v: -1 }))?.status).toBe('FLOAT');
    expect(toBalloon(frame({ vel_v: -1.01 }))?.status).toBe('DESCENT');
  });

  it('converts horizontal m/s to km/h and rounds', () => {
    expect(toBalloon(frame({ vel_h: 10 }))?.speed).toBe(36);
    expect(toBalloon(frame({ vel_h: 7.77 }))?.speed).toBe(28); // 27.972
    expect(toBalloon(frame({ vel_h: 0 }))?.speed).toBe(0);
    expect(toBalloon(frame({ vel_h: undefined }))?.speed).toBe(0);
  });

  it('maps manufacturer to the marker colour, with a fallback', () => {
    expect(toBalloon(frame({ manufacturer: 'Vaisala' }))?.color).toBe('#00E5FF');
    expect(toBalloon(frame({ manufacturer: 'Graw' }))?.color).toBe('#FFB300');
    expect(toBalloon(frame({ manufacturer: 'MeteoModem' }))?.color).toBe('#B388FF');
    expect(toBalloon(frame({ manufacturer: undefined }))?.color).toBe('#B388FF');
  });

  /* Uploaders disagree: auto_rx historically emitted numbers as strings. We
     coerce numeric strings (rejecting them would silently drop those sondes). */
  it('coerces numeric strings sent by older uploaders', () => {
    const balloon = toBalloon(
      frame({ lat: '48.2', lon: '11.5', alt: '1200.5', vel_v: '2.5', vel_h: '36', temp: '-12.3' }),
    );
    expect(balloon).toMatchObject({
      lat: 48.2,
      lng: 11.5,
      altitude: 1200.5,
      status: 'ASCENT',
      speed: 130, // 36 * 3.6
      verticalRate: 2.5,
      temperature: -12.3,
    });
  });

  it('survives a NaN altitude by degrading to 0 m rather than dropping the sonde', () => {
    const balloon = toBalloon(frame({ alt: Number.NaN }));
    expect(balloon).not.toBeNull();
    expect(balloon?.altitude).toBe(0);
    expect(toBalloon(frame({ alt: 'NaN' }))?.altitude).toBe(0);
  });

  it('reports a missing temperature as null, not 0 °C', () => {
    expect(toBalloon(frame({ temp: undefined }))?.temperature).toBeNull();
    expect(toBalloon(frame({ temp: null }))?.temperature).toBeNull();
  });

  it('falls back to the serial when no uploader callsign is present', () => {
    const balloon = toBalloon(frame({ uploader_callsign: undefined, serial: 'X4553294' }));
    expect(balloon?.callsign).toBe('X4553294');
  });
});

describe('parseSondeTelemetry', () => {
  it('returns nothing for an empty sky', () => {
    expect(parseSondeTelemetry({})).toEqual([]);
    expect(parseSondeTelemetry(null)).toEqual([]);
  });

  it('drops unplottable sondes but keeps the rest', () => {
    const balloons = parseSondeTelemetry(
      payload({
        GOOD: { '2026-11-08T07:00:00.000Z': frame({ serial: 'GOOD', lat: 48.1 }) },
        BAD: { '2026-11-08T07:00:00.000Z': frame({ serial: 'BAD', lat: undefined }) },
      }),
    );
    expect(balloons).toHaveLength(1);
    expect(balloons[0].lat).toBe(48.1);
  });

  it('returns newest-first plot-ready balloons', () => {
    const balloons = parseSondeTelemetry(
      payload({
        OLD: { '2026-11-08T06:00:00.000Z': frame({ serial: 'OLD', datetime: '2026-11-08T06:00:00.000Z' }) },
        NEW: { '2026-11-08T08:00:00.000Z': frame({ serial: 'NEW', datetime: '2026-11-08T08:00:00.000Z' }) },
      }),
    );
    expect(balloons.map((b) => b.datetime)).toEqual([
      '2026-11-08T08:00:00.000Z',
      '2026-11-08T06:00:00.000Z',
    ]);
  });
});
