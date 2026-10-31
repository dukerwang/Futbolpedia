import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import type { ChatDomain, PlayerProfile } from '../types';
import { fetchCardIndex, getCardKey, toBasePlayerSlug } from '../services/dossierStore';
import { searchPlayers, type PlayerMatch } from '../services/playerSearch';
import { PlayerPicker, cardRows, type PickerRow } from './PlayerPicker';
import { cardReference } from './pills';

/** A card the message names with @, by the text that names it ("@Florian Wirtz"). */
export interface Mention {
  label: string;
  card: PlayerProfile;
}

/** How a mention reads in the box: "@Florian Wirtz", or "@Prime Zinedine Zidane (1999-02)" for another version. */
export const mentionLabel = (card: PlayerProfile): string =>
  `@${card.version && card.version.type !== 'current' ? cardReference(card) : card.basicInfo.name}`;

/** The "@..." being typed just before the caret: where it starts and what follows the @. */
const activeMentionAt = (text: string, caret: number): { start: number; query: string } | null => {
  const m = text.slice(0, caret).match(/(?:^|\s)@([^@\n]{0,30})$/);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
};

/** The box's text split into plain runs and the runs to tint as mentions. */
const highlightRuns = (
  text: string,
  labels: string[],
  active: { start: number; end: number } | null,
): { text: string; mark: boolean }[] => {
  const ranges: [number, number][] = [];
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    let from = 0;
    for (let i = text.indexOf(label, from); i !== -1; i = text.indexOf(label, from)) {
      if (!ranges.some(([a, b]) => i < b && i + label.length > a)) ranges.push([i, i + label.length]);
      from = i + label.length;
    }
  }
  if (active && active.end > active.start && !ranges.some(([a, b]) => active.start < b && active.end > a)) {
    ranges.push([active.start, active.end]);
  }
  ranges.sort((x, y) => x[0] - y[0]);
  const runs: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    if (a > at) runs.push({ text: text.slice(at, a), mark: false });
    runs.push({ text: text.slice(a, b), mark: true });
    at = b;
  }
  runs.push({ text: text.slice(at), mark: false });
  return runs;
};

interface ChatInputProps {
  onSendMessage: (
    message: string,
    imageData?: string,
    domain?: ChatDomain,
    mentions?: Mention[],
  ) => void;
  isLoading: boolean;
  loadingMessage: string;
  domain: ChatDomain;
  onDomainChange: (domain: ChatDomain) => void;
  gaffaNudge?: string | null;
  onAcceptGaffaNudge?: () => void;
  onDismissGaffaNudge?: () => void;
  /** Text to put in the box, ready for the user to finish (a new `id` applies it again). */
  draft?: { id: number; text: string } | null;
  /** Your dossiers: what @ suggests first. */
  localCards: PlayerProfile[];
  /** Adds a mention of this card to the box (a new `id` adds it again), e.g. from Scout's Ask. */
  mentionRequest?: { id: number; card: PlayerProfile } | null;
  /** Opens Scout with this name, for a player @ found no dossier for. */
  onScoutName: (name: string) => void;
}

// The text box and the mention tint behind it share every metric that decides where text wraps.
const FIELD_TEXT =
  'text-[17px] sm:text-[18px] font-serif italic leading-relaxed px-4 py-4 sm:px-6 sm:py-5 whitespace-pre-wrap break-words';

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  isLoading,
  loadingMessage,
  domain,
  onDomainChange,
  gaffaNudge,
  onAcceptGaffaNudge,
  onDismissGaffaNudge,
  draft,
  localCards,
  mentionRequest,
  onScoutName,
}) => {
  const [message, setMessage] = useState('');
  const [caret, setCaret] = useState(0);
  const [image, setImage] = useState<string | null>(null);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [highlighted, setHighlighted] = useState<number | null>(0);
  // A mention list closed with Esc stays closed until the text changes.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [sharedCards, setSharedCards] = useState<PlayerProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const gaffaOn = domain === 'gaffa';

  const focusAt = (position: number) =>
    requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(position, position);
      setCaret(position);
    });

  useEffect(() => {
    if (!draft) return;
    setMessage(draft.text);
    // Wait a frame so the chat is no longer inert, then put the cursor after the draft.
    const frame = focusAt(draft.text.length);
    return () => cancelAnimationFrame(frame);
  }, [draft?.id]);

  useEffect(() => {
    if (!mentionRequest) return;
    const { card } = mentionRequest;
    const label = mentionLabel(card);
    if (gaffaOn) onDomainChange('default');
    setMentions((prev) => (prev.some((m) => m.label === label) ? prev : [...prev, { label, card }]));
    const prev = message;
    const next = prev.includes(label) ? prev : `${prev}${prev && !/\s$/.test(prev) ? ' ' : ''}${label} `;
    setMessage(next);
    // The click that asked came from another panel: take focus once that click has settled.
    const timer = setTimeout(() => focusAt(next.length), 0);
    return () => clearTimeout(timer);
  }, [mentionRequest?.id]);

  const typing = !gaffaOn ? activeMentionAt(message, caret) : null;
  // A finished mention isn't a search: its @ starts a label already picked.
  const active =
    typing && !mentions.some((m) => message.startsWith(m.label, typing.start)) ? typing : null;
  const pickerOpen = active !== null && dismissedFor !== message && !isLoading;

  // The shared card index loads shortly after the page does, so the first @ doesn't wait.
  useEffect(() => {
    const timer = setTimeout(() => void fetchCardIndex(), 2000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!pickerOpen || sharedCards.length > 0) return;
    let live = true;
    setSearching(true);
    fetchCardIndex()
      .then((cards) => live && setSharedCards(cards))
      .finally(() => live && setSearching(false));
    return () => {
      live = false;
    };
  }, [pickerOpen]);

  const rows = useMemo<PickerRow[]>(() => {
    if (!pickerOpen || !active) return [];
    const query = active.query.trim();
    if (!query) {
      // A bare @ lists your most recent dossiers.
      const recent = [...localCards].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 6);
      const matches: PlayerMatch[] = recent.map((card) => ({
        key: `${toBasePlayerSlug(card.basicInfo.name)}:${getCardKey(card)}`,
        name: card.basicInfo.name,
        club: card.basicInfo.club,
        position: card.basicInfo.position,
        cards: [card],
      }));
      return cardRows(matches);
    }
    const found = cardRows(searchPlayers(query, localCards, sharedCards, 5));
    if (found.length > 0 || query.length < 2) return found;
    return [
      { kind: 'action', id: 'scout', icon: 'person_search', label: `No dossier for “${query}” yet. Scout him`, hint: 'Scout' },
    ];
  }, [pickerOpen, active?.query, localCards, sharedCards]);

  useEffect(() => setHighlighted(rows.length > 0 ? 0 : null), [active?.query, rows.length]);

  const pick = (row: PickerRow) => {
    if (!active) return;
    const end = active.start + 1 + active.query.length;
    if (row.kind === 'action') {
      onScoutName(active.query.trim());
      const next = message.slice(0, active.start) + message.slice(end);
      setMessage(next);
      focusAt(active.start);
      return;
    }
    const label = mentionLabel(row.card);
    const next = `${message.slice(0, active.start)}${label} ${message.slice(end).replace(/^ /, '')}`;
    setMentions((prev) => (prev.some((m) => m.label === label) ? prev : [...prev, { label, card: row.card }]));
    setMessage(next);
    focusAt(active.start + label.length + 1);
  };

  // Grow with the draft up to the CSS max-height, then scroll inside the field.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
    if (mirrorRef.current) mirrorRef.current.scrollTop = el.scrollTop;
  }, [message]);

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      alert('Please upload an image file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setImage(e.target?.result as string);
    reader.readAsDataURL(file);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // Reset so picking the same file again still fires onChange.
    e.target.value = '';
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      handleFile(file);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((!message.trim() && !image) || isLoading) return;
    const named = mentions.filter((m) => message.includes(m.label));
    onSendMessage(message, image || undefined, domain, named.length > 0 ? named : undefined);
    setMessage('');
    setMentions([]);
    setImage(null);
  };

  const insertAt = () => {
    if (gaffaOn) onDomainChange('default');
    const box = textareaRef.current;
    const at = box ? box.selectionStart : message.length;
    const before = message.slice(0, at);
    const insert = `${before && !/\s$/.test(before) ? ' ' : ''}@`;
    setMessage(before + insert + message.slice(at));
    setDismissedFor(null);
    focusAt(at + insert.length);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (pickerOpen && rows.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setHighlighted((prev) =>
          prev === null ? (step > 0 ? 0 : rows.length - 1) : (prev + step + rows.length) % rows.length,
        );
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && highlighted !== null && rows[highlighted]) {
        e.preventDefault();
        pick(rows[highlighted]);
        return;
      }
    }
    if (e.key === 'Escape' && pickerOpen) {
      e.preventDefault();
      setDismissedFor(message);
      return;
    }
    // On touch keyboards Return inserts a newline; the send button submits.
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  const runs = highlightRuns(
    message,
    mentions.map((m) => m.label),
    pickerOpen && active ? { start: active.start, end: active.start + 1 + active.query.length } : null,
  );

  return (
    <div className="relative">
    {pickerOpen && (
      <PlayerPicker
        id="mention-suggestions"
        title={active?.query.trim() ? 'Dossiers' : 'Your recent dossiers'}
        placement="above"
        rows={rows}
        highlighted={highlighted}
        onHighlight={setHighlighted}
        onPick={pick}
        searching={searching}
        empty="Your dossiers show up here. Type a name to search every shared card."
      />
    )}
    <div className="relative group bg-cream-50 dark:bg-charcoal-surface rounded-none shadow-float dark:shadow-dark-float border-t-2 border-charcoal dark:border-cream-400 overflow-hidden transition-colors duration-300">
      <div className="flex flex-col relative z-10">
        {gaffaNudge && (
          <div className="px-4 pt-3 flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-1 text-sm border-b border-charcoal/10 dark:border-cream-400/10 pb-3">
            <span className="flex-1 font-serif italic text-charcoal/80 dark:text-cream-200/80 leading-snug">
              {gaffaNudge}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={onAcceptGaffaNudge}
                className="min-h-9 px-1 text-xs font-sans uppercase tracking-wide text-emerald-700 dark:text-emerald-400 hover:underline"
              >
                Switch
              </button>
              <button
                type="button"
                onClick={onDismissGaffaNudge}
                className="min-h-9 px-1 text-xs font-sans uppercase tracking-wide text-charcoal/50 dark:text-cream-400/50 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {image && (
          <div className="px-4 sm:px-6 pt-3 sm:pt-4 pb-0 flex items-center gap-3">
            <div className="relative">
              <img src={image} alt="Attachment preview" className="size-14 object-cover rounded border border-charcoal/10 dark:border-cream-100/10" />
              <button
                type="button"
                onClick={() => setImage(null)}
                aria-label="Remove image"
                className="absolute -top-2 -right-2 size-6 rounded-full bg-charcoal dark:bg-cream-200 text-cream-50 dark:text-charcoal flex items-center justify-center shadow-sm hover:bg-red-600 dark:hover:bg-red-400"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
            <span className="text-xs font-serif italic text-emerald-600 dark:text-emerald-400">Image attached</span>
          </div>
        )}

        <div className="relative">
          {/* Mentions are tinted on a copy of the text laid exactly behind the transparent box. */}
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className={`absolute inset-0 overflow-hidden pointer-events-none text-transparent ${FIELD_TEXT}`}
          >
            {runs.map((run, i) =>
              run.mark ? (
                <mark key={i} className="bg-emerald-500/15 dark:bg-emerald-400/20 text-transparent rounded-[3px] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
                  {run.text}
                </mark>
              ) : (
                <span key={i}>{run.text}</span>
              ),
            )}
            {'​'}
          </div>
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setCaret(e.target.selectionStart);
              setDismissedFor(null);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onScroll={(e) => {
              if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onKeyDown={handleKeyDown}
            onPaste={onPaste}
            enterKeyHint="send"
            aria-label="Message"
            role={pickerOpen ? 'combobox' : undefined}
            aria-expanded={pickerOpen ? rows.length > 0 : undefined}
            aria-controls={pickerOpen ? 'mention-suggestions' : undefined}
            aria-autocomplete={pickerOpen ? 'list' : undefined}
            aria-activedescendant={pickerOpen && highlighted !== null ? `mention-suggestions-row-${highlighted}` : undefined}
            className={`relative block w-full bg-transparent text-charcoal dark:text-cream-50 placeholder-charcoal/40 dark:placeholder-cream-400/30 caret-emerald-600 dark:caret-emerald-400 border-none focus:ring-0 resize-none max-h-40 sm:max-h-48 overflow-y-auto scrollbar-hide outline-none ${FIELD_TEXT}`}
            placeholder={
              isLoading
                ? loadingMessage
                : gaffaOn
                  ? 'Ask about rules, strategy, or a trade…'
                  : typeof window !== 'undefined' && window.innerWidth < 640
                    ? 'Ask, or type @ for a dossier'
                    : 'Ask anything, or type @ to bring in a dossier'
            }
            rows={1}
          />
        </div>

        <div className="flex items-center justify-between px-2.5 sm:px-4 pb-2.5 sm:pb-3">
          <div className="flex items-center gap-1 sm:gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach image"
              className="size-10 flex items-center justify-center text-cream-800 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-50 transition-colors"
              title="Attach image"
              disabled={isLoading}
            >
              <span className="material-symbols-outlined text-[20px] font-light">add_circle</span>
            </button>
            <input type="file" ref={fileInputRef} onChange={onFileChange} accept="image/*" className="hidden" />

            <button
              type="button"
              onClick={insertAt}
              aria-label="Mention a dossier"
              title="Mention a dossier (@)"
              disabled={isLoading}
              className="size-10 flex items-center justify-center text-cream-800 dark:text-cream-400 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
            >
              <span className="material-symbols-outlined text-[20px] font-light">alternate_email</span>
            </button>

            {/* Domain Toggle: Futbolpedia vs Gaffa */}
            <button
              type="button"
              role="switch"
              aria-checked={gaffaOn}
              aria-label="Gaffa fantasy mode"
              disabled={isLoading}
              className="relative flex items-center bg-cream-200 dark:bg-charcoal-light rounded-full p-1 w-24 h-10 sm:h-9 cursor-pointer border border-cream-300 dark:border-charcoal-border select-none disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => onDomainChange(gaffaOn ? 'default' : 'gaffa')}
              title={
                gaffaOn
                  ? 'Gaffa mode active — click to switch to Futbolpedia'
                  : 'Futbolpedia mode active — click to switch to Gaffa'
              }
            >
              <div
                className={`absolute top-1 bottom-1 w-[46%] bg-white dark:bg-charcoal rounded-full shadow-sm transition-all duration-300 ease-out mx-[2%] ${
                  !gaffaOn ? 'left-0' : 'left-[50%]'
                }`}
              />
              {/* Left: Futbolpedia mark */}
              <div
                className={`flex-1 flex justify-center items-center z-10 transition-colors duration-300 ${
                  !gaffaOn
                    ? 'text-charcoal dark:text-white'
                    : 'text-charcoal/40 dark:text-cream-400/40'
                }`}
              >
                <span className="material-symbols-outlined text-[18px]">sports_soccer</span>
              </div>
              {/* Right: Gaffa mark (football head + manager suit & tie) */}
              <div
                className={`flex-1 flex justify-center items-center z-10 transition-colors duration-300 ${
                  gaffaOn
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-charcoal/40 dark:text-cream-400/40'
                }`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 128 128"
                  className="size-[19px]"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="5.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="64" cy="64" r="56" />
                  <g transform="translate(35.2, 82.8) scale(0.06)">
                    <path
                      fill="currentColor"
                      stroke="none"
                      d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm200-500 54-18 16-54q-32-48-77-82.5T574-786l-54 38v56l160 112Zm-400 0 160-112v-56l-54-38q-54 17-99 51.5T210-652l16 54 54 18Zm-42 308 46-4 30-54-58-174-56-20-40 30q0 65 18 118.5T238-272Zm242 112q26 0 51-4t49-12l28-60-26-44H378l-26 44 28 60q24 8 49 12t51 4Zm-90-200h180l56-160-146-102-144 102 54 160Zm332 88q42-50 60-103.5T800-494l-40-28-56 18-58 174 30 54 46 4Z"
                    />
                  </g>
                  <path d="M 24.8 104 C 34 88, 42 82, 50 82 M 103.2 104 C 94 88, 86 82, 78 82" />
                  <path d="M 50 82 L 44 94 H 49 L 64 116 L 79 94 H 84 L 78 82" />
                  <path d="M 54 82 L 64 96 L 74 82" />
                  <path
                    fill="currentColor"
                    stroke="none"
                    d="M 61 82 H 67 L 66 90 L 67.5 106 L 64 111 L 60.5 106 L 62 90 Z"
                  />
                </svg>
              </div>
            </button>
            <span className={`hidden sm:inline text-[10px] font-sans font-bold uppercase tracking-widest ${gaffaOn ? 'text-emerald-700 dark:text-emerald-400' : 'text-charcoal/40 dark:text-cream-400/50'}`}>
              {gaffaOn ? 'Gaffa' : 'Scouting'}
            </span>
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isLoading || (!message.trim() && !image)}
            aria-label={isLoading ? 'Working' : 'Send message'}
            className="flex items-center justify-center size-11 sm:size-10 bg-charcoal dark:bg-emerald-500 text-cream-50 hover:bg-black dark:hover:bg-emerald-400 transition-all group disabled:opacity-50"
          >
            {isLoading ? (
              <div className="size-4 border-2 border-white/50 border-t-white rounded-full animate-spin" />
            ) : (
              <span className="material-symbols-outlined text-[20px] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform">
                arrow_forward
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="absolute -bottom-1 -right-1 w-3 h-3 border-r border-b border-charcoal/20 dark:border-cream-400/20" />
      <div className="absolute -bottom-1 -left-1 w-3 h-3 border-l border-b border-charcoal/20 dark:border-cream-400/20" />
    </div>
    </div>
  );
};
