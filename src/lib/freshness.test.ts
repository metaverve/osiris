import { describe, it, expect } from 'vitest';
import { buildFreshness, describeFeed, formatAge, type FeedStatus } from './freshness';

/** Fixed clock, so every assertion is about the model, not about wall time. */
const NOW = 1_700_000_000_000;

function feed(over: Partial<FeedStatus> = {}): FeedStatus {
  return {
    id: 'flights',
    label: 'FLIGHTS',
    fetchedAt: NOW - 5_000,
    ok: true,
    staleAfterMs: 60_000,
    ...over,
  };
}

describe('describeFeed', () => {
  it('calls a feed that has never reported idle', () => {
    const f = describeFeed(feed({ fetchedAt: null, ok: false }), NOW);
    expect(f).toMatchObject({ state: 'IDLE', ageMs: null });
  });

  it('calls a failed feed with a timestamp down', () => {
    const f = describeFeed(feed({ ok: false, error: 'HTTP 503' }), NOW);
    expect(f.state).toBe('DOWN');
    expect(f.ageMs).toBe(5_000);
  });

  it('calls recent data live', () => {
    expect(describeFeed(feed(), NOW).state).toBe('LIVE');
  });

  it('calls data older than the threshold stale', () => {
    const f = describeFeed(feed({ fetchedAt: NOW - 90_000 }), NOW);
    expect(f.state).toBe('STALE');
    expect(f.ageMs).toBe(90_000);
  });

  // The boundary is inclusive: exactly staleAfterMs old is still acceptable.
  it('keeps the feed live at exactly the staleness boundary', () => {
    expect(describeFeed(feed({ fetchedAt: NOW - 60_000 }), NOW).state).toBe('LIVE');
    expect(describeFeed(feed({ fetchedAt: NOW - 60_001 }), NOW).state).toBe('STALE');
  });

  // Client and server clocks disagree; a future stamp is skew, not time travel.
  it('clamps a future timestamp to zero age instead of going negative', () => {
    const f = describeFeed(feed({ fetchedAt: NOW + 30_000 }), NOW);
    expect(f.state).toBe('LIVE');
    expect(f.ageMs).toBe(0);
    expect(f.ageLabel).toBe('0s');
  });

  // A healthy feed with no stamp has an answer but no age to show.
  it('shows a dash rather than an age when there is no timestamp', () => {
    const f = describeFeed(feed({ fetchedAt: null, ok: true }), NOW);
    expect(f.state).toBe('LIVE');
    expect(f.ageMs).toBeNull();
    expect(f.ageLabel).toBe('—');
  });
});

describe('formatAge', () => {
  it('uses seconds under a minute', () => {
    expect(formatAge(42_000)).toBe('42s');
  });

  it('uses minutes under an hour', () => {
    expect(formatAge(6 * 60_000 + 30_000)).toBe('6m');
  });

  it('uses hours under a day', () => {
    expect(formatAge(3 * 3_600_000 + 59 * 60_000)).toBe('3h');
  });

  it('uses days beyond that', () => {
    expect(formatAge(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d');
  });

  it('floors rather than rounds', () => {
    expect(formatAge(59_999)).toBe('59s');
    expect(formatAge(1_000)).toBe('1s');
    expect(formatAge(0)).toBe('0s');
  });

  it('has no age for a missing or negative value', () => {
    expect(formatAge(null)).toBe('—');
    expect(formatAge(-1)).toBe('—');
  });
});

describe('buildFreshness', () => {
  it('returns empty counters and the least alarming worst state for no feeds', () => {
    const out = buildFreshness([], NOW);
    expect(out.feeds).toEqual([]);
    expect(out).toMatchObject({ live: 0, stale: 0, down: 0, idle: 0, worst: 'LIVE' });
  });

  it('counts each state once', () => {
    const out = buildFreshness(
      [
        feed({ id: 'a' }),
        feed({ id: 'b', fetchedAt: NOW - 120_000 }),
        feed({ id: 'c', ok: false }),
        feed({ id: 'd', fetchedAt: null, ok: false }),
      ],
      NOW,
    );
    expect(out).toMatchObject({ live: 1, stale: 1, down: 1, idle: 1 });
    expect(out.feeds.map((f) => f.state)).toEqual(['LIVE', 'STALE', 'DOWN', 'IDLE']);
  });

  it('orders worst DOWN over STALE over IDLE over LIVE', () => {
    const stateFor = (...states: FeedStatus[]) => buildFreshness(states, NOW).worst;
    const live = feed({ id: 'live' });
    const idle = feed({ id: 'idle', fetchedAt: null, ok: false });
    const stale = feed({ id: 'stale', fetchedAt: NOW - 120_000 });
    const down = feed({ id: 'down', ok: false });

    expect(stateFor(down, stale, idle, live)).toBe('DOWN');
    expect(stateFor(stale, idle, live)).toBe('STALE');
    expect(stateFor(idle, live)).toBe('IDLE');
    expect(stateFor(live)).toBe('LIVE');
  });

  it('is independent of feed order', () => {
    const feeds = [feed({ id: 'live' }), feed({ id: 'down', ok: false }), feed({ id: 'stale', fetchedAt: NOW - 120_000 })];
    expect(buildFreshness(feeds, NOW).worst).toBe('DOWN');
    expect(buildFreshness([...feeds].reverse(), NOW).worst).toBe('DOWN');
  });
});
