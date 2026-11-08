import { describe, it, expect } from 'vitest';
import { computeCii, type CiiReport, type CiiRow } from './cii';

/*
 * Fixtures use a frozen "now" so window filtering and delta ages are exact.
 * Every feed item carries a timestamp inside the default 24 h window unless a
 * test deliberately moves it.
 */
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01T12:00:00Z
const HOUR = 3_600_000;
const INSIDE = new Date(NOW - HOUR).toISOString();

const gdeltEvent = (over: Record<string, unknown> = {}) => ({
  country: 'Ukraine',
  name: 'Kyiv, Ukraine',
  url: 'https://example.invalid/story',
  quad: 4,
  articles: 1,
  date: INSIDE,
  ...over,
});

const alertPin = (over: Record<string, unknown> = {}) => ({
  alert_kind: 'rocket',
  place: { label: 'Kyiv, Ukraine', name: 'Kyiv' },
  title: 'Air raid warning in the capital',
  published: INSIDE,
  ...over,
});

const earthquake = (over: Record<string, unknown> = {}) => ({
  place: '10km SSE of Herat, Afghanistan',
  magnitude: 5,
  time: NOW - HOUR,
  ...over,
});

const cyberAttack = (country: unknown) => ({ country });

function rowOf(report: CiiReport, code: string): CiiRow {
  const row = report.rows.find(candidate => candidate.code === code);
  if (!row) throw new Error(`no row for ${code}`);
  return row;
}

function positiveCodes(report: CiiReport, component: keyof CiiRow['components']): string[] {
  return report.rows.filter(row => (row.components[component] ?? 0) > 0).map(row => row.code);
}

describe('computeCii attribution', () => {
  it('attributes GDELT events by country name, with name as fallback', () => {
    const report = computeCii(
      {
        gdelt_events: [
          gdeltEvent(),
          gdeltEvent({ country: 'Atlantis', name: 'Kharkiv, Ukraine', articles: 1 }),
        ],
      },
      null,
      { now: NOW },
    );

    expect(rowOf(report, 'UA').coverage.conflict).toBe(true);
    expect(rowOf(report, 'UA').components.conflict).toBeGreaterThan(0);
    expect(positiveCodes(report, 'conflict')).toEqual(['UA']);
  });

  it('attributes live news by OSM place label', () => {
    const report = computeCii({ alert_pins: [alertPin()] }, null, { now: NOW });

    expect(rowOf(report, 'UA').components.unrest).toBeCloseTo((1 / 6) * 100, 10);
    expect(rowOf(report, 'UA').components.information).toBeCloseTo(
      (Math.log2(2) / Math.log2(21)) * 100,
      10,
    );
    expect(report.coverage.unrest).toBe(true);
    expect(report.coverage.information).toBe(true);
  });

  it('falls back to the item title when a news item has no place', () => {
    const report = computeCii(
      { alert_pins: [alertPin({ place: null, title: 'Shelling continues across Lebanon' })] },
      null,
      { now: NOW },
    );

    expect(rowOf(report, 'LB').components.unrest).toBeGreaterThan(0);
    expect(positiveCodes(report, 'unrest')).toEqual(['LB']);
  });

  it('attributes earthquakes by USGS place string', () => {
    const report = computeCii({ earthquakes: [earthquake()] }, null, { now: NOW });

    expect(rowOf(report, 'AF').components.hazards).toBeCloseTo((5 / 12) * 100, 10);
    expect(rowOf(report, 'AF').coverage.hazards).toBe(true);
    expect(positiveCodes(report, 'hazards')).toEqual(['AF']);
  });

  it('never matches on a two-letter code or a partial word', () => {
    const report = computeCii(
      {
        gdelt_events: [gdeltEvent({ country: 'Chad', name: 'N’Djamena', articles: 9 })],
        earthquakes: [
          earthquake({ place: 'Papua New Guinea region', magnitude: 7 }),
          earthquake({ place: 'Lake Chad', magnitude: 6 }),
        ],
      },
      null,
      { now: NOW },
    );

    // "Papua New Guinea" contains "ua" and "Lake Chad" contains "ad", but
    // attribution is by whole country names only.
    expect(positiveCodes(report, 'hazards')).toEqual([]);
    expect(positiveCodes(report, 'conflict')).toEqual([]);
    expect(rowOf(report, 'UA').components.hazards).toBe(0);
  });
});

describe('computeCii coverage honesty', () => {
  it('reports an uncovered component as null but a covered zero as 0', () => {
    const report = computeCii({ earthquakes: [earthquake()] }, null, { now: NOW });

    const ua = rowOf(report, 'UA');
    expect(ua.components.conflict).toBeNull();
    expect(ua.components.unrest).toBeNull();
    expect(ua.components.information).toBeNull();
    expect(ua.components.cyber).toBeNull();
    expect(ua.coverage.conflict).toBe(false);
    expect(ua.coverage.unrest).toBe(false);
    expect(ua.coverage.cyber).toBe(false);

    // The quake feed is present, so "no quake here" is a real zero, not unknown.
    expect(ua.components.hazards).toBe(0);
    expect(ua.coverage.hazards).toBe(true);
  });

  it('emits all twenty baseline rows with no coverage when data is empty', () => {
    const report = computeCii({}, null, { now: NOW });

    expect(report.rows).toHaveLength(20);
    expect(report.coverage).toEqual({
      conflict: false,
      unrest: false,
      information: false,
      hazards: false,
      cyber: false,
    });
    expect(report.sources).toEqual([]);
    expect(report.methodology).toBe('cii-v0.1');
    expect(report.generatedAt).toBe(NOW);

    for (const row of report.rows) {
      expect(Object.values(row.components).every(value => value === null)).toBe(true);
      expect(row.score).toBe(row.baseline);
      expect(row.eventScore).toBe(row.baseline);
      expect(Number.isInteger(row.score)).toBe(true);
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
    }
  });

  it('lists only the feeds that actually contributed', () => {
    const report = computeCii(
      { gdelt_events: [gdeltEvent()], earthquakes: [earthquake()] },
      null,
      { now: NOW },
    );

    expect(report.sources).toEqual(['GDELT 1.0 events', 'USGS earthquakes']);
    expect(report.disclaimer).toContain('Not calibrated, not a forecast.');
  });
});

describe('computeCii scoring', () => {
  it('caps every component at 100', () => {
    const report = computeCii(
      {
        gdelt_events: Array.from({ length: 8 }, () => gdeltEvent()),
        alert_pins: [
          ...Array.from({ length: 6 }, () => alertPin()),
          ...Array.from({ length: 14 }, () => alertPin({ alert_kind: 'news' })),
        ],
        earthquakes: [earthquake({ place: 'near Kyiv, Ukraine', magnitude: 6 }), earthquake({ place: 'near Lviv, Ukraine', magnitude: 6 })],
        cyber_attacks: Array.from({ length: 10 }, () => cyberAttack('UA')),
      },
      null,
      { now: NOW },
    );

    const ua = rowOf(report, 'UA');
    expect(ua.components.conflict).toBe(100);
    expect(ua.components.unrest).toBe(100);
    expect(ua.components.information).toBe(100);
    expect(ua.components.hazards).toBe(100);
    expect(ua.components.cyber).toBe(100);
    expect(ua.eventScore).toBe(100);
    expect(ua.score).toBeLessThanOrEqual(100);
  });

  it('renormalises component weights over available components only', () => {
    const report = computeCii({ gdelt_events: [gdeltEvent()] }, null, { now: NOW });
    const ua = rowOf(report, 'UA');

    // One quad-4 event with one article: log2(2)/8 = 12.5 on the 0-100 scale.
    expect(ua.components.conflict).toBeCloseTo(12.5, 10);
    // Only conflict is covered, so its 0.35 weight is renormalised to 1.0.
    expect(ua.eventScore).toBeCloseTo(12.5, 10);
    expect(ua.score).toBe(42); // round(85*0.4 + 12.5*0.6) = round(41.5)
    expect(ua.score).toBeGreaterThan(34); // not diluted by missing components
  });

  it('assigns the documented level bands', () => {
    const empty = computeCii({}, null, { now: NOW });
    expect(rowOf(empty, 'UA').level).toBe('CRITICAL'); // 85
    expect(rowOf(empty, 'RU').level).toBe('HIGH'); // 72
    expect(rowOf(empty, 'ET').level).toBe('ELEVATED'); // 62
    expect(rowOf(empty, 'CN').level).toBe('NORMAL'); // 35

    // A covered feed with zero pressure pushes a low baseline into LOW.
    const quiet = computeCii(
      { earthquakes: [earthquake({ place: 'Somewhere uninhabited', magnitude: 4.1 })] },
      null,
      { now: NOW },
    );
    expect(rowOf(quiet, 'CN').score).toBe(14); // round(35 * 0.4)
    expect(rowOf(quiet, 'CN').level).toBe('LOW');
  });

  it('sorts rows by descending score', () => {
    const scores = computeCii({}, null, { now: NOW }).rows.map(row => row.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('honours the reporting window and keeps undated items', () => {
    const stale = gdeltEvent({ date: new Date(NOW - 48 * HOUR).toISOString() });

    const narrow = computeCii({ gdelt_events: [stale] }, null, { now: NOW });
    expect(rowOf(narrow, 'UA').coverage.conflict).toBe(true);
    expect(rowOf(narrow, 'UA').components.conflict).toBe(0);

    const wide = computeCii({ gdelt_events: [stale] }, null, { now: NOW, windowHours: 72 });
    expect(rowOf(wide, 'UA').components.conflict).toBeGreaterThan(0);

    const undated = computeCii({ gdelt_events: [gdeltEvent({ date: undefined })] }, null, {
      now: NOW,
    });
    expect(rowOf(undated, 'UA').components.conflict).toBeGreaterThan(0);
  });
});

describe('computeCii deltas', () => {
  it('reports a delta against a recent snapshot', () => {
    const previous = { version: 1 as const, savedAt: NOW - 2 * HOUR, scores: { UA: 80 } };
    const report = computeCii({}, previous, { now: NOW });

    expect(rowOf(report, 'UA').delta).toBe(5); // 85 - 80
    expect(rowOf(report, 'UA').deltaAgeMs).toBe(2 * HOUR);
    expect(rowOf(report, 'RU').delta).toBeNull(); // not in the snapshot
  });

  it('suppresses the delta when the snapshot is older than 48 hours', () => {
    const previous = { version: 1 as const, savedAt: NOW - 49 * HOUR, scores: { UA: 80 } };
    const report = computeCii({}, previous, { now: NOW });

    expect(rowOf(report, 'UA').delta).toBeNull();
    expect(rowOf(report, 'UA').deltaAgeMs).toBe(49 * HOUR);
  });

  it('has no delta without a snapshot', () => {
    const report = computeCii({}, null, { now: NOW });
    expect(rowOf(report, 'UA').delta).toBeNull();
    expect(rowOf(report, 'UA').deltaAgeMs).toBeNull();
  });
});
