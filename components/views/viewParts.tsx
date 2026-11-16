import React, { useState } from 'react';
import { pillClass, type PillTone } from '../pills';
import { clubKey } from './viewData';

/** Small pieces the views share. Pure: nothing here reads a service. */

/** "2013-14" and "2013/14" as "2013–14", the way the card pills write a season. */
export const formatWindow = (text: string): string => text.replace(/(\d{4})\s*[-/–]\s*(\d{2,4})/g, '$1–$2');

/**
 * A card's `version.label` ("Current Form (Nov 2026)", "Prime Zenith (2003-06)", "Season (2015-16)",
 * "PSG era (2017-20)") as the same pill the card header wears: its tone and a short text.
 */
export function versionPillOf(label: string | undefined | null): { tone: PillTone; text: string } | null {
  const raw = label?.trim();
  if (!raw) return null;
  const match = raw.match(/^(.*?)\s*\((.*)\)\s*$/);
  const name = (match ? match[1] : raw).trim();
  const window = match ? formatWindow(match[2].trim()) : '';
  const join = (head: string) => (window ? `${head} · ${window}` : head);
  if (/^current\b/i.test(name)) return { tone: 'emerald', text: join('Current') };
  if (/^prime\b/i.test(name)) return { tone: 'amber', text: join('Prime') };
  if (/^season\b/i.test(name)) return { tone: 'amber', text: join('Season') };
  if (/\bera\b/i.test(name)) return { tone: 'blue', text: join(name) };
  return { tone: 'neutral', text: join(name) };
}

export const VersionPill: React.FC<{ label: string | undefined | null }> = ({ label }) => {
  const pill = versionPillOf(label);
  if (!pill) return null;
  return <span className={pillClass(pill.tone, 'xs')}>{pill.text}</span>;
};

export { clubKey };

/** A signed number in the table's style: "+12", "−3", "0"; "–" when the feed left it out. */
export const signed = (n: number | null): string => (n === null ? '–' : n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

export const plain = (n: number | null): string => (n === null ? '–' : String(n));

/**
 * The Scout action on a player nobody has rated: one tap queues him, the same way a Scout offer
 * does. The label settles to "On the desk" and the button stops taking taps.
 */
export const ScoutAction: React.FC<{ name: string; onScoutName?: (name: string) => void }> = ({ name, onScoutName }) => {
  const [sent, setSent] = useState(false);
  if (!onScoutName) return <span className="shrink-0 text-[11px] font-sans text-charcoal/45 dark:text-cream-400/55">No card</span>;
  return (
    <button
      type="button"
      disabled={sent}
      aria-label={sent ? `${name} is on the Scout desk` : `Scout ${name}`}
      onClick={() => {
        setSent(true);
        onScoutName(name);
      }}
      className="group/scout shrink-0 inline-flex items-center gap-1 min-h-9 pl-2 pr-1 -mr-1 text-[11px] font-sans font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400 disabled:text-charcoal/45 dark:disabled:text-cream-400/55"
    >
      {sent ? 'On the desk' : 'Scout'}
      <span
        aria-hidden="true"
        className="material-symbols-outlined text-[16px] leading-none transition-transform duration-150 ease-out group-enabled/scout:group-hover/scout:translate-x-0.5"
      >
        {sent ? 'check' : 'arrow_forward'}
      </span>
    </button>
  );
};
