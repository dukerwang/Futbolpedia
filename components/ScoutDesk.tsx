import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerProfile, RatingRequest } from '../types';
import { fetchCardIndex, getCardKey } from '../services/dossierStore';
import { searchPlayers } from '../services/playerSearch';
import { getShortTierLabel } from '../constants/ratingTiers';
import { PlayerPicker, cardRows, type PickerRow } from './PlayerPicker';
import { describeCardEdition, pillClass } from './pills';

/** A rating the Scout desk is working on. Finished ratings leave the queue for your dossiers. */
export interface ScoutJob {
  id: string;
  request: RatingRequest;
  status: 'queued' | 'running' | 'error';
  /** What the pipeline is doing now ("Verifying ... live club"). */
  stage?: string;
  startedAt?: number;
  error?: string;
}

/** Names typed or pasted into the Scout field: one per comma, semicolon or line. */
const namesIn = (text: string): string[] =>
  [...new Set(text.split(/[,;\n]+/).map((n) => n.trim().replace(/\s+/g, ' ')).filter((n) => n.length >= 2))].slice(0, 10);

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

interface ScoutDeskProps {
  jobs: ScoutJob[];
  dossiers: PlayerProfile[];
  /** Card keys rated in this session, newest first, so they can be marked as just landed. */
  freshKeys: string[];
  onScout: (requests: RatingRequest[]) => void;
  onOpenCard: (profile: PlayerProfile) => void;
  onAsk: (profile: PlayerProfile) => void;
  onRetry: (jobId: string) => void;
  onDismiss: (jobId: string) => void;
  onOpenHub: () => void;
  onClose: () => void;
  /** A new value focuses the field (the panel was opened to scout). */
  focusToken: number;
}

export const ScoutDesk: React.FC<ScoutDeskProps> = ({
  jobs,
  dossiers,
  freshKeys,
  onScout,
  onOpenCard,
  onAsk,
  onRetry,
  onDismiss,
  onOpenHub,
  onClose,
  focusToken,
}) => {
  const [text, setText] = useState('');
  const [prime, setPrime] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [sharedCards, setSharedCards] = useState<PlayerProfile[]>([]);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    fetchCardIndex().then((cards) => live && setSharedCards(cards));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!focusToken) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusToken]);

  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const names = namesIn(text);
  // Suggestions only make sense for one name; a pasted list goes straight to the queue.
  const query = names.length === 1 && !/[,;\n]/.test(text) ? names[0] : '';
  const rows = useMemo<PickerRow[]>(() => {
    if (!query) return [];
    const matches = cardRows(searchPlayers(query, dossiers, sharedCards, 4));
    return [
      ...matches,
      {
        kind: 'action',
        id: 'scout-new',
        icon: 'person_search',
        label: `Scout “${query}”${prime ? ' at his prime' : ''}`,
        hint: 'New card',
      },
    ];
  }, [query, dossiers, sharedCards, prime]);

  useEffect(() => setHighlighted(null), [query]);

  const submit = () => {
    if (names.length === 0) return;
    onScout(names.map((name) => ({ name, edition: prime ? 'prime' : 'auto' })));
    setText('');
  };

  const pick = (row: PickerRow) => {
    if (row.kind === 'card') {
      onOpenCard(row.card);
      setText('');
    } else {
      submit();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (rows.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((prev) =>
        prev === null ? (step > 0 ? 0 : rows.length - 1) : (prev + step + rows.length) % rows.length,
      );
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlighted !== null && rows[highlighted]) pick(rows[highlighted]);
      else submit();
    } else if (e.key === 'Escape' && text) {
      e.preventDefault();
      setText('');
    }
  };

  const fresh = new Set(freshKeys);
  const library = useMemo(
    () =>
      [...dossiers].sort((a, b) => {
        const fa = freshKeys.indexOf(getCardKey(a));
        const fb = freshKeys.indexOf(getCardKey(b));
        if (fa !== fb) return fa === -1 ? 1 : fb === -1 ? -1 : fa - fb;
        return (b.createdAt ?? 0) - (a.createdAt ?? 0);
      }),
    [dossiers, freshKeys],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* The desk: one field that takes a name or a list */}
      <div className="px-6 sm:px-8 pt-5 md:pt-7 pb-5 border-b border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-serif font-bold text-charcoal dark:text-white leading-tight">Scout</h2>
            <p className="mt-1 font-serif italic text-[15px] text-charcoal/60 dark:text-cream-300/70 leading-snug">
              Rate any player, any era. Cards land here and follow you into chat.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Scout"
            className="p-1.5 -mr-1.5 text-charcoal/60 dark:text-cream-400 hover:text-charcoal dark:hover:text-white rounded-lg hover:bg-cream-200/60 dark:hover:bg-charcoal-light/40 transition-colors"
          >
            <span className="material-symbols-outlined text-[20px] block">close</span>
          </button>
        </div>

        <div className="relative mt-5">
          <div className="flex items-stretch border-b-2 border-charcoal dark:border-cream-300 focus-within:border-emerald-600 dark:focus-within:border-emerald-400 transition-colors">
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                // A pasted column of names arrives as one list.
                const pasted = e.clipboardData.getData('text');
                if (/\n/.test(pasted)) {
                  e.preventDefault();
                  setText((prev) => [prev, ...pasted.split('\n')].filter((s) => s.trim()).join(', '));
                }
              }}
              placeholder="Player name, or a list"
              aria-label="Players to scout"
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls="scout-suggestions"
              aria-autocomplete="list"
              aria-activedescendant={highlighted !== null ? `scout-suggestions-row-${highlighted}` : undefined}
              enterKeyHint="go"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent py-2.5 text-[19px] font-serif italic text-charcoal dark:text-cream-50 placeholder-charcoal/35 dark:placeholder-cream-400/35 outline-none"
            />
            <button
              type="button"
              onClick={submit}
              disabled={names.length === 0}
              aria-label={names.length > 1 ? `Scout ${names.length} players` : 'Scout'}
              className="shrink-0 flex items-center gap-1.5 pl-3 pr-1 text-[11px] font-sans font-bold uppercase tracking-widest text-emerald-700 dark:text-emerald-400 disabled:text-charcoal/25 dark:disabled:text-cream-400/25 transition-colors"
            >
              {names.length > 1 ? `Scout ${names.length}` : 'Scout'}
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">arrow_forward</span>
            </button>
          </div>
          {rows.length > 0 && (
            <PlayerPicker
              id="scout-suggestions"
              title="Already rated"
              placement="below"
              rows={rows}
              highlighted={highlighted}
              onHighlight={setHighlighted}
              onPick={pick}
            />
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <div role="radiogroup" aria-label="Version to rate" className="flex items-center gap-1 text-[11px] font-sans font-bold uppercase tracking-widest">
            {[
              { value: false, label: 'Current form' },
              { value: true, label: 'Prime' },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={prime === option.value}
                onClick={() => setPrime(option.value)}
                className={`px-2.5 py-1.5 rounded-full whitespace-nowrap transition-colors ${
                  prime === option.value
                    ? 'bg-charcoal text-cream-50 dark:bg-cream-200 dark:text-charcoal'
                    : 'text-charcoal/50 dark:text-cream-400/60 hover:text-charcoal dark:hover:text-cream-100'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] font-sans text-charcoal/50 dark:text-cream-400/55 sm:text-right">
            {prime ? 'His best stretch, up to three seasons' : 'Retired players get their prime'}
          </span>
        </div>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-cream-100 dark:bg-charcoal"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {jobs.length > 0 && (
          <section aria-label="Being scouted" className="px-6 sm:px-8 pt-6">
            <h3 className="text-xs font-serif font-bold text-charcoal dark:text-white uppercase tracking-[0.2em] mb-2 border-b border-cream-300 dark:border-charcoal-border pb-2 inline-block">
              On the desk
            </h3>
            <ul>
              {jobs.map((job) => (
                <li key={job.id} className="relative py-3 border-b border-cream-300/70 dark:border-charcoal-border/70 overflow-hidden">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-serif font-bold text-[17px] text-charcoal dark:text-cream-50">
                      {job.request.name}
                      {job.request.edition === 'prime' && (
                        <span className={`${pillClass('amber', 'xs')} ml-2 align-middle`}>Prime</span>
                      )}
                    </span>
                    {job.status === 'running' && job.startedAt && (
                      <span className="shrink-0 font-mono text-xs tabular-nums text-charcoal/45 dark:text-cream-400/60">
                        {elapsed(now - job.startedAt)}
                      </span>
                    )}
                  </div>
                  {job.status === 'error' ? (
                    <div className="mt-1 flex items-start justify-between gap-3">
                      <p className="text-xs font-sans text-red-700 dark:text-red-400 leading-snug">{job.error}</p>
                      <div className="shrink-0 flex items-center gap-3 text-[10px] font-sans font-bold uppercase tracking-widest">
                        <button type="button" onClick={() => onRetry(job.id)} className="text-charcoal dark:text-cream-100 hover:text-emerald-700 dark:hover:text-emerald-400">
                          Retry
                        </button>
                        <button type="button" onClick={() => onDismiss(job.id)} className="text-charcoal/45 dark:text-cream-400/60 hover:text-charcoal dark:hover:text-cream-100">
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-0.5 text-xs font-sans text-charcoal/55 dark:text-cream-400/70 truncate" aria-live="polite">
                      {job.status === 'queued' ? 'Waiting for a free scout…' : job.stage || 'Checking published cards…'}
                    </p>
                  )}
                  {job.status !== 'error' && (
                    <div aria-hidden="true" className="absolute left-0 right-0 bottom-0 h-[2px] overflow-hidden">
                      {job.status === 'running' && (
                        <div className="h-full w-2/5 bg-emerald-500 motion-safe:animate-scout-sweep motion-reduce:w-full motion-reduce:opacity-40" />
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section aria-label="Your dossiers" className="px-6 sm:px-8 pt-6 pb-10">
          <div className="flex items-baseline justify-between mb-2 border-b border-cream-300 dark:border-charcoal-border">
            <h3 className="text-xs font-serif font-bold text-charcoal dark:text-white uppercase tracking-[0.2em] pb-2">
              Your dossiers
            </h3>
            <button
              type="button"
              onClick={onOpenHub}
              className="pb-2 text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/60 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
            >
              Global hub
            </button>
          </div>

          {library.length === 0 ? (
            <div className="py-8">
              <p className="font-serif text-lg text-charcoal dark:text-cream-50 leading-snug">Your first dossier starts with a name.</p>
              <p className="mt-2 text-sm font-sans text-charcoal/60 dark:text-cream-300/70 leading-relaxed">
                Each card rates one version of a player on one all-era scale: Overall and Potential, 25 attributes, an
                archetype and a scout's summary. Type @ in chat to bring a card into the conversation.
              </p>
            </div>
          ) : (
            <ul>
              {library.map((profile) => {
                const key = getCardKey(profile);
                const edition = describeCardEdition(profile);
                const archetype = profile.playstyleAndRole?.playstyle?.archetype;
                return (
                  <li
                    key={key}
                    className={`group flex items-center gap-4 -mx-3 px-3 border-b border-cream-300/70 dark:border-charcoal-border/70 ${
                      fresh.has(key) ? 'animate-scout-landed' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenCard(profile)}
                      className="flex-1 min-w-0 flex items-center gap-4 py-3 text-left"
                    >
                      <span className="shrink-0 w-10 flex flex-col items-center">
                        <span
                          className={`font-mono font-bold text-2xl leading-none tabular-nums ${
                            profile.ratings.overall >= 90 ? 'text-emerald-600 dark:text-emerald-400' : 'text-charcoal dark:text-cream-50'
                          }`}
                        >
                          {profile.ratings.overall}
                        </span>
                        <span className="mt-1 text-[8px] font-sans font-bold uppercase tracking-wider text-charcoal/40 dark:text-cream-400/60">
                          OVR
                        </span>
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="truncate font-serif font-bold text-[17px] leading-tight text-charcoal dark:text-cream-50 group-hover:text-emerald-700 dark:group-hover:text-emerald-400 transition-colors">
                            {profile.basicInfo.name}
                          </span>
                          {fresh.has(key) && (
                            <span className="shrink-0 size-1.5 rounded-full bg-emerald-500" aria-label="Just rated" />
                          )}
                        </span>
                        <span className="block truncate font-serif italic text-sm text-emerald-700 dark:text-emerald-400">
                          {archetype || getShortTierLabel(profile.ratings.overall)}
                        </span>
                        <span className={`${pillClass(edition.tone, 'xs')} mt-1.5`}>{edition.label}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onAsk(profile)}
                      title={`Ask about ${profile.basicInfo.name} in chat`}
                      className="shrink-0 flex items-center gap-1 min-h-9 px-2 -mr-2 text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/55 dark:text-cream-400/70 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-[16px]">alternate_email</span>
                      Ask
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
};
