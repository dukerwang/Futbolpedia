import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import type { ChatDomain, PlayerProfile, RatingRequest } from '../types';
import { fetchCardIndex } from '../services/dossierStore';
import { searchPlayers } from '../services/playerSearch';
import { RatePicker, buildRateRows } from './RatePicker';
import { PILL_ICON_CLASS, pillClass } from './pills';

/** "rate <name>" typed at the start of the box, unless the words after it are about a card in play. */
const TYPED_RATE_RE = /^\s*rate\s+(?!(?:he|him|his|her|they|them|their|it|this|that|these|those)\b)(\S.*)$/i;

interface ChatInputProps {
  onSendMessage: (
    message: string,
    imageData?: string,
    domain?: ChatDomain,
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
  /** Rates a player with the Rate command. */
  onRate: (request: RatingRequest) => void;
  /** Your dossiers, suggested first. */
  localCards: PlayerProfile[];
  /** Opens the Rate command (a new value opens it again), e.g. from the keyboard shortcut. */
  openRate?: number | null;
}

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
  onRate,
  localCards,
  openRate,
}) => {
  const [message, setMessage] = useState('');
  // The Rate token at the start of the box: the text is a player's name and Enter rates him.
  const [rateMode, setRateMode] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  // Typed "rate ..." suggestions closed with Esc stay closed until the text changes.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [sharedCards, setSharedCards] = useState<PlayerProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!draft) return;
    setMessage(draft.text);
    // Wait a frame so the chat is no longer inert, then put the cursor after the draft.
    const frame = requestAnimationFrame(() => {
      const box = textareaRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(draft.text.length, draft.text.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [draft?.id]);
  const gaffaOn = domain === 'gaffa';

  const enterRateMode = useCallback(() => {
    if (gaffaOn) onDomainChange('default');
    setRateMode(true);
    setMessage((prev) => prev.match(TYPED_RATE_RE)?.[1] ?? prev);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [gaffaOn, onDomainChange]);

  useEffect(() => {
    if (openRate) enterRateMode();
  }, [openRate]);

  // Gaffa mode has no Rate command.
  useEffect(() => {
    if (gaffaOn) setRateMode(false);
  }, [gaffaOn]);

  // What the suggestions search for: the box in Rate mode, else the name after a typed "rate ".
  const typedRate = !rateMode && !gaffaOn ? message.match(TYPED_RATE_RE)?.[1] ?? null : null;
  const rateQuery = rateMode ? message : typedRate !== null && dismissedFor !== message ? typedRate : null;
  const pickerOpen = rateQuery !== null && !isLoading;

  // The shared card index loads shortly after the page does, so the first suggestions don't wait.
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

  const rows = useMemo(
    () => (pickerOpen ? buildRateRows(rateQuery!, searchPlayers(rateQuery!, localCards, sharedCards)) : []),
    [pickerOpen, rateQuery, localCards, sharedCards],
  );

  // In Rate mode the best suggestion is ready for Enter; typed suggestions wait for the arrow keys.
  useEffect(() => {
    setHighlighted(rateMode && rows.length > 0 ? 0 : null);
  }, [rateMode, rateQuery, rows.length]);

  const pickRating = (request: RatingRequest) => {
    if (isLoading) return;
    onRate(request);
    setMessage('');
    setRateMode(false);
    setHighlighted(null);
  };

  // Grow with the draft up to the CSS max-height, then scroll inside the field.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
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
    if (rateMode) {
      if (highlighted !== null && rows[highlighted]) pickRating(rows[highlighted].request);
      return;
    }
    if ((!message.trim() && !image) || isLoading) return;
    onSendMessage(message, image || undefined, domain);
    setMessage('');
    setImage(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (pickerOpen && rows.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((prev) =>
        prev === null ? (step > 0 ? 0 : rows.length - 1) : (prev + step + rows.length) % rows.length,
      );
      return;
    }
    if (e.key === 'Escape' && (rateMode || pickerOpen)) {
      e.preventDefault();
      if (rateMode) setRateMode(false);
      else setDismissedFor(message);
      return;
    }
    if (e.key === 'Backspace' && rateMode && message === '') {
      e.preventDefault();
      setRateMode(false);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && (rateMode || (pickerOpen && highlighted !== null))) {
      // Rate mode is one line: Return picks the highlighted player on touch keyboards too.
      e.preventDefault();
      if (highlighted !== null && rows[highlighted]) pickRating(rows[highlighted].request);
      return;
    }
    // On touch keyboards Return inserts a newline; the send button submits.
    const isTouch = window.matchMedia('(pointer: coarse)').matches;
    if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  };

  return (
    <div className="relative">
    {pickerOpen && (
      <RatePicker
        rows={rows}
        highlighted={highlighted}
        onHighlight={setHighlighted}
        onPick={pickRating}
        searching={searching}
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

        <div className="flex items-start">
        {rateMode && (
          <button
            type="button"
            onClick={() => setRateMode(false)}
            aria-label="Leave Rate command"
            title="Leave Rate command"
            className={`${pillClass('emerald', 'sm')} shrink-0 ml-4 sm:ml-6 mt-[18px] sm:mt-[22px] hover:bg-emerald-500/20`}
          >
            Rate
            <span aria-hidden="true" className={PILL_ICON_CLASS}>close</span>
          </button>
        )}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => {
            setMessage(rateMode ? e.target.value.replace(/\n/g, ' ') : e.target.value);
            setDismissedFor(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          enterKeyHint={rateMode ? 'go' : 'send'}
          aria-label={rateMode ? 'Player to rate' : 'Message'}
          role={pickerOpen ? 'combobox' : undefined}
          aria-expanded={pickerOpen ? rows.length > 0 : undefined}
          aria-controls={pickerOpen ? 'rate-suggestions' : undefined}
          aria-autocomplete={pickerOpen ? 'list' : undefined}
          aria-activedescendant={pickerOpen && highlighted !== null ? `rate-row-${highlighted}` : undefined}
          className={`flex-1 min-w-0 w-full bg-transparent text-charcoal dark:text-cream-50 placeholder-charcoal/40 dark:placeholder-cream-400/30 text-[17px] sm:text-[18px] font-serif italic py-4 sm:py-5 ${rateMode ? 'pl-3 pr-4 sm:pr-6' : 'px-4 sm:px-6'} border-none focus:ring-0 resize-none max-h-40 sm:max-h-48 overflow-y-auto leading-relaxed scrollbar-hide outline-none`}
          placeholder={
            isLoading
              ? loadingMessage
              : rateMode
                ? 'Player name…'
                : gaffaOn
                  ? 'Ask about rules, strategy, or a trade…'
                  : 'Inquire about player statistics...'
          }
          rows={1}
        />
        </div>

        <div className="flex items-center justify-between px-2.5 sm:px-4 pb-2.5 sm:pb-3">
          <div className="flex items-center gap-2 sm:gap-3">
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

            <button
              type="button"
              onClick={() => (rateMode ? setRateMode(false) : enterRateMode())}
              aria-pressed={rateMode}
              disabled={isLoading}
              title={`Rate a player (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}K)`}
              className={`flex items-center gap-1 h-10 sm:h-9 pl-2.5 pr-3 rounded-full border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
                rateMode
                  ? 'bg-emerald-500 border-emerald-500 text-white hover:bg-emerald-600'
                  : 'border-cream-300 dark:border-charcoal-border text-charcoal dark:text-cream-200 hover:bg-cream-200 dark:hover:bg-charcoal-light'
              }`}
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">star</span>
              <span className="text-[11px] font-sans font-bold uppercase tracking-widest">Rate</span>
            </button>
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
