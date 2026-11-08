'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, ChevronDown, ChevronUp, MapPin } from 'lucide-react';
import { computeCii, type CiiComponent, type CiiReport, type CiiRow, type CiiSnapshot } from '@/lib/cii';
import { centroidFor } from '@/lib/countryCentroids';

/* ═══════════════════════════════════════════════════════════════
   OSIRIS — Country Instability Index (CII v0.1).
   Editorial baseline (40%) + live event pressure (60%), with the
   coverage of each component shown rather than guessed: a component
   read from an absent feed renders "—", never 0.
   ═══════════════════════════════════════════════════════════════ */

const SNAPSHOT_KEY = 'osiris.cii.snapshot.v1';
const SNAPSHOT_WRITE_MS = 5 * 60_000; // at most one snapshot write per five minutes

const COMPONENTS: CiiComponent[] = ['conflict', 'unrest', 'information', 'hazards', 'cyber'];
const COMPONENT_LABEL: Record<CiiComponent, string> = {
  conflict: 'CONFLICT', unrest: 'UNREST', information: 'INFO', hazards: 'HAZARDS', cyber: 'CYBER',
};
const COMPONENT_SHORT: Record<CiiComponent, string> = {
  conflict: 'CF', unrest: 'UN', information: 'INF', hazards: 'HZ', cyber: 'CY',
};
const LEVEL_COLOR: Record<CiiRow['level'], string> = {
  CRITICAL: 'var(--alert-red)',
  HIGH: 'var(--alert-orange)',
  ELEVATED: 'var(--gold-primary)',
  NORMAL: 'var(--cyan-primary)',
  LOW: 'var(--alert-green)',
};
const LEVEL_TAG: Record<CiiRow['level'], string> = {
  CRITICAL: 'gotham-tag--critical',
  HIGH: 'gotham-tag--high',
  ELEVATED: 'gotham-tag--medium',
  NORMAL: 'gotham-tag--info',
  LOW: 'gotham-tag--low',
};

/** Snapshot reads live inside effects; never touch storage during render. */
function readSnapshot(): CiiSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CiiSnapshot> | null;
    if (!parsed || parsed.version !== 1 || typeof parsed.savedAt !== 'number' || !parsed.scores || typeof parsed.scores !== 'object') return null;
    const scores: Record<string, number> = {};
    for (const [code, value] of Object.entries(parsed.scores)) {
      if (typeof value === 'number' && Number.isFinite(value)) scores[code] = value;
    }
    return { version: 1, savedAt: parsed.savedAt, scores };
  } catch {
    return null;
  }
}

function ageLabel(ms: number): string {
  const abs = Math.abs(ms);
  if (abs < 3_600_000) return `${Math.max(1, Math.round(abs / 60_000))}m`;
  if (abs < 48 * 3_600_000) return `${Math.round(abs / 3_600_000)}h`;
  return `${Math.round(abs / 86_400_000)}d`;
}

const deltaText = (delta: number) => (delta === 0 ? '·' : `${delta > 0 ? '▲' : '▼'}${Math.abs(delta)}`);
const deltaColor = (delta: number) =>
  delta > 0 ? 'var(--alert-red)' : delta < 0 ? 'var(--alert-green)' : 'var(--text-muted)';

interface CiiPanelProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- page.tsx passes its untyped data bag
  data: any;
  onLocate?: (lat: number, lng: number) => void;
}

export default function CiiPanel({ data, onLocate }: CiiPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const [previous, setPrevious] = useState<CiiSnapshot | null>(null);
  const [now] = useState(() => Date.now());
  const lastWrite = useRef(0);

  /* Browser-only read, after mount, so SSR output is stable. */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe localStorage read
    setPrevious(readSnapshot());
  }, []);

  const report: CiiReport = useMemo(() => computeCii(data, previous, { now }), [data, previous, now]);

  /* Persist current scores so the next mount can show a delta. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const at = Date.now();
    if (at - lastWrite.current < SNAPSHOT_WRITE_MS) return;
    try {
      const scores: Record<string, number> = {};
      for (const row of report.rows) scores[row.code] = row.score;
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ version: 1, savedAt: now, scores }));
      lastWrite.current = at;
    } catch {
      /* storage blocked or full — the panel still works, deltas just restart */
    }
  }, [report, now]);

  const covered = COMPONENTS.filter(component => report.coverage[component]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.6, duration: 0.6 }}
      className="glass-panel flex flex-col overflow-hidden pointer-events-auto"
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 hover:bg-[var(--hover-accent)] transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
          <span className="hud-text text-[11px] text-[var(--text-primary)]">INSTABILITY INDEX</span>
          <span className="gotham-tag gotham-tag--classified" style={{ fontSize: '9px', padding: '1px 5px' }}>CII v0.1</span>
          <span className="gotham-tag gotham-tag--info" style={{ fontSize: '9px', padding: '1px 5px' }} title={`${covered.length} of 5 component feeds covered`}>
            {covered.length}/5
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-1.5 h-1.5 rounded-full ${covered.length > 0 ? 'bg-[var(--alert-green)] animate-osiris-pulse' : 'bg-[var(--text-muted)]'}`} />
          {expanded ? <ChevronUp className="w-3 h-3 text-[var(--text-muted)]" /> : <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
            <div className="max-h-[420px] overflow-y-auto styled-scrollbar divide-y divide-[var(--border-secondary)]">
              {report.rows.map(row => {
                const color = LEVEL_COLOR[row.level];
                const centroid = onLocate ? centroidFor(row.code) : null;
                return (
                  <button
                    key={row.code}
                    type="button"
                    disabled={!onLocate || !centroid}
                    onClick={() => { if (onLocate && centroid) onLocate(centroid[1], centroid[0]); }}
                    className={`w-full text-left px-4 py-2 transition-colors ${onLocate && centroid ? 'hover:bg-[var(--hover-accent)] cursor-pointer' : 'cursor-default'}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-mono font-bold w-6" style={{ color }}>{row.code}</span>
                      <span className="text-[10px] text-[var(--text-primary)] truncate">{row.name}</span>
                      <span className={`gotham-tag ${LEVEL_TAG[row.level]} ml-auto`} style={{ fontSize: '8px', padding: '0 4px' }}>{row.level}</span>
                      <span className="text-[11px] font-mono font-bold tabular-nums w-7 text-right" style={{ color }}>{row.score}</span>
                      {onLocate && centroid && <MapPin className="w-2.5 h-2.5 text-[var(--text-muted)]" />}
                    </div>

                    <div className="mt-1 ml-8 h-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden" title={`score ${row.score}/100 · editorial baseline ${row.baseline}`}>
                      <div className="h-full rounded-full" style={{ width: `${row.score}%`, background: color, opacity: 0.85 }} />
                    </div>

                    <div className="mt-1 ml-8 flex items-center gap-1 flex-wrap">
                      {COMPONENTS.map(component => {
                        const value = row.components[component];
                        return (
                          <span
                            key={component}
                            className="text-[8px] font-mono px-1 rounded border"
                            title={`${COMPONENT_LABEL[component]}: ${value === null ? 'no feed coverage (unknown)' : `${Math.round(value)}/100`}`}
                            style={{
                              color: value === null ? 'var(--text-muted)' : 'var(--text-secondary)',
                              borderColor: value === null ? 'var(--border-secondary)' : 'var(--border-primary)',
                            }}
                          >
                            {COMPONENT_SHORT[component]} {value === null ? '—' : Math.round(value)}
                          </span>
                        );
                      })}
                      {row.delta !== null && row.deltaAgeMs !== null && (
                        <span className="ml-auto text-[9px] font-mono tabular-nums" style={{ color: deltaColor(row.delta) }} title={`Change since a snapshot saved ${ageLabel(row.deltaAgeMs)} ago`}>
                          {deltaText(row.delta)} · {ageLabel(row.deltaAgeMs)}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="px-4 py-1.5 border-t border-[var(--border-secondary)] text-[8px] font-mono leading-relaxed text-[var(--text-muted)]">
              COVERAGE {covered.length}/5 {covered.length === 0 ? '— no live feeds; editorial baseline only' : `— ${covered.map(component => COMPONENT_LABEL[component]).join(' · ')}`}
              <br />
              SOURCES {report.sources.length > 0 ? report.sources.join(' · ') : 'none'} · &ldquo;—&rdquo; means unknown, not zero.
            </div>

            <p className="px-4 py-2 border-t border-[var(--border-secondary)] text-[8px] font-mono leading-relaxed text-[var(--text-muted)]">
              {report.disclaimer}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
