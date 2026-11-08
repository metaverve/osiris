'use client';

import { useMemo } from 'react';
import { buildFreshness, type FeedState, type FeedStatus } from '@/lib/freshness';

/**
 * OSIRIS — data-freshness HUD strip.
 *
 * A slim horizontal readout of every feed the dashboard is polling: one dot per
 * feed, coloured by the model in lib/freshness, with its compact age. It is
 * deliberately stateless — page.tsx owns the fetch bookkeeping and passes the
 * current `FeedStatus[]` in, so the strip cannot disagree with the data bag.
 */

/** Alert ramp pulled from the same CSS variables as the map and status bar. */
const DOT_COLOR: Record<FeedState, string> = {
  LIVE: 'var(--alert-green)',
  STALE: 'var(--alert-orange)',
  DOWN: 'var(--alert-red)',
  IDLE: 'var(--text-muted)',
};

export default function FreshnessStrip({
  feeds,
  compact = false,
}: {
  feeds: FeedStatus[];
  compact?: boolean;
}) {
  const summary = useMemo(() => buildFreshness(feeds), [feeds]);

  // Nothing to report: stay out of the HUD entirely.
  if (summary.feeds.length === 0) return null;

  return (
    <div
      role="status"
      aria-label={`Data freshness: ${summary.worst.toLowerCase()}`}
      className={`glass-panel pointer-events-auto flex items-center gap-3 overflow-x-auto whitespace-nowrap px-3 font-mono uppercase tracking-wider ${
        compact ? 'h-7 text-[9px]' : 'h-9 text-[10px]'
      }`}
    >
      <span className="hud-label shrink-0" aria-hidden="true">
        Feeds
      </span>

      {summary.feeds.map((feed) => (
        <span
          key={feed.id}
          className="flex shrink-0 items-center gap-1.5"
          title={`${feed.label}: ${feed.state} (${feed.ageLabel})`}
          aria-label={`${feed.label}: ${feed.state}${feed.ageMs === null ? '' : `, age ${feed.ageLabel}`}`}
        >
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor: DOT_COLOR[feed.state],
              boxShadow: feed.state === 'LIVE' ? `0 0 6px ${DOT_COLOR[feed.state]}` : undefined,
            }}
          />
          <span className="text-[var(--text-secondary)]">{feed.label}</span>
          <span style={{ color: DOT_COLOR[feed.state] }}>{feed.ageLabel}</span>
        </span>
      ))}

      <span
        className="ml-auto shrink-0 pl-2"
        style={{ color: DOT_COLOR[summary.worst] }}
        title={`${summary.live} live · ${summary.stale} stale · ${summary.down} down · ${summary.idle} idle`}
      >
        {summary.worst}
      </span>
    </div>
  );
}
