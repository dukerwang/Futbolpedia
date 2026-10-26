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
  onOpenDossier?: (dossier: ChatDossierRef) => void;
  onRetry?: (messageId: string) => void;
}

const STARTER_PROMPTS: Record<ChatDomain, { icon: string; label: string; prompt: string }[]> = {
  default: [
    { icon: 'badge', label: 'Build a dossier', prompt: 'Profile Florian Wirtz' },
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

/** Distance from the bottom (px) within which new content keeps the view pinned to the latest message. */
const PIN_THRESHOLD = 120;

export const ChatHistory: React.FC<ChatHistoryProps> = ({
  messages,
  isLoading,
  loadingMessage,
  conversationKey,
  domain = 'default',
  onSuggestion,
  onOpenDossier,
  onRetry,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  // Scroll the container itself: scrollIntoView also scrolls ancestors, which shifts the whole page on iOS.
  const scrollToEnd = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance < PIN_THRESHOLD;
    setShowJump(distance > PIN_THRESHOLD * 2);
  };

  // A freshly opened conversation always starts at the latest message.
  useEffect(() => {
    pinnedRef.current = true;
    scrollToEnd('auto');
  }, [conversationKey, scrollToEnd]);

  // Follow streaming output only while the reader is already at the bottom, so scrolling up to reread isn't hijacked.
  // A message the user just sent always re-pins the view.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.sender === 'user') pinnedRef.current = true;
    if (pinnedRef.current) scrollToEnd(last?.sender === 'user' ? 'smooth' : 'auto');
  }, [messages, isLoading, scrollToEnd]);

  const lastUserIndex = messages.reduce((acc, m, i) => (m.sender === 'user' ? i : acc), -1);

  return (
    <div className="flex-1 relative min-h-0">
      <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto overscroll-contain pb-6 sm:pb-16"
          id="chat-container"
          style={{ overflowAnchor: 'none' }}
      >
        <div className="max-w-[800px] w-full mx-auto flex flex-col gap-1 sm:gap-2 px-4 sm:px-6 pt-4 sm:pt-10">

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
                          onClick={() => onSuggestion(s.prompt)}
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

      {showJump && (
        <button
          type="button"
          onClick={() => {
            pinnedRef.current = true;
            scrollToEnd();
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 min-h-9 px-3.5 rounded-full bg-charcoal dark:bg-cream-200 text-cream-50 dark:text-charcoal shadow-float dark:shadow-dark-float text-[11px] font-sans font-bold uppercase tracking-widest animate-fade-in"
        >
          <span className="material-symbols-outlined text-[18px]">arrow_downward</span>
          Latest
        </button>
      )}
    </div>
  );
};
