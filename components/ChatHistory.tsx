import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage as ChatMessageType, ChatDomain, ChatDossierRef } from '../types';
import { ChatMessage } from './ChatMessage';

interface ChatHistoryProps {
  messages: ChatMessageType[];
  isLoading: boolean;
  loadingMessage: string;
  conversationKey?: string;
  domain?: ChatDomain;
  onSuggestion?: (prompt: string) => void;
  /** The "Build a dossier" starter opens Scout rather than sending a chat message. */
  onOpenScout?: () => void;
  onScoutName?: (name: string) => void;
  onOpenDossier?: (dossier: ChatDossierRef) => void;
  onRetry?: (messageId: string) => void;
}

const STARTER_PROMPTS: Record<ChatDomain, { icon: string; label: string; prompt: string }[]> = {
  default: [
    { icon: 'person_search', label: 'Build a dossier', prompt: 'Open Scout to rate any player' },
    { icon: 'compare_arrows', label: 'Compare players', prompt: 'Compare Pedri and Vitinha as deep playmakers' },
    { icon: 'travel_explore', label: 'Scout a shortlist', prompt: 'Best U21 centre-backs in Serie A right now' },
    { icon: 'strategy', label: 'Tactical read', prompt: "Break down Arsenal's build-up shape this season" },
  ],
  gaffa: [
    { icon: 'gavel', label: 'Rules check', prompt: 'How do auto-subs and out-of-position penalties work?' },
    { icon: 'groups', label: 'Lineup audit', prompt: 'Audit my starting XI and bench cover' },
    { icon: 'swap_horiz', label: 'Trade sense-check', prompt: 'What makes a trade worth taking in Gaffa?' },
    { icon: 'payments', label: 'Auction math', prompt: 'How should I size a bid in a live auction?' },
  ],
};

/** Distance from the bottom (px) within which scrolling back down re-pins the view to the latest message. */
const PIN_THRESHOLD = 120;
/** How long (ms) after the last growth the output still counts as live for the jump button. */
const LIVE_IDLE_MS = 900;

export const ChatHistory: React.FC<ChatHistoryProps> = ({
  messages,
  isLoading,
  loadingMessage,
  conversationKey,
  domain = 'default',
  onSuggestion,
  onOpenScout,
  onScoutName,
  onOpenDossier,
  onRetry,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  const liveTimerRef = useRef<number | undefined>(undefined);
  const [showJump, setShowJump] = useState(false);
  const [isGrowing, setIsGrowing] = useState(false);

  // Scroll the container itself: scrollIntoView also scrolls ancestors, which shifts the whole page on iOS.
  const scrollToEnd = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const unpin = () => {
    const el = scrollRef.current;
    // A conversation that still fits on screen has nothing to scroll back to.
    if (!el || el.scrollHeight <= el.clientHeight + 2) return;
    pinnedRef.current = false;
    setShowJump(true);
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const movedUp = el.scrollTop < lastScrollTopRef.current - 1;
    lastScrollTopRef.current = el.scrollTop;
    // Content shrinking clamps scrollTop upward too, so sitting at the very bottom always counts as pinned.
    if (distance <= 2) pinnedRef.current = true;
    else if (movedUp) pinnedRef.current = false;
    else if (distance < PIN_THRESHOLD) pinnedRef.current = true;
    setShowJump(!pinnedRef.current);
  };

  // Unpin on the gesture itself, before its scroll event lands, so a growth tick can't snap the reader back down.
  const handleWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) unpin();
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    const y = e.touches[0]?.clientY;
    if (y === undefined) return;
    if (lastTouchYRef.current !== null && y > lastTouchYRef.current + 2) unpin();
    lastTouchYRef.current = y;
  };
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) unpin();
  };

  // Streaming chunks, the typewriter and late-mounting cards all grow the content outside the messages prop,
  // so follow the rendered height rather than state changes.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let lastHeight = content.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = content.offsetHeight;
      const grew = height > lastHeight;
      lastHeight = height;
      if (!grew) return;
      if (pinnedRef.current) {
        scrollToEnd('auto');
        return;
      }
      setShowJump(true);
      setIsGrowing(true);
      window.clearTimeout(liveTimerRef.current);
      liveTimerRef.current = window.setTimeout(() => setIsGrowing(false), LIVE_IDLE_MS);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      window.clearTimeout(liveTimerRef.current);
    };
  }, [scrollToEnd]);

  // A freshly opened conversation always starts at the latest message.
  useEffect(() => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollToEnd('auto');
  }, [conversationKey, scrollToEnd]);

  // A message the user just sent always re-pins the view, even if they had scrolled up to reread.
  useEffect(() => {
    if (messages[messages.length - 1]?.sender !== 'user') return;
    pinnedRef.current = true;
    setShowJump(false);
    scrollToEnd('smooth');
  }, [messages, scrollToEnd]);

  const jumpToLatest = () => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollToEnd();
  };

  const isLive = isLoading || isGrowing;

  const lastUserIndex = messages.reduce((acc, m, i) => (m.sender === 'user' ? i : acc), -1);

  return (
    <div className="flex-1 relative min-h-0">
      <div
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={handleWheel}
          onTouchStart={(e) => { lastTouchYRef.current = e.touches[0]?.clientY ?? null; }}
          onTouchMove={handleTouchMove}
          onKeyDown={handleKeyDown}
          className="h-full overflow-y-auto overscroll-contain pb-6 sm:pb-16"
          id="chat-container"
          style={{ overflowAnchor: 'none' }}
      >
        <div ref={contentRef} className="max-w-[800px] w-full mx-auto flex flex-col gap-1 sm:gap-2 px-4 sm:px-6 pt-4 sm:pt-10">

          {messages.length === 0 && (
              <div
                  key={conversationKey || 'empty'}
                  className="new-chat-stage flex flex-col items-center justify-center min-h-[50vh] py-8 select-none"
              >
                  <div className="new-chat-crest size-16 rounded-full border-2 border-charcoal/15 dark:border-cream-400/15 flex items-center justify-center mb-4">
                       <span className="font-serif italic text-4xl text-charcoal/25 dark:text-cream-400/25 font-bold">F</span>
                  </div>
                  <p className="new-chat-caption font-serif italic text-lg text-charcoal/35 dark:text-cream-400/40">Awaiting Query...</p>

                  {onSuggestion && (
                    <div className="new-chat-caption mt-8 grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-[560px]">
                      {STARTER_PROMPTS[domain].map((s) => (
                        <button
                          key={s.prompt}
                          type="button"
                          onClick={() => (s.label === 'Build a dossier' && onOpenScout ? onOpenScout() : onSuggestion(s.prompt))}
                          disabled={isLoading}
                          className="btn-new-chat text-left flex items-start gap-3 px-4 py-3 border border-charcoal/10 dark:border-cream-400/15 bg-cream-50/60 dark:bg-charcoal-surface/60 hover:border-charcoal/30 dark:hover:border-cream-400/35 disabled:opacity-40 select-text"
                        >
                          <span className="material-symbols-outlined text-[20px] text-emerald-600 dark:text-emerald-400 mt-0.5">{s.icon}</span>
                          <span className="min-w-0">
                            <span className="block text-[10px] font-sans font-bold uppercase tracking-widest text-charcoal/50 dark:text-cream-400/60">{s.label}</span>
                            <span className="block font-serif italic text-[15px] leading-snug text-charcoal/85 dark:text-cream-100/85">{s.prompt}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
              </div>
          )}

          {messages.map((msg, i) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              onOpenDossier={onOpenDossier}
              onScoutName={onScoutName}
              // Only the latest failure is retryable; older ones would replay stale context.
              onRetry={onRetry && !isLoading && i > lastUserIndex ? onRetry : undefined}
            />
          ))}

          {isLoading && (
               <div className="w-full flex gap-3 sm:gap-6 py-4 sm:py-6 border-b border-cream-300/30 dark:border-charcoal-border/30" aria-live="polite">
                   <div className="size-8 sm:size-10 rounded-full bg-charcoal dark:bg-cream-400 text-cream-50 dark:text-charcoal flex items-center justify-center shrink-0 mt-1 shadow-md animate-pulse">
                      <span className="font-serif font-bold italic text-lg sm:text-xl">F</span>
                  </div>
                  <div className="flex flex-col gap-1.5 flex-1 justify-center min-w-0">
                      <div className="flex items-center gap-2">
                          <span className="text-[10px] font-sans font-bold text-charcoal/60 dark:text-cream-400 uppercase tracking-widest">
                              Analyst Thinking
                          </span>
                          {/* Three bouncing progress dots */}
                          <div className="flex items-center gap-1 ml-1 h-3">
                              <span className="size-1.5 rounded-full bg-charcoal/60 dark:bg-cream-400/60 animate-bounce" style={{ animationDelay: '0ms' }}></span>
                              <span className="size-1.5 rounded-full bg-charcoal/60 dark:bg-cream-400/60 animate-bounce" style={{ animationDelay: '150ms' }}></span>
                              <span className="size-1.5 rounded-full bg-charcoal/60 dark:bg-cream-400/60 animate-bounce" style={{ animationDelay: '300ms' }}></span>
                          </div>
                      </div>
                      <div className="flex items-center">
                          <span className="text-sm font-serif italic text-charcoal/70 dark:text-cream-100/70 truncate">
                              {loadingMessage}
                          </span>
                      </div>
                  </div>
              </div>
          )}

          <div className="h-4" />
        </div>
      </div>

      {showJump && messages.length > 0 && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label={isLive ? 'Jump to live output' : 'Jump to latest message'}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 min-h-9 px-3.5 rounded-full bg-charcoal dark:bg-cream-200 text-cream-50 dark:text-charcoal shadow-float dark:shadow-dark-float text-[11px] font-sans font-bold uppercase tracking-widest animate-fade-in"
        >
          {isLive ? (
            <span className="relative flex size-2 mr-0.5" aria-hidden="true">
              <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
          ) : null}
          <span className="material-symbols-outlined text-[18px]">arrow_downward</span>
          {isLive ? 'Live' : 'Latest'}
        </button>
      )}
    </div>
  );
};
