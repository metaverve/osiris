'use client';

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Radar, ChevronDown, ChevronUp, Crosshair } from 'lucide-react';
import { computeConvergence, type ConvergenceCell, type ConvergenceType } from '@/lib/convergence';

/* ═══════════════════════════════════════════════════════════════
   OSIRIS — Flashpoints
   Cross-domain convergence: which one-degree cells have three or
   more different feeds reporting inside them today. A heuristic
   sorting order for attention, not a forecast.
   ═══════════════════════════════════════════════════════════════ */

interface ConvergencePanelProps {
  data: unknown;
  onLocate: (lat: number, lng: number, label?: string) => void;
}

const TYPE_LABEL: Record<ConvergenceType, string> = {
  earthquake: 'QUAKE',
  fire: 'FIRE',
  weather: 'WX',
  news: 'NEWS',
  conflict: 'CONFLICT',
  cyber: 'CYBER',
};

const TYPE_COLOR: Record<ConvergenceType, string> = {
  earthquake: 'var(--gold-primary)',
  fire: 'var(--alert-orange)',
  weather: 'var(--cyan-primary)',
  news: 'var(--text-secondary)',
  conflict: 'var(--alert-red)',
  cyber: 'var(--alert-green)',
};

const LEVEL_TAG: Record<ConvergenceCell['level'], string> = {
  CRITICAL: 'gotham-tag--critical',
  HIGH: 'gotham-tag--high',
  WATCH: 'gotham-tag--medium',
};

const LEVEL_COLOR: Record<ConvergenceCell['level'], string> = {
  CRITICAL: 'var(--alert-red)',
  HIGH: 'var(--alert-orange)',
  WATCH: 'var(--gold-primary)',
};

export default function ConvergencePanel({ data, onLocate }: ConvergencePanelProps) {
  const [expanded, setExpanded] = useState(true);
  const report = useMemo(() => computeConvergence(data), [data]);
  const cells = report.cells;
  const alertCells = cells.filter(cell => cell.level !== 'WATCH').length;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.25, duration: 0.5 }}
      className="glass-panel flex flex-col overflow-hidden pointer-events-auto"
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 hover:bg-[var(--hover-accent)] transition-colors"
        aria-expanded={expanded}
        aria-label="Flashpoints — cross-domain convergence"
      >
        <div className="flex items-center gap-2">
          <Radar className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
          <span className="hud-text text-[11px] text-[var(--text-primary)]">FLASHPOINTS</span>
          {alertCells > 0 && (
            <span
              className="gotham-tag gotham-tag--critical"
              style={{ fontSize: '9px', padding: '1px 5px' }}
              title={`${alertCells} cells at HIGH or CRITICAL convergence`}
            >
              {alertCells}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-[var(--text-muted)] tracking-widest">
            {report.considered} OBS
          </span>
          {expanded
            ? <ChevronUp className="w-3 h-3 text-[var(--text-muted)]" />
            : <ChevronDown className="w-3 h-3 text-[var(--text-muted)]" />}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="max-h-[420px] overflow-y-auto styled-scrollbar divide-y divide-[var(--border-secondary)]">
              {cells.length === 0 ? (
                <div className="px-4 py-6 text-center">
                  <span className="text-[10px] font-mono text-[var(--text-muted)] tracking-widest leading-relaxed">
                    NO CELL WHERE 3+ EVENT TYPES CO-OCCUR IN 24H
                  </span>
                </div>
              ) : (
                cells.map(cell => (
                  <button
                    key={cell.id}
                    type="button"
                    onClick={() => onLocate(cell.lat, cell.lng, `Flashpoint ${cell.id}`)}
                    className="w-full px-4 py-2.5 text-left hover:bg-[var(--hover-accent)] transition-colors"
                    title="Fly to this cell"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="text-[13px] font-mono font-bold leading-none"
                        style={{ color: LEVEL_COLOR[cell.level] }}
                      >
                        {cell.score}
                      </span>
                      <span className={`gotham-tag ${LEVEL_TAG[cell.level]}`} style={{ fontSize: '9px', padding: '1px 4px' }}>
                        {cell.level}
                      </span>
                      <span className="text-[9px] font-mono text-[var(--text-muted)]">
                        {cell.lat.toFixed(1)}, {cell.lng.toFixed(1)}
                      </span>
                      <span className="ml-auto flex items-center gap-1">
                        <Crosshair className="w-2.5 h-2.5 text-[var(--text-muted)]" />
                        <span className="text-[9px] font-mono text-[var(--text-muted)]">
                          {cell.eventCount} EVT
                        </span>
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      {cell.types.map(entry => (
                        <span
                          key={entry.type}
                          className="inline-flex items-center gap-1 rounded border border-[var(--border-secondary)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[9px] font-mono tracking-wider"
                          style={{ color: TYPE_COLOR[entry.type] }}
                        >
                          {TYPE_LABEL[entry.type]}
                          <span className="font-bold">{entry.count}</span>
                        </span>
                      ))}
                    </div>

                    {cell.sample[0]?.label && (
                      <div className="mt-1 text-[9px] font-mono text-[var(--text-muted)] line-clamp-1">
                        {cell.sample[0].label}
                      </div>
                    )}
                  </button>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="border-t border-[var(--border-secondary)] px-4 py-2 text-[9px] font-mono tracking-wider text-[var(--text-muted)]">
        1° cells · 24h window · heuristic, not a forecast
      </div>
    </motion.div>
  );
}
