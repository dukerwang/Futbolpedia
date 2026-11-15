import React, { useState, useEffect } from 'react';

interface WhatsNewPopupProps {
  onClose?: () => void;
}

/** Bump when the overview changes enough that everyone should see it once more. */
const SEEN_KEY = 'futbolpedia-overview-seen-v1';

interface FeatureGroup {
  id: string;
  icon: string;
  title: string;
  kicker: string;
  items: Array<{ title: string; body: string }>;
  /** Half width on large screens: the four things Futbolpedia is for. */
  wide?: boolean;
}

const scoutShortcut = (): string =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl+K';

/** What Futbolpedia is, for a fan opening it for the first time: the four big things, then the rest. */
const featureGroups = (): FeatureGroup[] => [
  {
    id: 'chat',
    icon: 'forum',
    title: 'Conversations and Debates',
    kicker: 'Chat',
    wide: true,
    items: [
      {
        title: 'Talk football properly',
        body: 'Tactics, transfers, rankings, form, who was better: ask anything and keep going. The analyst remembers the whole conversation and answers with a point of view.',
      },
      {
        title: 'Arguments that go somewhere',
        body: 'Ask who was better at their peak or who is the best ever in a position, and get the case argued point by point, the other side’s best answer, and a clear verdict.',
      },
      {
        title: 'Bring the cards in',
        body: 'Type @ to pull any player card into the chat. The analyst quotes its exact numbers, so the argument and the ratings tell the same story.',
      },
      {
        title: 'Facts in the right season',
        body: 'Past seasons and careers are checked against the record, and statistics come with their competition and seasons attached.',
      },
    ],
  },
  {
    id: 'cards',
    icon: 'workspace_premium',
    title: 'Player Cards',
    kicker: 'Ratings',
    wide: true,
    items: [
      {
        title: 'One scale for every era',
        body: "A 1970s legend and today's breakout star are rated on the same all-time scale, so comparing them finally means something.",
      },
      {
        title: 'Every version of a player',
        body: 'Rate a player’s current form, their prime, a spell at one club or a single season, each with its own card.',
      },
      {
        title: 'Ratings with receipts',
        body: 'Each card shows who the player was better than, level with and behind, what they did best, where they fell short, and how strong the evidence is.',
      },
      {
        title: 'Disagree and make your case',
        body: 'Challenge a rating in chat. Win the argument and your revised card is yours to keep.',
      },
    ],
  },
  {
    id: 'today',
    icon: 'stadium',
    title: 'Football Today',
    kicker: 'This season',
    wide: true,
    items: [
      {
        title: "This weekend's team",
        body: 'Ask about any club and get the players who are actually starting and who is out, not last season’s lineup.',
      },
      {
        title: "What's changed",
        body: 'Answers start with what is different this season: the signings, the new shape, the player who has taken over a role.',
      },
      {
        title: 'Cards that keep up',
        body: 'Current-form cards pick up each week’s news and are re-rated every month.',
      },
      {
        title: 'Nothing made up',
        body: 'Answers are built on live match data, and anything that can’t be checked is left out.',
      },
    ],
  },
  {
    id: 'gaffa',
    icon: 'sports',
    title: 'Your Gaffa Club',
    kicker: 'Fantasy',
    wide: true,
    items: [
      {
        title: 'Connect your club',
        body: 'Tap Gaffa in the chat box and allow access. Futbolpedia reads your squad, budget, table and matchup, and never changes anything.',
      },
      {
        title: 'Pick the right XI',
        body: 'Get your lineup checked against who is actually starting in the Premier League this week.',
      },
      {
        title: 'Trades and auctions',
        body: 'Get a scored verdict on any trade, and know your bid ceiling before an auction closes.',
      },
      {
        title: 'Your league’s rules',
        body: 'Answers follow your league’s own rules, and you can ask about them directly.',
      },
    ],
  },
  {
    id: 'scout',
    icon: 'person_search',
    title: 'Scout',
    kicker: 'Rate players',
    items: [
      {
        title: 'Rate a whole squad',
        body: `Open Scout from the header or with ${scoutShortcut()} and paste a list of names. Cards are rated in the background while you keep chatting.`,
      },
    ],
  },
  {
    id: 'library',
    icon: 'public',
    title: 'The Shared Library',
    kicker: 'Dossiers',
    items: [
      {
        title: 'Scouted once, there for everyone',
        body: 'Every card joins one library the whole community shares. Browse by position, rating and edition, or find the biggest risers.',
      },
    ],
  },
  {
    id: 'smarter',
    icon: 'bolt',
    title: 'Sharper Answers',
    kicker: 'Under the hood',
    items: [
      {
        title: 'A smarter analyst',
        body: 'Futbolpedia now runs on a newer, more capable model: deeper reasoning in debates, better judgment on ratings, and fewer slips on the facts.',
      },
    ],
  },
  {
    id: 'share',
    icon: 'ios_share',
    title: 'Saved and Shared',
    kicker: 'Yours to keep',
    items: [
      {
        title: 'Pick up where you left off',
        body: 'Conversations and cards are saved for you. Share a card, or a whole chat with its cards, with a link.',
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
              futbolpedia.org
            </span>
          </div>

          <h2 id="whats-new-title" className="text-2xl md:text-4xl font-serif font-bold text-charcoal dark:text-cream-100 tracking-tight leading-tight">
            Welcome to Futbolpedia
          </h2>
          <p className="text-xs md:text-sm text-cream-800 dark:text-cream-400 mt-1 md:mt-2 font-sans font-light">
            Your football analyst for every era. Talk through any question in depth, rate any player on one all-time scale, and know this weekend's team before kick-off.
          </p>
        </div>

        {/* Scrollable Body - Bento Grid style content */}
        <div className="flex-1 overflow-y-auto px-6 py-6 md:px-8 md:py-8 space-y-8 custom-scrollbar">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            {featureGroups().map((group) => (
              <div
                key={group.id}
                className={`flex flex-col space-y-4 p-5 rounded-xl bg-cream-200/50 dark:bg-charcoal/40 border ${
                  group.wide
                      ? 'md:col-span-2 border-emerald-500/30 dark:border-emerald-500/25'
                      : 'border-cream-300/30 dark:border-charcoal-border/30'
                }`}
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

                <div
                  className={
                    group.wide ? 'grid grid-cols-1 sm:grid-cols-2 gap-4' : 'space-y-4'
                  }
                >
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
            Get Started
            <span className="material-symbols-outlined text-[16px] group-hover:translate-x-0.5 transition-transform">arrow_forward</span>
          </button>
        </div>
      </div>
    </div>
  );
};
