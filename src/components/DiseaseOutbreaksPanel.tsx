'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, ChevronDown, ChevronUp, ExternalLink, MapPin } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════════
   OSIRIS — WHO Disease Outbreak News panel
   Official bulletins, newest first. WHO publishes no severity
   field for DONs, so none is shown: ranking would be invented.
   ═══════════════════════════════════════════════════════════════ */

/** The bulletin fields this panel renders — see lib/disease-outbreaks. */
interface BulletinRow {
  id?: string;
  title?: string;
  published?: string;
  summary?: string;
  url?: string;
  country?: { name?: string } | null;
  lat?: number | null;
  lng?: number | null;
}

interface DiseaseOutbreaksPanelProps {
  data: unknown;
  onLocate?: (lat: number, lng: number) => void;
}

/** Newest first; undated bulletins sort last rather than claiming "now". */
function newestFirst(rows: BulletinRow[]): BulletinRow[] {
  const at = (v: unknown): number => {
    const ms = Date.parse(String(v ?? ''));
    return Number.isNaN(ms) ? 0 : ms;
  };
  return [...rows].sort((a, b) => at(b.published) - at(a.published));
}

function timeAgo(published: string): string {
  const ms = Date.parse(String(published || ''));
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export default function DiseaseOutbreaksPanel({ data, onLocate }: DiseaseOutbreaksPanelProps) {
  const [expanded, setExpanded] = useState(true);

  const supplied = (data as { disease_outbreaks?: BulletinRow[] } | null | undefined)?.disease_outbreaks;
  const outbreaks = newestFirst(Array.isArray(supplied) ? supplied : []);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.5, duration: 0.6 }}
      className="glass-panel flex flex-col overflow-hidden pointer-events-auto"
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex items-center justify-between px-4 py-3 hover:bg-[var(--hover-accent)] transition-colors"
      >
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
          <span className="hud-text text-[11px] text-[var(--text-primary)]">DISEASE OUTBREAKS</span>
          <span
            className="gotham-tag gotham-tag--info"
            style={{ fontSize: '9px', padding: '1px 5px' }}
            title="WHO Disease Outbreak News bulletins in the current feed"
          >
            {outbreaks.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--alert-green)] animate-osiris-pulse" />
          {expanded ? (
            <ChevronUp className="w-3 h-3 text-[var(--text-muted)]" />
          ) : (
            <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />
          )}
        </div>
      </button>

      {/* Bulletins */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="max-h-[380px] overflow-y-auto styled-scrollbar divide-y divide-[var(--border-secondary)]">
              {outbreaks.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <span className="text-[10px] font-mono text-[var(--text-muted)] tracking-widest">
                    No active WHO disease outbreak bulletins returned.
                  </span>
                </div>
              ) : (
                outbreaks.slice(0, 20).map((item: BulletinRow) => {
                  const lat = typeof item.lat === 'number' ? item.lat : null;
                  const lng = typeof item.lng === 'number' ? item.lng : null;
                  const flyable = lat !== null && lng !== null;
                  const fly = flyable && onLocate ? () => onLocate(lat, lng) : undefined;
                  return (
                    <div
                      key={item.id || item.url || item.title}
                      role={flyable ? 'button' : undefined}
                      tabIndex={flyable ? 0 : undefined}
                      title={flyable ? `Fly to ${item.country?.name ?? 'country'} centroid — approximate country anchor, not the outbreak site` : undefined}
                      onClick={fly}
                      onKeyDown={
                        flyable
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                fly?.();
                              }
                            }
                          : undefined
                      }
                      className={`px-4 py-2.5 transition-colors ${
                        flyable ? 'cursor-pointer hover:bg-[var(--hover-accent)]' : ''
                      }`}
                    >
                      {/* Title → WHO item */}
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="flex items-start gap-1.5 text-[10px] text-[var(--text-primary)] leading-tight hover:text-[var(--cyan-primary)] transition-colors"
                      >
                        <span className="line-clamp-2">{item.title}</span>
                        <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 mt-0.5 opacity-60" />
                      </a>

                      {/* Country + age */}
                      <div className="mt-1 flex items-center gap-1.5 text-[9px] font-mono text-[var(--text-muted)]">
                        {item.country?.name && (
                          <span className="text-[var(--text-secondary)]">{item.country.name}</span>
                        )}
                        {flyable && <MapPin className="w-2.5 h-2.5 text-[var(--cyan-primary)]" />}
                        <span className="ml-auto tracking-wider">{timeAgo(item.published ?? '')}</span>
                      </div>

                      {/* Two-line summary */}
                      {item.summary && (
                        <p className="mt-1 text-[10px] text-[var(--text-secondary)] leading-snug line-clamp-2">
                          {item.summary}
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Attribution */}
      <div className="px-4 py-1.5 border-t border-[var(--border-secondary)]">
        <span className="text-[9px] font-mono tracking-wider text-[var(--text-muted)]">
          WHO Disease Outbreak News · public feed
        </span>
      </div>
    </motion.div>
  );
}
