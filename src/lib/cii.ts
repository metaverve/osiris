/**
 * OSIRIS — Country Instability Index, v0.1.
 *
 * A heuristic triage index, not a model. It keeps the editorial `base` score
 * from `country-risk.ts` at 40% and adds 60% live event pressure from feeds the
 * dashboard already holds. Nobody calibrated the baseline or the weights, and
 * the result is not a forecast — it is a way to order twenty countries by
 * "evidence of disruption today".
 *
 * Two honesty rules shape the maths:
 *   1. Missing data is never zero. A component whose feed is absent is `null`
 *      and `coverage` is false; it is not folded in as "0 pressure".
 *   2. When no live feed covers anything, the index falls back to the editorial
 *      baseline instead of pretending the world is calm (which a 0 event score
 *      would imply).
 *
 * Attribution matches country *names* at whole-word boundaries, never the
 * two-letter code: "Papua New Guinea" must not count for Ukraine and "Chad"
 * must not count for anything (see the same trap in country-risk.ts).
 *
 * Normalisation (component score 100 when the raw sum reaches the cap):
 *   conflict    Σ weight · log2(1 + articles);  quad 4 = 1.0, 3 = 0.6, else
 *               0.15; cap 8
 *   unrest      alert_kind rocket 1.0 / event 0.7 / news 0.1; cap 6
 *   information count of attributed alert pins, log-scaled; cap 20
 *   hazards     Σ earthquake magnitude (M ≥ 4); cap 12
 *   cyber       C2 rows whose hosting country equals the ISO code, log-scaled;
 *               cap 10
 *
 * Everything here is pure and client-safe: no network, no DOM, no storage.
 */

import { RISK_FACTORS } from './country-risk';

export type CiiComponent = 'conflict' | 'unrest' | 'information' | 'hazards' | 'cyber';

export interface CiiRow {
  code: string;
  name: string;
  score: number;
  baseline: number;
  eventScore: number;
  level: 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'NORMAL' | 'LOW';
  components: Record<CiiComponent, number | null>;
  coverage: Record<CiiComponent, boolean>;
  delta: number | null;
  deltaAgeMs: number | null;
  tags: string[];
}

export interface CiiReport {
  rows: CiiRow[];
  generatedAt: number;
  methodology: 'cii-v0.1';
  sources: string[];
  coverage: Record<CiiComponent, boolean>;
  disclaimer: string;
}

export interface CiiSnapshot {
  version: 1;
  savedAt: number;
  scores: Record<string, number>;
}

const METHODOLOGY = 'cii-v0.1' as const;

const DISCLAIMER =
  'Heuristic triage index: editorial baseline (40%) + live event pressure (60%) from public feeds. Not calibrated, not a forecast.';

const COMPONENTS: CiiComponent[] = ['conflict', 'unrest', 'information', 'hazards', 'cyber'];

const WEIGHTS: Record<CiiComponent, number> = {
  conflict: 0.35,
  unrest: 0.2,
  information: 0.2,
  hazards: 0.15,
  cyber: 0.1,
};

const CAPS: Record<CiiComponent, number> = {
  conflict: 8,
  unrest: 6,
  information: 20,
  hazards: 12,
  cyber: 10,
};

/** A delta is only meaningful against a snapshot from the recent past. */
const DELTA_MAX_AGE_MS = 48 * 3_600_000;

/** Display names for the twenty tracked codes. `RISK_FACTORS` carries aliases only. */
const DISPLAY_NAMES: Record<string, string> = {
  UA: 'Ukraine',
  RU: 'Russia',
  IL: 'Israel',
  PS: 'Palestine',
  SY: 'Syria',
  YE: 'Yemen',
  MM: 'Myanmar',
  SD: 'Sudan',
  AF: 'Afghanistan',
  KP: 'North Korea',
  IR: 'Iran',
  CN: 'China',
  TW: 'Taiwan',
  VE: 'Venezuela',
  HT: 'Haiti',
  LB: 'Lebanon',
  PK: 'Pakistan',
  SO: 'Somalia',
  LY: 'Libya',
  ET: 'Ethiopia',
};

/* ───────────────────────────── small helpers ───────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null);
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clamp100(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function normaliseLinear(raw: number, cap: number): number {
  return clamp100((raw / cap) * 100);
}

function normaliseLog(raw: number, cap: number): number {
  return clamp100((Math.log2(1 + raw) / Math.log2(1 + cap)) * 100);
}

function levelFor(score: number): CiiRow['level'] {
  if (score >= 81) return 'CRITICAL';
  if (score >= 66) return 'HIGH';
  if (score >= 51) return 'ELEVATED';
  if (score >= 31) return 'NORMAL';
  return 'LOW';
}

/* ──────────────────────────── name attribution ─────────────────────────── */

/** Lowercase words, space-delimited: punctuation becomes a word break. */
function normaliseWords(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Every alias for a tracked code, already normalised. Built once. */
const NAME_INDEX: Array<{ code: string; alias: string }> = Object.entries(RISK_FACTORS).flatMap(
  ([code, factor]) => {
    const aliases = new Set<string>([DISPLAY_NAMES[code] ?? code, ...factor.names]);
    return [...aliases]
      .map(alias => normaliseWords(alias))
      .filter(alias => alias.length > 0)
      .map(alias => ({ code, alias }));
  },
);

/**
 * The code whose country name appears earliest in `text`, or null.
 * Whole-word matching only; the ISO code itself is never matched.
 */
function countryIn(text: string): string | null {
  const haystack = ` ${normaliseWords(text)} `;
  let best: { code: string; at: number } | null = null;
  for (const { code, alias } of NAME_INDEX) {
    const at = haystack.indexOf(` ${alias} `);
    if (at < 0) continue;
    if (best === null || at < best.at) best = { code, at };
  }
  return best === null ? null : best.code;
}

/** First field that names a tracked country decides the attribution. */
function attribute(values: Array<string | null>): string | null {
  for (const value of values) {
    if (!value) continue;
    const code = countryIn(value);
    if (code) return code;
  }
  return null;
}

/* ─────────────────────────────── time window ───────────────────────────── */

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e11) return value; // milliseconds
    if (value >= 1e9) return value * 1000; // seconds
    return null;
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (raw.length === 0) return null;
    if (/^\d+(\.\d+)?$/.test(raw)) return timestampMs(Number(raw));
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * True when the item belongs to the reporting window. Undated items are kept:
 * the feed gave us no timestamp, so dropping them would lose real evidence.
 */
function withinWindow(value: unknown, now: number, windowMs: number): boolean {
  const at = timestampMs(value);
  if (at === null) return true;
  return at >= now - windowMs;
}

/* ──────────────────────────────── pressure ─────────────────────────────── */

type Pressure = Record<CiiComponent, number>;

function emptyPressure(): Pressure {
  return { conflict: 0, unrest: 0, information: 0, hazards: 0, cyber: 0 };
}

function compareToPrevious(
  code: string,
  score: number,
  previous: CiiSnapshot | null | undefined,
  now: number,
): { delta: number | null; deltaAgeMs: number | null } {
  if (!previous || previous.version !== 1) return { delta: null, deltaAgeMs: null };
  const savedAt = asNumber(previous.savedAt);
  const scores = asRecord(previous.scores);
  if (savedAt === null || scores === null) return { delta: null, deltaAgeMs: null };

  const deltaAgeMs = now - savedAt;
  const previousScore = asNumber(scores[code]);
  const fresh = Math.abs(deltaAgeMs) <= DELTA_MAX_AGE_MS && previousScore !== null;
  return {
    delta: fresh ? Math.round(score - previousScore) : null,
    deltaAgeMs,
  };
}

/**
 * Computes the index from a dashboard `data` bag.
 *
 * `data` is whatever `page.tsx` has fetched so far; unknown/partial shapes are
 * read defensively and absent feeds become uncovered components, never zeros.
 * Pass `previous` (a stored snapshot) to get deltas; they are only reported
 * against snapshots no more than 48 hours old.
 */
export function computeCii(
  data: unknown,
  previous?: CiiSnapshot | null,
  opts: { now?: number; windowHours?: number } = {},
): CiiReport {
  const now = typeof opts.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowHours =
    typeof opts.windowHours === 'number' && Number.isFinite(opts.windowHours) && opts.windowHours > 0
      ? opts.windowHours
      : 24;
  const windowMs = windowHours * 3_600_000;

  const root = asRecord(data);
  const gdeltEvents = asRecords(root?.gdelt_events);
  const alertPins = asRecords(root?.alert_pins);
  const earthquakes = asRecords(root?.earthquakes);
  const cyberAttacks = asRecords(root?.cyber_attacks);

  const coverage: Record<CiiComponent, boolean> = {
    conflict: gdeltEvents.length > 0,
    unrest: alertPins.length > 0,
    information: alertPins.length > 0,
    hazards: earthquakes.length > 0,
    cyber: cyberAttacks.length > 0,
  };

  const pressure = new Map<string, Pressure>();
  for (const code of Object.keys(RISK_FACTORS)) pressure.set(code, emptyPressure());

  for (const event of gdeltEvents) {
    if (!withinWindow(event.date, now, windowMs)) continue;
    const code = attribute([asText(event.country), asText(event.name), asText(event.url)]);
    if (!code) continue;
    const quad = asNumber(event.quad);
    const weight = quad === 4 ? 1 : quad === 3 ? 0.6 : 0.15;
    const articles = asNumber(event.articles);
    const count = articles !== null && articles > 0 ? articles : 1;
    pressure.get(code)!.conflict += weight * Math.log2(1 + count);
  }

  for (const item of alertPins) {
    if (!withinWindow(item.published ?? item.date, now, windowMs)) continue;
    const place = asRecord(item.place);
    const code = attribute([
      asText(place?.label),
      asText(place?.name),
      asText(item.title),
    ]);
    if (!code) continue;
    const kind = (asText(item.alert_kind) ?? 'news').toLowerCase();
    const weight = kind === 'rocket' ? 1 : kind === 'event' ? 0.7 : 0.1;
    const target = pressure.get(code)!;
    target.unrest += weight;
    target.information += 1;
  }

  for (const row of earthquakes) {
    const properties = asRecord(row.properties);
    const place = asText(row.place) ?? asText(properties?.place);
    const magnitude = asNumber(row.magnitude) ?? asNumber(properties?.mag);
    if (!place || magnitude === null || magnitude < 4) continue;
    if (!withinWindow(row.time ?? properties?.time, now, windowMs)) continue;
    const code = attribute([place]);
    if (!code) continue;
    pressure.get(code)!.hazards += magnitude;
  }

  for (const row of cyberAttacks) {
    const code = asText(row.country)?.toUpperCase();
    if (!code || !RISK_FACTORS[code]) continue;
    pressure.get(code)!.cyber += 1;
  }

  const rows: CiiRow[] = Object.keys(RISK_FACTORS).map(code => {
    const factor = RISK_FACTORS[code];
    const raw = pressure.get(code)!;

    const components: Record<CiiComponent, number | null> = {
      conflict: coverage.conflict ? normaliseLinear(raw.conflict, CAPS.conflict) : null,
      unrest: coverage.unrest ? normaliseLinear(raw.unrest, CAPS.unrest) : null,
      information: coverage.information ? normaliseLog(raw.information, CAPS.information) : null,
      hazards: coverage.hazards ? normaliseLinear(raw.hazards, CAPS.hazards) : null,
      cyber: coverage.cyber ? normaliseLog(raw.cyber, CAPS.cyber) : null,
    };

    const available = COMPONENTS.filter(component => components[component] !== null);
    const weightSum = available.reduce((sum, component) => sum + WEIGHTS[component], 0);
    /* Renormalise over what is covered. With no live coverage at all, fall
       back to the editorial baseline rather than scoring the absence of data
       as an absence of pressure. */
    const eventScore =
      weightSum > 0
        ? available.reduce(
            (sum, component) => sum + (components[component] as number) * WEIGHTS[component],
            0,
          ) / weightSum
        : factor.base;

    const score = clamp100(Math.round(factor.base * 0.4 + eventScore * 0.6));
    const { delta, deltaAgeMs } = compareToPrevious(code, score, previous, now);

    return {
      code,
      name: DISPLAY_NAMES[code] ?? code,
      score,
      baseline: factor.base,
      eventScore,
      level: levelFor(score),
      components,
      coverage: { ...coverage },
      delta,
      deltaAgeMs,
      tags: [...factor.tags],
    };
  });

  rows.sort((a, b) => b.score - a.score || b.baseline - a.baseline || a.code.localeCompare(b.code));

  const sources: string[] = [];
  if (coverage.conflict) sources.push('GDELT 1.0 events');
  if (coverage.unrest || coverage.information) sources.push('OSIRIS live news (alert pins)');
  if (coverage.hazards) sources.push('USGS earthquakes');
  if (coverage.cyber) sources.push('abuse.ch Feodo Tracker (C2 hosting)');

  return {
    rows,
    generatedAt: now,
    methodology: METHODOLOGY,
    sources,
    coverage,
    disclaimer: DISCLAIMER,
  };
}
