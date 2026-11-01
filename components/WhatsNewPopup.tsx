import React, { useState, useEffect } from 'react';

interface WhatsNewPopupProps {
  onClose?: () => void;
}

/** Bump when the popup describes a new release, so everyone sees it once more. */
const SEEN_KEY = 'futbolpedia-whats-new-seen-fp3';

interface FeatureGroup {
  id: string;
  icon: string;
  title: string;
  kicker: string;
  items: Array<{ title: string; body: string }>;
}

const scoutShortcut = (): string =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';

/** Everything major since Futbolpedia 2, grouped by what you do with it. */
const featureGroups = (): FeatureGroup[] => [
  {
    id: 'ratings',
    icon: 'workspace_premium',
    title: 'One Scale, Every Era',
    kicker: 'Ratings & Cards',
    items: [
      {
        title: 'Rate any version of a player',
        body: 'A card rates one version, not a whole career: current form, his prime across his best three seasons, a named era such as a spell at one club, or a single season.',
      },
      {
        title: 'Placed against real peers',
        body: 'Every rating sits on one all-era scale and is checked against calibrated peers, and the card shows who he was better than, level with and below.',
      },
      {
        title: 'Evidence on the card',
        body: 'An A to C evidence grade says how much data a rating rests on, next to the case for rating him higher and lower.',
      },
      {
        title: 'Cards that stay fresh',
        body: 'Current-form cards are re-rated monthly with a weekly Latest Update, and managers are looked up live. Prime, era and season cards stay fixed; "rerate" a player to redo his prime.',
      },
    ],
  },
  {
    id: 'scout',
    icon: 'person_search',
    title: 'Scout & Dossiers',
    kicker: 'Rating & Library',
    items: [
      {
        title: 'Scout',
        body: `Open Scout from the header or with ${scoutShortcut()}, then type a name or paste a whole list. Players are rated in the background, two at a time, while you keep chatting.`,
      },
      {
        title: 'One shared card per player',
        body: 'Everyone argues about the same numbers. A player someone has already rated opens in under a second, whatever name you type for him.',
      },
      {
        title: 'The Global hub',
        body: 'Browse every shared card, filter by edition, position and rating, sort by the biggest risers, and jump between a player’s versions.',
      },
      {
        title: 'Your dossiers and your revisions',
        body: 'Every card you scout or open is kept on your device. Push back on a card in chat and, if the analyst agrees, you keep your revised version.',
      },
    ],
  },
  {
    id: 'chat',
    icon: 'forum',
    title: 'Chat That Knows Your Cards',
    kicker: 'Conversation',
    items: [
      {
        title: '@ mentions',
        body: 'Type @ to bring any card into the conversation. Replies quote that card’s exact numbers instead of rating the player again.',
      },
      {
        title: 'Cards in the thread',
        body: 'Ratings land in the chat as cards you can open, and every dossier has an Ask button that starts a question about it.',
      },
      {
        title: 'Smoother chats',
        body: 'Chats are titled from what you talked about, a failed reply retries in one tap, and the view follows a reply as it streams with a button to jump back down.',
      },
      {
        title: 'Live facts',
        body: 'Answers search the web as they go, so clubs, managers, form and the current season stay up to date.',
      },
    ],
  },
  {
    id: 'gaffa',
    icon: 'sports',
    title: 'Gaffa Mode',
    kicker: 'Fantasy League',
    items: [
      {
        title: 'Ask about your league',
        body: 'Switch on Gaffa in the chat box for answers drawn from the league’s own rules, kept apart from dossier chat.',
      },
      {
        title: 'Connect your club',
        body: 'Sign in and pick your club, and Gaffa reads your roster, budget, standings, matchup and lineup, plus live listings, auctions and free agents.',
      },
      {
        title: 'Decisions, scored',
        body: 'Audit your starting XI, get a scored verdict on any trade, and work out a bid ceiling before an auction.',
      },
    ],
  },
];

export const WhatsNewPopup: React.FC<WhatsNewPopupProps> = ({ onClose }) => {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(SEEN_KEY)) setIsOpen(true);
  }, []);

  const handleClose = () => {
    localStorage.setItem(SEEN_KEY, 'true');
    setIsOpen(false);
    if (onClose) {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-6 overflow-y-auto" id="whats-new-modal-container">
      {/* Backdrop with smooth blur and fade */}
      <div
        className="fixed inset-0 bg-charcoal/45 dark:bg-black/70 backdrop-blur-md transition-opacity duration-500 ease-out"
        onClick={handleClose}
        id="whats-new-backdrop"
      />

      {/* Modal Card */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="relative w-full max-w-7xl bg-cream-100 dark:bg-charcoal-surface rounded-2xl border border-cream-300 dark:border-charcoal-border shadow-dark-float dark:shadow-2xl overflow-hidden flex flex-col max-h-[90vh] md:max-h-[85vh] animate-in fade-in zoom-in-95 duration-300 z-10"
        id="whats-new-card"
      >
        {/* Header - Styled with Elegant Serif Headings */}
        <div className="relative px-6 pt-6 pb-4 md:px-8 md:pt-8 md:pb-6 border-b border-cream-300/60 dark:border-charcoal-border/50 shrink-0">
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 md:top-6 md:right-6 p-2 text-cream-800 dark:text-cream-400 hover:text-charcoal dark:hover:text-cream-100 hover:bg-cream-300/50 dark:hover:bg-charcoal-light rounded-full transition-all duration-200"
            title="Dismiss"
            aria-label="Dismiss"
            id="whats-new-close-btn"
          >
            <span className="material-symbols-outlined text-[24px] block">close</span>
          </button>

          <div className="flex items-center gap-2.5 mb-2">
            <div className="size-8 flex items-center justify-center text-emerald-500 bg-emerald-500/10 dark:bg-emerald-500/15 rounded-full">
              <span className="material-symbols-outlined text-[18px]">sports_soccer</span>
            </div>
            <span className="text-[10px] font-mono uppercase tracking-[0.25em] text-emerald-600 dark:text-emerald-400 font-bold">
              Update Briefing • v3.0
            </span>
          </div>

          <h2 id="whats-new-title" className="text-2xl md:text-4xl font-serif font-bold text-charcoal dark:text-cream-100 tracking-tight leading-tight">
            Welcome to Futbolpedia 3
          </h2>
          <p className="text-xs md:text-sm text-cream-800 dark:text-cream-400 mt-1 md:mt-2 font-sans font-light">
            Every player version rated on one all-era scale, a Scout that rates while you chat, a shared hub of cards, and a chat that argues from them.
          </p>
        </div>

        {/* Scrollable Body - Bento Grid style content */}
        <div className="flex-1 overflow-y-auto px-6 py-6 md:px-8 md:py-8 space-y-8 custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {featureGroups().map((group) => (
              <div
                key={group.id}
                className="flex flex-col space-y-4 p-5 rounded-xl bg-cream-200/50 dark:bg-charcoal/40 border border-cream-300/30 dark:border-charcoal-border/30"
                id={`feature-group-${group.id}`}
              >
                <div className="flex items-center gap-3 pb-3 border-b border-cream-300/40 dark:border-charcoal-border/40">
                  <div className="size-9 flex items-center justify-center text-emerald-500 bg-emerald-500/10 rounded-lg shrink-0">
                    <span className="material-symbols-outlined text-[20px]">{group.icon}</span>
                  </div>
                  <div>
                    <h3 className="font-serif text-lg font-bold text-charcoal dark:text-cream-100 leading-snug">{group.title}</h3>
                    <p className="text-[10px] font-mono text-cream-800 dark:text-cream-400 uppercase tracking-wider mt-0.5">{group.kicker}</p>
                  </div>
                </div>

                <div className="space-y-4">
                  {group.items.map((item) => (
                    <div key={item.title} className="flex gap-3">
                      <span className="text-emerald-500 font-serif text-sm mt-0.5 shrink-0 select-none">✦</span>
                      <div>
                        <h4 className="text-sm font-semibold text-charcoal dark:text-cream-100">{item.title}</h4>
                        <p className="text-xs text-cream-800 dark:text-cream-400 mt-1 font-light leading-relaxed">{item.body}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer / Call To Action */}
        <div className="px-6 py-5 md:px-8 md:py-6 border-t border-cream-300/60 dark:border-charcoal-border/50 bg-cream-200/40 dark:bg-charcoal/20 flex flex-col sm:flex-row items-center justify-between gap-4 shrink-0">
          <span className="text-xs font-mono text-cream-800 dark:text-cream-400 flex items-center gap-1.5 font-light">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            Press {scoutShortcut()} anywhere to open Scout
          </span>
          <button
            onClick={handleClose}
            className="w-full sm:w-auto px-6 py-3 bg-emerald-500 hover:bg-emerald-600 dark:bg-emerald-500 dark:hover:bg-emerald-600 text-white font-sans font-medium text-sm rounded-lg shadow-sm hover:shadow transition-all duration-200 flex items-center justify-center gap-2 group cursor-pointer"
            id="whats-new-cta-btn"
          >
            Start Scouting
            <span className="material-symbols-outlined text-[16px] group-hover:translate-x-0.5 transition-transform">arrow_forward</span>
          </button>
        </div>
      </div>
    </div>
  );
};
