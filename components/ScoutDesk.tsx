import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerProfile, RatingRequest } from '../types';
import { getCardKey } from '../services/dossierCards';
import { fetchCardIndex } from '../services/dossierCache';
import { searchPlayers } from '../services/playerSearch';
import { getShortTierLabel } from '../constants/ratingTiers';
import { PlayerPicker, cardRows, type PickerRow } from './PlayerPicker';
import { ratingRequestFromText, ratingVersionLabel, scoutRequest, type ScoutVersion } from '../services/ratingCommand';
import { EditionLabel, InkLabel } from './EditionLabel';
import { Segmented } from './hub/Segmented';
import { INK_DOT, INK_TEXT, overallText } from './hub/editionInk';

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

/** The versions Scout rates, with the hint shown beside the switch. */
const SCOUT_VERSIONS: Array<{ value: ScoutVersion; label: string; hint: string; ink: 'current' | 'prime' | 'era' | 'season' }> = [
  { value: 'current', label: 'Current', hint: 'Prime, if retired', ink: 'current' },
  { value: 'prime', label: 'Prime', hint: 'Their best three seasons', ink: 'prime' },
  { value: 'era', label: 'Era', hint: 'One chapter: a club or a spell', ink: 'era' },
  { value: 'season', label: 'Season', hint: 'One season of their career', ink: 'season' },
];

/** Scout keeps a short shelf of recent cards; the Dossiers hub holds the whole library. */
const RECENT_LIMIT = 8;

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
  /** Names to put in the field, unrated until you press Rate (a new `id` applies them again). */
  prefill?: { id: number; text: string } | null;
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
  prefill,
}) => {
  const [text, setText] = useState('');
  const [version, setVersion] = useState<ScoutVersion>('current');
  // The era or season the Era and Season options rate.
  const [detail, setDetail] = useState('');
  const [highlighted, setHighlighted] = useState<number | null>(null);
  // Suggestions show while the name field has focus, so they never cover the version switch.
  const [nameFocused, setNameFocused] = useState(false);
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

  useEffect(() => {
    if (prefill) setText(prefill.text);
  }, [prefill?.id]);

  const running = jobs.some((j) => j.status === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const names = namesIn(text);
  const requests = names.map((name) => scoutRequest(name, version, detail));
  const ready = names.length > 0 && requests.every(Boolean);
  // Suggestions only make sense for one name; a pasted list goes straight to the queue.
  const single = names.length === 1 && !/[,;\n]/.test(text) ? ratingRequestFromText(names[0], version === 'prime') : null;
  // A season, era or edition typed with the name searches the name; the label says which version.
  const query = single?.name ?? '';
  const versionLabel = requests.length === 1 && requests[0] ? ratingVersionLabel(requests[0]) : null;

  // A version typed with the name ("PSG Neymar", "Henry 2003-04") sets the switch and its field,
  // so the shortcut shows what it did.
  const typedEdition = single?.edition;
  const typedDetail = single?.edition === 'era' ? single.era : single?.edition === 'season' ? single.season : undefined;
  useEffect(() => {
    if (typedEdition === 'era' || typedEdition === 'season') {
      setVersion(typedEdition);
      setDetail(typedDetail ?? '');
    } else if (typedEdition === 'prime') {
      setVersion('prime');
    } else if (typedEdition === 'current') {
      setVersion('current');
    }
  }, [typedEdition, typedDetail]);
  const rows = useMemo<PickerRow[]>(() => {
    if (!query) return [];
    const matches = cardRows(searchPlayers(query, dossiers, sharedCards, 4));
    return [
      ...matches,
      {
        kind: 'action',
        id: 'scout-new',
        icon: 'person_search',
        label: `Scout “${query}”${versionLabel ? ` · ${versionLabel}` : ''}`,
        hint: 'New card',
      },
    ];
  }, [query, versionLabel, dossiers, sharedCards]);

  useEffect(() => setHighlighted(null), [query]);

  const submit = () => {
    if (!ready) return;
    onScout(requests.filter((r): r is RatingRequest => r !== null));
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
      // Your dossiers are newest-last, so the reversed list is most recently added first.
      dossiers
        .map((card, order) => ({ card, order }))
        .sort((a, b) => {
          const fa = freshKeys.indexOf(getCardKey(a.card));
          const fb = freshKeys.indexOf(getCardKey(b.card));
          if (fa !== fb) return fa === -1 ? 1 : fb === -1 ? -1 : fa - fb;
          return b.order - a.order;
        })
        .map(({ card }) => card)
        .slice(0, RECENT_LIMIT),
    [dossiers, freshKeys],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* The desk: one field that takes a name or a list */}
      <div className="px-6 sm:px-8 pt-5 md:pt-7 pb-5 border-b border-cream-300 dark:border-charcoal-border bg-cream-50 dark:bg-charcoal-surface">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-serif font-bold text-[30px] leading-none tracking-[-0.025em] text-charcoal dark:text-cream-50">Scout</h2>
            <p className="mt-2 text-[14px] text-charcoal/60 dark:text-cream-400 leading-snug [text-wrap:pretty]">
              Rate any player, any era. Cards land here and follow you into chat.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Scout"
            className="grid place-items-center w-9 h-9 -mr-2 rounded-full text-charcoal/50 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-50 hover:bg-charcoal/[0.05] dark:hover:bg-white/[0.06] transition-[background-color,color,transform] duration-150 active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
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
              onFocus={() => setNameFocused(true)}
              // A tap on a suggestion lands before the blur clears them.
              onBlur={() => window.setTimeout(() => setNameFocused(false), 150)}
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
              aria-expanded={nameFocused && rows.length > 0}
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
              disabled={!ready}
              aria-label={names.length > 1 ? `Scout ${names.length} players` : 'Scout'}
              className="shrink-0 self-center inline-flex items-center gap-1.5 h-8 pl-3 pr-2 rounded-lg text-[13px] font-sans font-medium bg-charcoal text-cream-50 dark:bg-cream-100 dark:text-charcoal hover:bg-charcoal/90 dark:hover:bg-white disabled:bg-charcoal/[0.06] disabled:text-charcoal/30 dark:disabled:bg-white/[0.06] dark:disabled:text-cream-400/40 transition-[background-color,color,transform] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              {names.length > 1 ? `Scout ${names.length}` : 'Scout'}
              <span aria-hidden="true" className="material-symbols-outlined text-[17px]">arrow_forward</span>
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <Segmented<ScoutVersion>
            kind="radio"
            label="Version to rate"
            value={version}
            onChange={setVersion}
            className="-ml-1"
            options={SCOUT_VERSIONS.map((o) => ({ id: o.value, label: o.label, dot: INK_DOT[o.ink], activeText: INK_TEXT[o.ink] }))}
          />
          <span className="text-[12.5px] text-charcoal/50 dark:text-cream-400/60">
            {SCOUT_VERSIONS.find((o) => o.value === version)?.hint}
          </span>
        </div>
        {(version === 'era' || version === 'season') && (
          <label className="mt-4 block">
            <span className="text-[12.5px] font-sans font-medium text-charcoal/70 dark:text-cream-300">
              {version === 'era' ? 'Which era' : 'Which season'}
            </span>
            <input
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={version === 'era' ? 'A club, or a stretch of their career' : 'e.g. 2003-04'}
              autoComplete="off"
              spellCheck={false}
              className="mt-1.5 w-full h-9 rounded-lg border border-charcoal/[0.1] dark:border-white/[0.08] bg-cream-50/80 dark:bg-white/[0.04] px-3 text-[13.5px] font-sans text-charcoal dark:text-cream-100 placeholder:text-charcoal/40 dark:placeholder:text-cream-400/50 outline-none hover:border-charcoal/20 dark:hover:border-white/15 focus:border-charcoal/30 dark:focus:border-white/25 focus:ring-4 focus:ring-charcoal/[0.04] dark:focus:ring-white/[0.04] transition-[border-color,box-shadow] duration-150"
            />
            {version === 'season' && detail.trim() && !requests[0] && names.length > 0 && (
              <span className="mt-1.5 block text-[12px] font-sans text-charcoal/55 dark:text-cream-400">
                A past season, written like 2003-04.
              </span>
            )}
          </label>
        )}
        {/* Suggestions open below the switch, so they never cover it. */}
        <div className="relative">
            {nameFocused && rows.length > 0 && (
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
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain bg-cream-100 dark:bg-charcoal"
        onPointerDownCapture={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {jobs.length > 0 && (
          <section aria-label="Being scouted" className="px-6 sm:px-8 pt-6">
            <h3 className="font-serif font-bold text-[20px] leading-none tracking-[-0.015em] text-charcoal dark:text-cream-50 pb-3 border-b border-charcoal/[0.12] dark:border-white/[0.1]">
              On the Desk
            </h3>
            <ul>
              {jobs.map((job) => (
                <li key={job.id} className="relative py-3 border-b border-charcoal/[0.06] dark:border-white/[0.05] overflow-hidden">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-serif font-bold text-[17px] text-charcoal dark:text-cream-50">
                      {job.request.name}
                      {ratingVersionLabel(job.request) && (
                        <InkLabel
                          ink={job.request.edition === 'era' ? 'era' : job.request.edition === 'current' ? 'current' : job.request.edition === 'season' ? 'season' : 'prime'}
                          name={ratingVersionLabel(job.request)!}
                          size="xs"
                          className="ml-2 align-middle"
                        />
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
                      <div className="shrink-0 flex items-center gap-3 text-[12.5px] font-sans font-medium">
                        <button type="button" onClick={() => onRetry(job.id)} className="text-charcoal dark:text-cream-100 underline decoration-charcoal/25 dark:decoration-white/25 underline-offset-[3px] hover:decoration-current">
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

        <section aria-label="Recent dossiers" className="px-6 sm:px-8 pt-6 pb-10">
          <div className="flex items-baseline justify-between mb-1 pb-3 border-b border-charcoal/[0.12] dark:border-white/[0.1]">
            <h3 className="font-serif font-bold text-[20px] leading-none tracking-[-0.015em] text-charcoal dark:text-cream-50">
              Recent
            </h3>
            {dossiers.length > 0 && (
              <button
                type="button"
                onClick={onOpenHub}
                className="group inline-flex items-center gap-1 text-[12.5px] font-sans font-medium text-charcoal/55 dark:text-cream-400/80 hover:text-charcoal dark:hover:text-cream-50 transition-colors rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                All {dossiers.length} in Dossiers
                <span aria-hidden="true" className="material-symbols-outlined text-[16px] transition-transform duration-200 ease-out-expo group-hover:translate-x-0.5">arrow_forward</span>
              </button>
            )}
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
                const archetype = profile.playstyleAndRole?.playstyle?.archetype;
                return (
                  <li
                    key={key}
                    className={`group flex items-center gap-3 -mx-3 px-3 rounded-xl transition-colors duration-150 can-hover:hover:bg-charcoal/[0.035] dark:can-hover:hover:bg-white/[0.035] ${
                      fresh.has(key) ? 'animate-scout-landed' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenCard(profile)}
                      className="flex-1 min-w-0 flex items-center gap-4 py-3.5 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                    >
                      <span
                        className={`shrink-0 w-11 text-center font-serif font-extrabold text-[30px] leading-none tracking-[-0.03em] [font-variant-numeric:lining-nums_tabular-nums] ${overallText(profile.ratings.overall)}`}
                        aria-label={`${profile.ratings.overall} overall`}
                      >
                        {profile.ratings.overall}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="truncate font-serif font-bold text-[17px] leading-tight text-charcoal dark:text-cream-50">
                            {profile.basicInfo.name}
                          </span>
                          {fresh.has(key) && (
                            <span className="shrink-0 size-1.5 rounded-full bg-emerald-500" aria-label="Just rated" />
                          )}
                        </span>
                        <span className="block truncate font-serif italic text-sm text-emerald-700 dark:text-emerald-400">
                          {archetype || getShortTierLabel(profile.ratings.overall)}
                        </span>
                        <EditionLabel profile={profile} size="xs" className="mt-1.5 max-w-full" />
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onAsk(profile)}
                      title={`Ask about ${profile.basicInfo.name} in chat`}
                      className="shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 -mr-1 rounded-lg text-[12.5px] font-sans font-medium text-charcoal/70 dark:text-cream-300 hover:text-charcoal dark:hover:text-cream-50 hover:bg-charcoal/[0.05] dark:hover:bg-white/[0.06] transition-[background-color,color,transform] duration-150 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                    >
                      <span aria-hidden="true" className="material-symbols-outlined text-[17px]">chat_bubble</span>
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
