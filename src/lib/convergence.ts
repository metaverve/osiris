/**
 * OSIRIS — cross-domain convergence ("flashpoints").
 *
 * This is a heuristic, not a forecast. It counts *how many different feeds
 * report something in the same one-degree box within a rolling window*. Three
 * feeds in one box is unusual and worth a look; it is not evidence that the
 * events are related, and a high score does not predict escalation. Two
 * unrelated things happen near each other all the time — a wildfire and a
 * weather alert in the same cell are common in fire season, an earthquake and
 * a news event in the same cell are coincidence unless the report says
 * otherwise. The number is a sorting order for an operator's attention.
 *
 * What it does: reads the client data bag (all keys optional), keeps every
 * observation with valid coordinates and an unknown-or-recent timestamp,
 * buckets those into a configurable grid (1° cells by default: index =
 * `floor(coordinate / cellSize)`, centre = index * size + size / 2), and emits
 * only the cells where `minTypes` (default 3) distinct domains co-occur.
 *
 * Score: `distinctTypes * 25 + min(25, eventCount * 2)`, clamped to 0–100.
 * Level: CRITICAL when the score reaches 90 or four domains co-occur, HIGH at
 * 60+, WATCH below. `byType` is the number of accepted observations per type;
 * `considered` is their total and `skipped` counts rows this module rejected
 * (bad coordinates, or a known timestamp older than the window). Rows with no
 * timestamp are kept — "unknown" is not "old".
 *
 * Source → domain mapping (one domain per feed):
 *   earthquakes     → earthquake   (time in ms)
 *   fires           → fire         (`date` = YYYY-MM-DD, UTC)
 *   weather_events  → weather      (`date` = ISO/RFC string, when present)
 *   gdelt_events    → news         (`date` = GDELT 14-digit UTC, or ISO)
 *   alert_pins      → conflict     (`alert_kind` rocket/event) or news (otherwise)
 *   cyber_attacks   → cyber        (`last_online` ISO or null)
 *
 * The alert path deliberately reads `alert_kind`: a rocket/missile report is a
 * conflict signal, while a plain news alert is the same information domain as
 * the GDELT feed. That keeps "conflict" from being double-counted three times.
 */

export type ConvergenceType = 'earthquake' | 'fire' | 'weather' | 'news' | 'conflict' | 'cyber';

export interface ConvergenceCell {
  /** Grid key, `${cellLat}:${cellLng}`. */
  id: string;
  /** Cell centre, where the map should fly. */
  lat: number;
  lng: number;
  /** Integer grid index (floor of coordinate divided by cell size). */
  cellLat: number;
  cellLng: number;
  types: Array<{ type: ConvergenceType; count: number }>;
  eventCount: number;
  distinctTypes: number;
  score: number;
  level: 'CRITICAL' | 'HIGH' | 'WATCH';
  /** Newest known timestamp in the cell, or null when every row's time is unknown. */
  latestAt: number | null;
  /** A few of the observations behind the cell, newest first. */
  sample: Array<{ type: ConvergenceType; label: string; time: number | null }>;
}

export interface ConvergenceReport {
  cells: ConvergenceCell[];
  generatedAt: number;
  windowHours: number;
  considered: number;
  skipped: number;
  byType: Record<ConvergenceType, number>;
}

const TYPES: ConvergenceType[] = ['earthquake', 'fire', 'weather', 'news', 'conflict', 'cyber'];
const HOUR_MS = 3_600_000;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_MIN_TYPES = 3;
const DEFAULT_CELL_SIZE = 1;
const DEFAULT_MAX_CELLS = 40;
const SAMPLE_LIMIT = 6;
const GDELT_DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

type Row = Record<string, unknown>;

interface Observation {
  type: ConvergenceType;
  lat: number;
  lng: number;
  time: number | null;
  label: string;
}

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? value : fallback;
}

/** A coordinate as a number, or null when it is missing, blank or non-finite. */
function coord(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Point from two raw values, validated against the geographic range. */
function pointOf(latValue: unknown, lngValue: unknown): { lat: number; lng: number } | null {
  const lat = coord(latValue);
  const lng = coord(lngValue);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Milliseconds for a numeric or ISO/RFC string timestamp; null when unknown. */
function epoch(value: unknown): number | null {
  if (isFiniteNumber(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** GDELT dates are `YYYYMMDDHHMMSS` UTC; anything else falls back to ISO parsing. */
function gdeltEpoch(value: unknown): number | null {
  if (typeof value === 'string') {
    const match = GDELT_DATE.exec(value.trim());
    if (match) {
      const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
      if (
        month >= 1 && month <= 12 && day >= 1 && day <= 31 &&
        hour < 24 && minute < 60 && second < 60
      ) {
        return Date.UTC(year, month - 1, day, hour, minute, second);
      }
      return null;
    }
  }
  return epoch(value);
}

interface ParsedRows {
  observations: Observation[];
  skipped: number;
}

/** Applies one feed's row reader, then the coordinate/window filters. */
function observe(
  rows: unknown[],
  fallbackType: ConvergenceType,
  read: (row: Row) => (Omit<Observation, 'type'> & { type?: ConvergenceType }) | null,
  cutoff: number,
): ParsedRows {
  const observations: Observation[] = [];
  let skipped = 0;

  for (const raw of rows) {
    const parsed = isRecord(raw) ? read(raw) : null;
    if (!parsed) {
      skipped++;
      continue;
    }
    if (parsed.time !== null && parsed.time < cutoff) {
      skipped++;
      continue;
    }
    const { type: explicitType, ...rest } = parsed;
    observations.push({ type: explicitType ?? fallbackType, ...rest });
  }

  return { observations, skipped };
}

function collect(data: unknown, cutoff: number): ParsedRows {
  const bag = isRecord(data) ? data : {};
  const source = (key: string): unknown[] => {
    const rows = bag[key];
    return Array.isArray(rows) ? rows : [];
  };

  const result: ParsedRows = { observations: [], skipped: 0 };
  const merge = (parsed: ParsedRows) => {
    result.observations.push(...parsed.observations);
    result.skipped += parsed.skipped;
  };

  merge(observe(source('earthquakes'), 'earthquake', row => {
    const point = pointOf(row.lat, row.lng);
    if (!point) return null;
    return { ...point, time: epoch(row.time), label: text(row.place) ?? 'Earthquake' };
  }, cutoff));

  merge(observe(source('fires'), 'fire', row => {
    const point = pointOf(row.lat, row.lng);
    if (!point) return null;
    return { ...point, time: epoch(row.date), label: text(row.title) ?? 'Wildfire' };
  }, cutoff));

  merge(observe(source('weather_events'), 'weather', row => {
    const point = pointOf(row.lat, row.lng);
    if (!point) return null;
    return {
      ...point,
      time: epoch(row.date),
      label: text(row.title) ?? text(row.type) ?? 'Weather event',
    };
  }, cutoff));

  merge(observe(source('gdelt_events'), 'news', row => {
    const point = pointOf(row.lat, row.lng);
    if (!point) return null;
    return {
      ...point,
      time: gdeltEpoch(row.date),
      label: text(row.name) ?? text(row.country) ?? 'GDELT event',
    };
  }, cutoff));

  merge(observe(source('alert_pins'), 'news', row => {
    const coords = Array.isArray(row.coords) ? row.coords : null;
    const point = coords ? pointOf(coords[0], coords[1]) : null;
    if (!point) return null;
    const kind = text(row.alert_kind);
    return {
      type: kind === 'rocket' || kind === 'event' ? 'conflict' : 'news',
      ...point,
      time: epoch(row.published),
      label: text(row.title) ?? text(row.source_name) ?? 'Alert',
    };
  }, cutoff));

  merge(observe(source('cyber_attacks'), 'cyber', row => {
    const point = pointOf(row.lat, row.lng);
    if (!point) return null;
    return {
      ...point,
      time: epoch(row.last_online),
      label: text(row.ip) ?? text(row.country) ?? 'C2 indicator',
    };
  }, cutoff));

  return result;
}

function buildCell(id: string, group: Observation[], cellSize: number): ConvergenceCell {
  const first = group[0];
  const cellLat = Math.floor(first.lat / cellSize);
  const cellLng = Math.floor(first.lng / cellSize);

  const counts = new Map<ConvergenceType, number>();
  let latestAt: number | null = null;
  for (const observation of group) {
    counts.set(observation.type, (counts.get(observation.type) ?? 0) + 1);
    if (observation.time !== null && (latestAt === null || observation.time > latestAt)) {
      latestAt = observation.time;
    }
  }

  const types = [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || TYPES.indexOf(a.type) - TYPES.indexOf(b.type));

  const distinctTypes = types.length;
  const eventCount = group.length;
  const score = Math.min(100, distinctTypes * 25 + Math.min(25, eventCount * 2));
  const level: ConvergenceCell['level'] =
    score >= 90 || distinctTypes >= 4 ? 'CRITICAL' : score >= 60 ? 'HIGH' : 'WATCH';

  const sample = [...group]
    .sort((a, b) => {
      if (a.time === b.time) return 0;
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return b.time - a.time;
    })
    .slice(0, SAMPLE_LIMIT)
    .map(observation => ({
      type: observation.type,
      label: observation.label,
      time: observation.time,
    }));

  return {
    id,
    lat: cellLat * cellSize + cellSize / 2,
    lng: cellLng * cellSize + cellSize / 2,
    cellLat,
    cellLng,
    types,
    eventCount,
    distinctTypes,
    score,
    level,
    latestAt,
    sample,
  };
}

/**
 * Computes the convergence report for a client data bag.
 *
 * Pure and client-safe: no imports, no DOM and no clock beyond `Date.now()`
 * when `opts.now` is omitted, so a caller can pin a test or a re-render to one
 * instant.
 */
export function computeConvergence(
  data: unknown,
  opts: {
    now?: number;
    windowHours?: number;
    minTypes?: number;
    cellSize?: number;
    maxCells?: number;
  } = {},
): ConvergenceReport {
  const now = isFiniteNumber(opts.now) ? opts.now : Date.now();
  const windowHours = positive(opts.windowHours, DEFAULT_WINDOW_HOURS);
  const minTypes = Math.max(1, Math.floor(positive(opts.minTypes, DEFAULT_MIN_TYPES)));
  const cellSize = positive(opts.cellSize, DEFAULT_CELL_SIZE);
  const maxCells = isFiniteNumber(opts.maxCells) && opts.maxCells >= 0
    ? Math.floor(opts.maxCells)
    : DEFAULT_MAX_CELLS;

  const cutoff = now - windowHours * HOUR_MS;
  const { observations, skipped } = collect(data, cutoff);

  const byType = {} as Record<ConvergenceType, number>;
  for (const type of TYPES) byType[type] = 0;
  for (const observation of observations) byType[observation.type] += 1;

  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    const cellLat = Math.floor(observation.lat / cellSize);
    const cellLng = Math.floor(observation.lng / cellSize);
    const id = `${cellLat}:${cellLng}`;
    const group = groups.get(id);
    if (group) group.push(observation);
    else groups.set(id, [observation]);
  }

  const cells: ConvergenceCell[] = [];
  for (const [id, group] of groups) {
    const cell = buildCell(id, group, cellSize);
    if (cell.distinctTypes >= minTypes) cells.push(cell);
  }

  cells.sort(
    (a, b) =>
      b.score - a.score ||
      b.eventCount - a.eventCount ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return {
    cells: cells.slice(0, maxCells),
    generatedAt: now,
    windowHours,
    considered: observations.length,
    skipped,
    byType,
  };
}
