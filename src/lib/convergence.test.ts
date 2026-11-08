import { describe, it, expect } from 'vitest';
import { computeConvergence, type ConvergenceType } from './convergence';

/* A pinned clock keeps every window assertion exact. */
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0); // 2026-11-08T12:00:00Z
const HOUR = 3_600_000;
const FRESH = NOW - HOUR;
const ZERO_BY_TYPE: Record<ConvergenceType, number> = {
  earthquake: 0, fire: 0, weather: 0, news: 0, conflict: 0, cyber: 0,
};

const quake = (
  lat: number | null, lng: number | null, time: number | null = FRESH, place = 'Somewhere',
) => ({ lat, lng, magnitude: 4.5, place, time });

const fire = (
  lat: number | null, lng: number | null, date: string | null = '2026-11-08', title = 'Wildfire',
) => ({ lat, lng, frp: 10, brightness: 300, confidence: 'high', type: 'wildfire', date, title });

const weather = (
  lat: number | null, lng: number | null, date: string | null = '2026-11-08T06:00:00Z', title = 'Storm',
) => ({ lat, lng, severity: 'high', type: 'storm', title, date });

const gdelt = (
  lat: number | null, lng: number | null, date: string | null = '20261108060000', name = 'Event',
) => ({ lat, lng, country: 'Country', name, root_code: '03', quad: 3, articles: 5, date });

const pin = (
  lat: number | null, lng: number | null, alert_kind = 'rocket',
  published: string | null = '2026-11-08T06:00:00Z', title = 'Rocket strike',
) => ({ coords: [lat, lng], published, alert_kind, title, source_name: 'wire' });

const cyber = (
  lat: number | null, lng: number | null,
  last_online: string | null = '2026-11-08T06:00:00Z', ip = '1.2.3.4',
) => ({ lat, lng, status: 'online', country: 'XX', last_online, ip });

describe('computeConvergence — counting', () => {
  it('buckets three domains into one cell and counts each type', () => {
    const report = computeConvergence({
      earthquakes: [quake(40.2, -74.3), quake(40.3, -74.4)],
      fires: [fire(40.4, -74.6)],
      weather_events: [weather(40.1, -74.2)],
    }, { now: NOW });

    expect(report.considered).toBe(4);
    expect(report.skipped).toBe(0);
    expect(report.cells).toHaveLength(1);

    const cell = report.cells[0];
    expect(cell.distinctTypes).toBe(3);
    expect(cell.eventCount).toBe(4);
    expect(cell.types).toEqual([
      { type: 'earthquake', count: 2 },
      { type: 'fire', count: 1 },
      { type: 'weather', count: 1 },
    ]);
    expect(report.byType).toEqual({
      earthquake: 2, fire: 1, weather: 1, news: 0, conflict: 0, cyber: 0,
    });
    expect(report.windowHours).toBe(24);
    expect(report.generatedAt).toBe(NOW);
  });

  it('maps alert_kind rocket/event to conflict and news to news', () => {
    const report = computeConvergence({
      alert_pins: [
        pin(10.2, 20.2, 'rocket'),
        pin(10.3, 20.3, 'event'),
        pin(10.4, 20.4, 'news'),
      ],
    }, { now: NOW, minTypes: 2 });

    expect(report.byType.conflict).toBe(2);
    expect(report.byType.news).toBe(1);
    expect(report.cells[0].types).toEqual([
      { type: 'conflict', count: 2 },
      { type: 'news', count: 1 },
    ]);
  });

  it('only emits cells that reach minTypes distinct types', () => {
    const twoTypes = {
      earthquakes: [quake(1.2, 2.2)],
      fires: [fire(1.3, 2.3)],
    };

    expect(computeConvergence(twoTypes, { now: NOW }).cells).toHaveLength(0);

    const relaxed = computeConvergence(twoTypes, { now: NOW, minTypes: 2 });
    expect(relaxed.cells).toHaveLength(1);
    expect(relaxed.cells[0].distinctTypes).toBe(2);
  });

  it('drops stale known timestamps but keeps the window boundary', () => {
    const stale = computeConvergence({
      earthquakes: [quake(5.2, 6.2, NOW - 25 * HOUR)],
      fires: [fire(5.3, 6.3, null)],
      weather_events: [weather(5.4, 6.4, null)],
    }, { now: NOW });

    expect(stale.considered).toBe(2);
    expect(stale.skipped).toBe(1);
    expect(stale.byType.earthquake).toBe(0);
    expect(stale.cells).toHaveLength(0);

    const boundary = computeConvergence({
      earthquakes: [quake(5.2, 6.2, NOW - 24 * HOUR)],
      fires: [fire(5.3, 6.3, null)],
      weather_events: [weather(5.4, 6.4, null)],
    }, { now: NOW });
    expect(boundary.cells).toHaveLength(1);
  });

  it('honours a custom windowHours', () => {
    const report = computeConvergence({
      earthquakes: [quake(2.2, 3.2, NOW - 2 * HOUR)],
      fires: [fire(2.3, 3.3, null)],
      weather_events: [weather(2.4, 3.4, '2026-11-08T11:30:00Z')],
    }, { now: NOW, windowHours: 1 });

    expect(report.windowHours).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.considered).toBe(2);
    expect(report.cells).toHaveLength(0);
  });

  it('keeps observations whose timestamp is unknown', () => {
    const report = computeConvergence({
      earthquakes: [quake(7.2, 8.2, null), quake(7.25, 8.25, Number.NaN)],
      fires: [fire(7.3, 8.3, null)],
      weather_events: [weather(7.4, 8.4, null)],
    }, { now: NOW });

    expect(report.skipped).toBe(0);
    expect(report.considered).toBe(4);
    expect(report.cells).toHaveLength(1);
    expect(report.cells[0].latestAt).toBeNull();
  });

  it('skips rows with missing, non-finite or out-of-range coordinates', () => {
    const report = computeConvergence({
      earthquakes: [
        quake(Number.NaN, 2.2),
        quake(91, 2.2),
        quake(0, -181),
        quake(10.2, 20.2),
      ],
      fires: [fire(10.3, 20.3)],
      weather_events: [weather(10.4, 20.4)],
      cyber_attacks: [cyber(null, 20.5)],
    }, { now: NOW });

    expect(report.skipped).toBe(4);
    expect(report.considered).toBe(3);
    expect(report.cells).toHaveLength(1);
    const cell = report.cells[0];
    expect(Number.isFinite(cell.lat)).toBe(true);
    expect(Number.isFinite(cell.lng)).toBe(true);
    expect(report.byType.cyber).toBe(0);
  });

  it('keeps byType totals to accepted observations only', () => {
    const report = computeConvergence({
      earthquakes: [
        quake(10.2, 20.2),
        quake(10.3, 20.3),
        quake(10.4, 20.4, NOW - 30 * HOUR),
      ],
      fires: [fire(11.2, 21.2)],
      weather_events: [weather(12.2, 22.2)],
      cyber_attacks: [cyber(null, 20.5)],
    }, { now: NOW, minTypes: 1 });

    expect(report.byType).toEqual({
      earthquake: 2, fire: 1, weather: 1, news: 0, conflict: 0, cyber: 0,
    });
    expect(report.considered).toBe(4);
    expect(report.skipped).toBe(2);
  });
});

describe('computeConvergence — grid placement', () => {
  it('places negative longitudes in the floor cell and reports its centre', () => {
    const report = computeConvergence({
      earthquakes: [quake(40.2, -74.3)],
      fires: [fire(40.7, -74.9)],
      weather_events: [weather(40.05, -74.01)],
    }, { now: NOW });

    const cell = report.cells[0];
    expect(cell.id).toBe('40:-75');
    expect(cell.cellLat).toBe(40);
    expect(cell.cellLng).toBe(-75);
    expect(cell.lat).toBe(40.5);
    expect(cell.lng).toBe(-74.5);
  });

  it('supports a fractional cellSize', () => {
    const report = computeConvergence({
      earthquakes: [quake(40.2, -74.3)],
      fires: [fire(40.4, -74.1)],
      weather_events: [weather(40.35, -74.5)],
    }, { now: NOW, cellSize: 0.5 });

    const cell = report.cells[0];
    expect(cell.cellLat).toBe(80);
    expect(cell.cellLng).toBe(-149);
    expect(cell.lat).toBeCloseTo(40.25);
    expect(cell.lng).toBeCloseTo(-74.25);
  });
});

describe('computeConvergence — score and level', () => {
  const threeTypes = (quakes: number) => ({
    earthquakes: Array.from({ length: quakes }, (_, i) => quake(1.2 + i * 0.01, 2.2)),
    fires: [fire(1.3, 2.3)],
    weather_events: [weather(1.4, 2.4)],
  });

  it('scores distinctTypes * 25 + min(25, eventCount * 2), clamped at 100', () => {
    // 3 types, 7 events -> 75 + 14 = 89 (still HIGH).
    const high = computeConvergence(threeTypes(5), { now: NOW });
    expect(high.cells[0].score).toBe(89);
    expect(high.cells[0].level).toBe('HIGH');

    // 3 types, 8 events -> 75 + 16 = 91, crosses the CRITICAL score band.
    const critical = computeConvergence(threeTypes(6), { now: NOW });
    expect(critical.cells[0].score).toBe(91);
    expect(critical.cells[0].level).toBe('CRITICAL');
  });

  it('treats four distinct domains as CRITICAL even at low event counts', () => {
    const report = computeConvergence({
      earthquakes: [quake(3.2, 4.2)],
      fires: [fire(3.3, 4.3)],
      weather_events: [weather(3.4, 4.4)],
      gdelt_events: [gdelt(3.5, 4.5)],
    }, { now: NOW });

    expect(report.cells[0].distinctTypes).toBe(4);
    expect(report.cells[0].eventCount).toBe(4);
    expect(report.cells[0].score).toBe(100);
    expect(report.cells[0].level).toBe('CRITICAL');
  });

  it('labels a single-domain cell WATCH and an exact-60 cell HIGH', () => {
    const watch = computeConvergence({
      earthquakes: [quake(6.2, 7.2)],
    }, { now: NOW, minTypes: 1 });
    expect(watch.cells[0].score).toBe(27);
    expect(watch.cells[0].level).toBe('WATCH');

    const highEdge = computeConvergence({
      earthquakes: Array.from({ length: 3 }, (_, i) => quake(6.2 + i * 0.01, 7.2)),
      fires: [fire(6.3, 7.3), fire(6.4, 7.4)],
    }, { now: NOW, minTypes: 2 });
    expect(highEdge.cells[0].score).toBe(60);
    expect(highEdge.cells[0].level).toBe('HIGH');
  });
});

describe('computeConvergence — sorting, capping and tolerance', () => {
  it('sorts by score then event count and caps at 40 cells', () => {
    const boxes = Array.from({ length: 50 }, (_, i) => ({
      earthquakes: Array.from({ length: i + 1 }, (_, j) => quake(i + 0.1 + j * 0.001, 30.2)),
      fires: [fire(i + 0.2, 30.3)],
      weather_events: [weather(i + 0.3, 30.4)],
    }));
    const data = {
      earthquakes: boxes.flatMap(box => box.earthquakes),
      fires: boxes.flatMap(box => box.fires),
      weather_events: boxes.flatMap(box => box.weather_events),
    };

    const capped = computeConvergence(data, { now: NOW });
    expect(capped.cells).toHaveLength(40);
    expect(capped.cells[0].eventCount).toBe(52);
    expect(capped.cells[39].eventCount).toBe(13);
    for (let i = 1; i < capped.cells.length; i++) {
      expect(capped.cells[i - 1].score).toBeGreaterThanOrEqual(capped.cells[i].score);
      if (capped.cells[i - 1].score === capped.cells[i].score) {
        expect(capped.cells[i - 1].eventCount).toBeGreaterThanOrEqual(capped.cells[i].eventCount);
      }
    }

    const topThree = computeConvergence(data, { now: NOW, maxCells: 3 });
    expect(topThree.cells.map(cell => cell.eventCount)).toEqual([52, 51, 50]);
  });

  it('parses GDELT 14-digit UTC dates and keeps malformed ones as unknown', () => {
    const parsed = computeConvergence({
      gdelt_events: [gdelt(1.2, 2.2, '20261108060000')],
      fires: [fire(1.3, 2.3, null)],
      weather_events: [weather(1.4, 2.4, null)],
    }, { now: NOW });
    expect(parsed.cells[0].latestAt).toBe(Date.UTC(2026, 10, 8, 6, 0, 0));

    const malformed = computeConvergence({
      gdelt_events: [{ ...gdelt(1.2, 2.2), date: '20261308060000' }],
      fires: [fire(1.3, 2.3, null)],
      weather_events: [weather(1.4, 2.4, null)],
    }, { now: NOW });
    expect(malformed.skipped).toBe(0);
    expect(malformed.cells[0].latestAt).toBeNull();
  });

  it('builds a labelled sample from every domain in the cell', () => {
    const report = computeConvergence({
      earthquakes: [quake(40.2, -74.3, FRESH, '4.5 km NE of Somewhere')],
      fires: [fire(40.3, -74.4, '2026-11-08', 'Forest fire')],
      weather_events: [weather(40.4, -74.5, '2026-11-08T06:00:00Z', 'Severe storm')],
      gdelt_events: [gdelt(40.5, -74.6, '20261108060000', 'Protest')],
      alert_pins: [pin(40.6, -74.7, 'rocket', '2026-11-08T06:00:00Z', 'Rocket strike')],
      cyber_attacks: [cyber(40.7, -74.8, '2026-11-08T06:00:00Z', '9.9.9.9')],
    }, { now: NOW });

    const cell = report.cells[0];
    expect(cell.distinctTypes).toBe(6);
    expect(cell.eventCount).toBe(6);
    expect(cell.sample).toHaveLength(6);
    expect(cell.sample.map(item => item.label)).toEqual(expect.arrayContaining([
      '4.5 km NE of Somewhere', 'Forest fire', 'Severe storm',
      'Protest', 'Rocket strike', '9.9.9.9',
    ]));
    expect(cell.latestAt).toBe(FRESH);
  });

  it('returns an empty report for missing, null or malformed input', () => {
    for (const input of [undefined, null, {}, [], { earthquakes: 'nope', fires: 42 }]) {
      const report = computeConvergence(input, { now: NOW });
      expect(report.cells).toEqual([]);
      expect(report.considered).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.windowHours).toBe(24);
      expect(report.generatedAt).toBe(NOW);
      expect(report.byType).toEqual(ZERO_BY_TYPE);
    }
  });

  it('uses the current clock when now is omitted', () => {
    const report = computeConvergence({});
    expect(typeof report.generatedAt).toBe('number');
    expect(report.generatedAt).toBeGreaterThan(0);
  });
});
