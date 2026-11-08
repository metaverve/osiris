/**
 * OSIRIS — high-altitude balloon (radiosonde) normaliser.
 *
 * Upstream: SondeHub v2, keyless and gzip-compressed:
 *   GET https://api.v2.sondehub.org/sondes/telemetry?duration=1h
 *
 * The payload is not a list. It is a map of sonde serial → map of ISO
 * timestamp → frame, because radiosondes report hundreds of times per flight
 * and SondeHub keys every observation. The map demonstrates one thing this
 * module exists to fix: the dashboard wants one point per sonde, and the
 * newest observation of that sonde, not twelve hours of track.
 *
 * Pure and dependency-free (no fetch, no Date.now) so the route and the map
 * agree on the wire shape and the parser is testable without a network.
 */

export type BalloonStatus = 'ASCENT' | 'DESCENT' | 'FLOAT';

export interface Balloon {
  callsign: string;
  type: string;
  status: BalloonStatus;
  lat: number;
  lng: number;
  altitude: number;
  speed: number;
  verticalRate: number;
  temperature: number | null;
  color: string;
  datetime: string | null;
}

/** Manufacturer → map marker colour. Vaisala (RS41/RV41) and Graw (DFM) dominate the network. */
const MANUFACTURER_COLORS: Record<string, string> = {
  vaisala: '#00E5FF',
  graw: '#FFB300',
};
const OTHER_COLOR = '#B388FF';

/** m/s → km/h. The map popup speaks km/h, SondeHub reports m/s. */
const MS_TO_KMH = 3.6;

/**
 * Vertical-rate thresholds, in m/s, that separate a climbing sonde from one on
 * the parachute. ±1 m/s is wide enough to absorb GPS jitter on a float.
 */
const ASCENT_THRESHOLD = 1;
const DESCENT_THRESHOLD = -1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Coerce a numeric field. SondeHub is not consistent across uploaders: some
 * software already emits numbers, older auto_rx builds emit strings like
 * "24096.87673". Numeric strings are accepted (the alternative would drop every
 * frame from those uploaders); anything unparseable is rejected as absent.
 */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Timestamp of a frame. The frame's own `datetime` is authoritative; the map
 * key is the fallback for trimmed fixtures/uploaders that omit it.
 */
function frameTime(frame: Record<string, unknown>, key: string): number {
  const raw = text(frame.datetime) ?? text(key);
  if (!raw) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

interface Candidate {
  frame: Record<string, unknown>;
  time: number;
  added: number;
}

/**
 * One newest frame per sonde, sorted newest first.
 *
 * Frames are keyed by timestamp inside each serial map, but JSON object order
 * is not a contract and SondeHub does not guarantee it — compare parsed
 * timestamps instead of trusting insertion order. A sonde can also appear under
 * more than one top-level key (re-upload after a receiver handoff), so the
 * frame's own `serial` wins for deduplication.
 */
export function latestFrames(payload: unknown): unknown[] {
  const bySerial = asRecord(payload);
  if (!bySerial) return [];

  const latest = new Map<string, Candidate>();
  let added = 0;

  for (const [serialKey, frames] of Object.entries(bySerial)) {
    const frameMap = asRecord(frames);
    if (!frameMap) continue;

    for (const [timestampKey, frame] of Object.entries(frameMap)) {
      const record = asRecord(frame);
      if (!record) continue;

      const serial = text(record.serial) ?? serialKey;
      const time = frameTime(record, timestampKey);
      const candidate: Candidate = { frame: record, time, added: added++ };

      const existing = latest.get(serial);
      if (!existing || candidate.time > existing.time || (candidate.time === existing.time && candidate.added > existing.added)) {
        latest.set(serial, candidate);
      }
    }
  }

  return [...latest.values()]
    .sort((a, b) => (a.time === b.time ? a.added - b.added : b.time - a.time))
    .map((candidate) => candidate.frame);
}

/**
 * Normalise one SondeHub frame into the shape OsirisMap's balloon layer and
 * popup consume.
 *
 * Returns null only when there is no usable position: a sonde with non-finite
 * or out-of-range coordinates cannot be plotted, and silently placing it at
 * 0,0 would put a phantom balloon in the Gulf of Guinea. A missing altitude is
 * not fatal — the balloon is still somewhere — so it degrades to 0 m.
 */
export function toBalloon(frame: unknown): Balloon | null {
  const record = asRecord(frame);
  if (!record) return null;

  const lat = num(record.lat);
  const lng = num(record.lon ?? record.lng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  const verticalRate = num(record.vel_v) ?? 0;
  const horizontalRate = num(record.vel_h) ?? 0;
  const manufacturer = (text(record.manufacturer) ?? '').toLowerCase();

  const status: BalloonStatus =
    verticalRate > ASCENT_THRESHOLD ? 'ASCENT' : verticalRate < DESCENT_THRESHOLD ? 'DESCENT' : 'FLOAT';

  return {
    callsign: text(record.uploader_callsign) ?? text(record.serial) ?? 'UNKNOWN',
    type: text(record.type) ?? text(record.subtype) ?? 'UNKNOWN',
    status,
    lat,
    lng,
    altitude: num(record.alt) ?? 0,
    speed: Math.round(horizontalRate * MS_TO_KMH),
    verticalRate,
    temperature: num(record.temp),
    color: MANUFACTURER_COLORS[manufacturer] ?? OTHER_COLOR,
    datetime: text(record.datetime),
  };
}

/** Full parse: newest frame per sonde → plot-ready balloons, newest first. */
export function parseSondeTelemetry(payload: unknown): Balloon[] {
  return latestFrames(payload)
    .map(toBalloon)
    .filter((balloon): balloon is Balloon => balloon !== null);
}
