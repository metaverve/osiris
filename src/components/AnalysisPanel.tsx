'use client';

import { useState } from 'react';
import ConvergencePanel from './ConvergencePanel';
import CiiPanel from './CiiPanel';
import DiseaseOutbreaksPanel from './DiseaseOutbreaksPanel';

/**
 * Cross-source analysis, one rail button, three tabs.
 *
 * Flashpoints, the instability index and WHO outbreaks are three views of the
 * same question — what is happening, where, and how much of it agrees. They
 * live together because each answers a different part of that question, and
 * splitting them into three rail buttons would push the rail past the height
 * of a laptop screen.
 */

type Tab = 'flashpoints' | 'instability' | 'outbreaks';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'flashpoints', label: 'FLASHPOINTS' },
  { id: 'instability', label: 'INSTABILITY' },
  { id: 'outbreaks', label: 'OUTBREAKS' },
];

export default function AnalysisPanel({
  data,
  onLocate,
}: {
  data: unknown;
  onLocate: (lat: number, lng: number, label?: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('flashpoints');

  return (
    <div className="flex flex-col gap-1.5 pointer-events-auto">
      <div role="tablist" aria-label="Analysis views" className="glass-panel flex items-center gap-1 p-1">
        {TABS.map(t => {
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded px-2 py-1.5 text-[9px] font-mono font-semibold tracking-[0.16em] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-white/50 ${
                on
                  ? 'bg-[var(--gold-primary)]/15 text-[var(--gold-primary)]'
                  : 'text-[var(--text-muted)] hover:bg-white/5 hover:text-white/70'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="max-h-[68vh] overflow-y-auto styled-scrollbar">
        {tab === 'flashpoints' && <ConvergencePanel data={data} onLocate={onLocate} />}
        {tab === 'instability' && <CiiPanel data={data} onLocate={(lat, lng) => onLocate(lat, lng)} />}
        {tab === 'outbreaks' && <DiseaseOutbreaksPanel data={data} onLocate={(lat, lng) => onLocate(lat, lng)} />}
      </div>
    </div>
  );
}
