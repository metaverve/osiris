/**
 * OSIRIS — data-freshness model.
 *
 * The dashboard fetches dozens of feeds on different cadences, some through a
 * server-side cache that silently serves a stale-on-error copy. Nothing in the
 * UI distinguished "fetched two seconds ago" from "fetched an hour ago, then
 * the upstream died" — so this module grades a feed from two facts a caller
 * already has: when it was last fetched, and whether that fetch succeeded.
 *
 * Pure and dependency-free: the same rules run on the server (tests) and in
 * the client HUD, so a stale badge cannot disagree with the wire format.
 */

export type FeedState = 'LIVE' | 'STALE' | 'DOWN' | 'IDLE';

export interface FeedStatus {
  id: string;
  label: string;
  /** Epoch milliseconds of the last successful (or attempted) fetch. */
  fetchedAt: number | null;
  /** Did the most recent fetch succeed? */
  ok: boolean;
  /** How long data may age before it is called STALE. */
  staleAfterMs: number;
  error?: string;
}

export interface FeedFreshness {
  id: string;
  label: string;
  state: FeedState;
  /** Age in ms, null when the feed has never been fetched. */
  ageMs: number | null;
  /** Compact human age — "42s", "6m", "3h", "2d". */
  ageLabel: string;
}

export interface FreshnessSummary {
  feeds: FeedFreshness[];
  live: number;
  stale: number;
  down: number;
  idle: number;
  worst: FeedState;
}

/** Priority order for collapsing many feeds into one headline state. */
const PRIORITY: Record<FeedState, number> = { LIVE: 0, IDLE: 1, STALE: 2, DOWN: 3 };

/** Shown when there is no timestamp to age — never "0s", which would lie. */
const NO_AGE = '—';

/**
 * Compact age label. Floor, not round: 59.9 s reads "59s", not "1m", because
 * the next poll usually arrives before the rounded value would be honest.
 */
export function formatAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return NO_AGE;
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Grade a single feed.
 *
 * Rules, in order:
 *   • no timestamp + not ok        → IDLE (never fetched)
 *   • not ok + a timestamp         → DOWN (last attempt failed)
 *   • age ≤ staleAfterMs           → LIVE (boundary is inclusive)
 *   • age > staleAfterMs           → STALE
 *
 * A timestamp in the future (clock skew, NTP correction) is clamped to zero
 * age rather than reported as a negative duration.
 */
export function describeFeed(feed: FeedStatus, now: number = Date.now()): FeedFreshness {
  const { id, label, fetchedAt, ok, staleAfterMs } = feed;

  if (fetchedAt === null || !Number.isFinite(fetchedAt)) {
    // A "clean" feed with no timestamp is still answering; there is just no age
    // to show. Anything without a timestamp and a failure has never reported.
    return { id, label, state: ok ? 'LIVE' : 'IDLE', ageMs: null, ageLabel: NO_AGE };
  }

  const ageMs = Math.max(0, now - fetchedAt);
  let state: FeedState;
  if (!ok) state = 'DOWN';
  else if (ageMs <= Math.max(0, staleAfterMs)) state = 'LIVE';
  else state = 'STALE';

  return { id, label, state, ageMs, ageLabel: formatAge(ageMs) };
}

/**
 * Grade a set of feeds and count each class. `worst` is the most alarming
 * state present (DOWN > STALE > IDLE > LIVE); an empty set has nothing to
 * warn about, so it reports LIVE.
 */
export function buildFreshness(feeds: FeedStatus[], now: number = Date.now()): FreshnessSummary {
  const described = feeds.map((feed) => describeFeed(feed, now));
  let live = 0;
  let stale = 0;
  let down = 0;
  let idle = 0;
  let worst: FeedState = 'LIVE';

  for (const feed of described) {
    if (feed.state === 'LIVE') live += 1;
    else if (feed.state === 'STALE') stale += 1;
    else if (feed.state === 'DOWN') down += 1;
    else idle += 1;

    if (PRIORITY[feed.state] > PRIORITY[worst]) worst = feed.state;
  }

  return { feeds: described, live, stale, down, idle, worst };
}
